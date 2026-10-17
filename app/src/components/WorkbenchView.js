import {cesiumWorkbenchContent, prepareCesiumWorkbench, cesiumWorkbenchAdapter, rendererTitle} from "../lib/cesiumWorkbench.js";
import {cogDisplayOptions} from "../lib/cogDisplay.js";
import {AnalysisConsole} from "./AnalysisConsole.js";
import {createLocalAnalysisRuntime} from "../lib/analysisLocalRuntime.js";
import {RendererPanel} from "./RendererPanel.js";
import {createMapboxSession} from "../lib/mapboxSession.js";
import {createMapboxLoader} from "../lib/mapboxLoader.js";
import {mapboxCompatibility} from "../lib/mapboxAdapter.js";
import {prepareRendererMap, rendererStyle, sameRendererCamera} from "../lib/rendererSwitch.js";
import {FeatureHaloControls, syncFeatureHalo, clearFeatureHalo} from "../lib/featureHalo.js";
import {LayerInfo} from "./LayerInfo.js";
import {PatternLegend} from "./PatternLegend.js";
import {createPmtilesConversionDraft,pmtilesRequestIntent,pmtilesOptionsSummary,pmtilesConversionAvailability,pmtilesUnconfirmedRetry} from '../lib/pmtilesOptions.js';
import {PmtilesConversionEditor} from './PmtilesConversionEditor.js';
import {LayerFolders} from "./LayerFolders.js";
import {opacityPaint, supportsCompositeOpacity, validateOpacityMode} from "../lib/layerOpacity.js";
import {orderedRenderLayerIds} from "../lib/layerOrder.js";
import {validateMapFilter,combineMapFilters,mapFilterOptions} from "../lib/mapFilter.js";
import {validatePointClustering, pointClusteringOptions, pointClusteringIssue, pointClusterData, pointClusterParts, unclusteredPointFilter, installPointClusterCountImages} from "../lib/pointClustering.js";
import {MapFilterEditor} from "./MapFilterEditor.js";
import {LayerVersionPicker} from "./LayerVersionPicker.js";
import {whenConnected} from "../lib/whenConnected.js";
import {archiveLayerExport} from "../lib/archiveLayerExport.js";
import {archivePaintLayers} from "../lib/reviewedArchivePresentation.js";
import {LayerArchiveControl} from "./LayerArchiveControl.js";
import {matchesReviewedDisplay} from "../lib/reviewedDisplayIdentity.js";
import {readBrowserProjectFile, BROWSER_PROJECT_FILE_BYTES} from "../lib/browserProjectFile.js";
import {projectPrintLayouts} from "../lib/printLayouts.js";
import {identifyProjectFileFormat, readSavedProjectVersionFile} from "../lib/projectFileFormat.js";
import {ProjectVersionExport, savedProjectVersionFile} from "./ProjectVersionExport.js";
import {readBrowserLayerCatalog, writeBrowserLayerCatalog, clearBrowserLayerCatalog} from "../lib/browserLayerCatalogStore.js";
import {restoreBrowserCatalogLayers} from "../lib/browserCatalogRestore.js";
import {browserLayerReviewForProject} from "./BrowserLayerRegistration.js";
import {LayerStylePicker} from "./LayerStylePicker.js";
import {POINT_SYMBOLS, hasPointSymbolStyle, normalizePointSymbolStyle, pointSymbolImages, pointSymbolStyleParts, pointSymbolPreviewSvg, ensurePointSymbolAssets} from "../lib/pointSymbols.js";
import {resolveLayerStyle, referencedStylePaint, validateLayerStyleReference} from "../lib/layerStyleReference.js";
import {maplibreAdapter, workbenchRenderer, registerArchiveProtocols} from "../lib/maplibreAdapter.js";
import {openStaticMapExport} from "./StaticMapExport.js";
import {studioNavigationItems, demoNavigationItems, MANAGED_STUDIO_URL} from "./StudioNavigation.js";
import {mapServerTileUrl} from "../lib/mapServer.js";
import {imageServerTileUrl, normalizeImageServerTileUrl} from "../lib/imageServer.js";
import {installCogMapLayer} from "../lib/cogMapLayer.js";
import {CogIdentifyResult} from "./CogIdentifyResult.js";
import {ProfileLineOfSight} from "./ProfileLineOfSight.js";
import {RasterViewshed} from "./RasterViewshed.js";
import {polygon3DGeojson} from "../lib/polygon3dMeasurement.js";
import {geojsonBounds} from "../lib/mapLayers.js";
import {mapGraticule} from "../lib/mapGraticule.js";
import {installLoadedMapLayers, isCurrentPersistedLayer, persistedLayerSourceIdentity} from "../lib/loadedLayerInstallation.js";
import {PINNED_MAP_FONT, createMapFontSession, isRegisteredMapFont, validateMapFontRef} from "../lib/mapFonts.js";
import {exportGeoLibreProject, importGeoLibreProject} from "../lib/geolibreProject.js";
import {exportGeoMooseMapbook, importGeoMooseMapbook} from "../lib/geomooseMapbook.js";
import {exportWebMapContext, importWebMapContext} from "../lib/webMapContext.js";
import {fitImageOverlay, pointInImageOverlay} from "../lib/imageOverlayEditing.js";
import {mountImageOverlayEditor} from "./ImageOverlayEditor.js";
import {canClosePolygon, mapAuthoringPreview} from "../lib/mapAuthoringPreview.js";
import {mountShapeEditor} from "./ShapeEditor.js";
import {bindResizablePanels} from "./ResizablePanels.js";
import {StudioAccountControls} from "./StudioAccountControls.js";
import {directoryHref, compositionHref} from "../lib/applicationRoutes.js";
import {CameraControls} from "./CameraControls.js";
import {EsriBasemapOptions} from "./EsriBasemapOptions.js";
import {createEsriBasemapSession, esriTileConfiguration} from "../lib/esriBasemaps.js";
import {
  normalizePortalConfiguration,
  portalConfigurationForProject
} from "../lib/portalConfiguration.js";
import {
  PORTAL_CATALOG_RUNTIME_LIMITS,
  analyzePortalCatalog,
  canAddPortalCatalogLayer,
  portalCatalogSourceRegistration,
  portalLayerFromGovernedSource
} from "../lib/portalCatalog.js";
import {
  ADD_DATA_SOURCES,
  BASEMAPS,
  DEFAULT_STATUS,
  PLUGINS,
  STYLE_PALETTES
} from "../lib/workbenchConfig.js";
import {
  BROWSER_PROCESSING_LIMITS,
  PROCESSING_REGISTRY_SCHEMA_VERSION,
  PROCESSING_TOOLS,
  appendProcessingHistory,
  normalizeProcessingHistory,
  normalizeProcessingModels,
  portableProcessingHistoryEntry,
  runBrowserProcessingModel,
  runBrowserProcessingTool
} from "../lib/processingRegistry.js";
import {
  buildBasemapCatalog,
  selectableBasemap,
  unavailableBasemapMessage
} from "../lib/basemapCatalog.js";
import {
  BASEMAP_ACTIVATION_LIMITS,
  basemapActivationFailureMessage,
  basemapProbeStyle,
  basemapProbeView,
  basemapRequiresNetworkProbe
} from "../lib/basemapActivation.js";
import {
  applyBasemapGovernance,
  basemapGovernanceLabel,
  basemapGovernanceMessage,
  basemapNetworkAllowed,
  basemapReplacement
} from "../lib/basemapGovernance.js";
import {
  basemapCoverageIssues,
  basemapRuntimeErrorApplies,
  basemapRuntimeIssueBlocksActivation,
  basemapRuntimeIssueDetails,
  basemapRuntimeIssueFromError,
  basemapRuntimeMessage,
  createBasemapRuntimeHealth
} from "../lib/basemapRuntimeHealth.js";
import {customBasemapDefinition} from "../lib/basemapSource.js";
import {
  DEFAULT_STORAGE,
  normalizeStorage,
  projectObjectKey,
  projectS3Uri,
  uploadS3Uri
} from "../lib/workbenchStorage.js";
import {MANAGED_FILE_ACCEPT} from "../lib/managedUpload.js";
import {readWorkspaceUiState, writeWorkspaceUiState} from "../lib/workspaceUiState.js";
import {loadArchivedGeojson} from "../lib/archivedGeojson.js";
import {loadLiveFeaturePage} from "../lib/liveFeatureSource.js";
import {
  accessibleFeaturePopup,
  browserLoadingSummary,
  canvasJpegBlob,
  canvasPngBlob,
  createMapExportManifest,
  evaluateExtensionCapability,
  extensionPolicy,
  recordExtensionAudit,
  renderedFeatureHit
} from "../lib/browserPlatform.js";
import {
  TEMPORARY_WORK_LIMITS,
  createTemporaryAnnotation,
  createTemporaryUpload,
  editableTemporaryFeatureIndexes,
  isTemporaryLayer,
  replaceTemporaryFeatureVertex,
  restoreTemporaryWork,
  serializeTemporaryWork,
  temporaryFeatureVertices,
  temporaryWorkExpiryLabel,
  temporaryWorkStorageKey
} from "../lib/temporaryAnnotations.js";
import {
  mapDefinitionVersionForLayers,
  validateManagedDisplayReference,
  upgradeMapDefinition,
  validateRendererPreference
} from "../lib/mapDefinition.js";
import {
  PATH_MEASUREMENT_LIMITS,
  createPathMeasurement,
  formatMeasurementDistance,
  measurementSlopeSummary
} from "../lib/pathMeasurement.js";
import {
  circlePolygonCoordinates,
  circleMeasurementMetrics,
  createCircleMeasurement,
  createPolygonMeasurement,
  formatMeasurementArea,
  polygonMeasurementMetrics
} from "../lib/areaMeasurement.js";
import {
  normalizeSavedMeasurements,
  savedMeasurementGeojson
} from "../lib/savedMeasurement.js";
import {
  fixtureAdapterKind,
  projectHref
} from "../lib/applicationRoutes.js";
import {
  spatialBodyDefinition,
  spatialBodyDistanceMeters,
  spatialBodyForBasemap,
  spatialBodyForProject
} from "../lib/spatialBody.js";
import {
  applyMapProjection,
  captureMapView,
  mapViewsForSave,
  normalizeMapView,
  normalizeProjection,
  projectionForProject
} from "../lib/globeView.js";
import {
  applyOpenTerrain,
  OPEN_TERRAIN_SOURCE,
  terrainForProject,
  terrainForSave
} from "../lib/terrainView.js";
import {
  createTerrainOutageGuard,
  evaluateTerrainGovernance,
  terrainActivationDecision,
  terrainDeploymentClass,
  terrainGovernanceMessage
} from "../lib/terrainGovernance.js";
import {
  applyOpenScene3d,
  evaluateOpenScene3dGovernance,
  OPEN_3D_SCENE_LIMITS,
  OPEN_3D_SCENE_SOURCE,
  openScene3dForProject,
  openScene3dForSave
} from "../lib/openScene3d.js";
import {
  beginTerrainTiming,
  cancelTerrainTiming,
  completeTerrainTiming,
  createGlobeTelemetry,
  GLOBE_TELEMETRY_LIMITS,
  globeTelemetrySnapshot,
  recordGlobeCamera,
  recordGlobeFrame,
  recordGlobeLoad
} from "../lib/globeTelemetry.js";
import {
  globeInteractionSupport,
  globeInteractionSupportAccepted
} from "../lib/globeInteraction.js";
import {
  KML_PLACES_LIMITS,
  addKmlPlace,
  createPlacesDocument,
  exportKml,
  exportKmz,
  kmlRegionLodPresentation,
  kmlReportForProject,
  kmlReportForSave,
  moveKmlPlace,
  parseAuthoringGeometry,
  parseKml,
  parseKmlFile,
  placesForProject,
  placesForSave,
  placesToGeojson,
  removeKmlPlace,
  updateKmlPlace
} from "../lib/kmlPlaces.js";
import {
  KML_NETWORK_LINK_LIMITS,
  acceptKmlNetworkLinkReceipt,
  authorizeKmlNetworkLink,
  buildKmlNetworkLinkRequest,
  executeKmlNetworkLinkRequest,
  kmlNetworkLinkRefreshDecision,
  kmlNetworkLinkStateForProject,
  kmlNetworkLinkStateForSave,
  receiptForKmlNetworkLinkState
} from "../lib/kmlNetworkLink.js";
import {
  readSpatialInterchangeFile,
  prepareManagedSpatialFile,
  serializeSpatialInterchange
} from "../lib/spatialInterchange.js";
import {
  createSavedFeatureQueryReceipt,
  FEATURE_QUERY_LIMITS,
  parseSavedFeatureQueryReceipt,
  queryGeometryFromBoundaryFeature,
  queryGeometryFromFeatures,
  serializeFeatureQueryCsv
} from "../lib/featureQuery.js";
import {
  GOVERNED_IDENTIFY_LIMITS,
  captureManagedPreviewIdentify,
  identifyReportSummary,
  identifyUnavailableMessage,
  identifyVisibleGovernedLayers,
  isGovernedDatasetLayer,
  loadedFeatureIndex,
  visibleQueryableLayers
} from "../lib/governedIdentify.js";
import {
  graduatedColorExpression,
  graduatedLegendEntries,
  normalizeGraduatedStyle,
  numericPropertyFields
} from "../lib/thematicStyle.js";
import {
  configuredLayerIds,
  layerMoveState,
  normalizeProjectLayerOrder,
  orderedProjectLayerTree,
  reorderedLayerStack,
  restoreSavedLayerOrder
} from "../lib/layerOrder.js";
import {
  HISTORICAL_IMAGERY_LIMITS,
  fetchHistoricalAvailability,
  historicalImageryBasemap,
  historicalImageryForProject,
  historicalImageryForSave,
  historicalImagerySource,
  resolveHistoricalSelection,
  reviewedHistoricalDates,
  reviewedHistoricalImagerySources,
  WAYBACK_SOURCE_ID, fetchWaybackReleases, waybackViewerUrl,
  solarElevationAt,
  sunlightGuideGeojson
} from "../lib/historicalImagery.js";
import {
  CAMERA_TOUR_LIMITS,
  addCameraTourKeyframe,
  cameraTourDurationMilliseconds,
  cameraTourForProject,
  cameraTourForSave,
  cameraTourFrameAt,
  captureCameraTourView,
  createCameraTour,
  exportCameraTour,
  moveCameraTourKeyframe,
  parseCameraTour,
  removeCameraTourKeyframe,
  updateCameraTourKeyframe
} from "../lib/cameraTour.js";
import {
  AIRCRAFT_PROFILES,
  FLIGHT_LIMITS,
  aircraftProfile,
  createFlightSession,
  flightHud,
  keyboardFlightControls,
  mergeFlightControls,
  pauseFlight,
  resetFlight,
  resumeFlight,
  standardControllerFlightControls,
  stepFlight
} from "../lib/flightSimulation.js";

const MAXIMUM_CONCURRENT_LIVE_FEATURE_REQUESTS = 4;

export const DEFAULT_WORKBENCH_COLOR_MODE = "dark";

export function WorkbenchView(options = {}) {
  const id = options.publicDemo && !options.printFrame && !options.localProjectRecord
    ? new URLSearchParams(globalThis.location?.search ?? "").get("localProject") : null;
  if (!id) return createWorkbenchView(options);
  const root = document.createElement("section");root.className = "browser-project-restoring";
  const status = textElement("p", "Opening your saved Project…");status.setAttribute("role", "status");root.append(status);
  let disposed = false, workbench;
  let observer;
  const stopWaiting = whenConnected(root, () => {observer = observeDisconnection(root, root.dispose);});
  root.dispose = () => {disposed = true;stopWaiting();observer?.disconnect();workbench?.dispose();};
  for (const name of ["getPrintContext", "saveDraftForNavigation", "openPublicationMapExport", "releaseRendererCredentials", "resumeRenderer"]) root[name] = (...args) => workbench?.[name]?.(...args);
  void import("../lib/localProjectStore.js").then(async ({LocalProjectStore}) => {
    const record = await new LocalProjectStore({catalog: options.browserCatalog}).load(id);
    if (disposed) return;
    workbench = createWorkbenchView({...options, project: {...record.definition, title: record.title},
      layers: record.definition.layers, geojsonByLayerId: record.geojsonByLayerId,
      startBlank: false, restoreBrowserDraft: false, localProjectRecord: record, draftScopeId: `personal-${record.id}`});
    root.replaceChildren(workbench);options.onLocalProjectLoaded?.(record);
  }).catch(error => {if (!disposed) status.textContent = error.message;});
  return root;
}

function createWorkbenchView({
  workspace,
  role,
  project,
  workspaces = [],
  layers = [],
  datasets = [],
  allDatasets = datasets,
  browserCatalog = [],
  onBrowserProjectCreated = null,
  onLocalProjectLoaded = null,
  localProjectRecord = null,
  onDemoCapture = null,
  objects = [],
  allObjects = objects,
  layouts = [],
  jobs = [],
  connectionBindings = [],
  basemapConnectionBindings = [],
  storage = DEFAULT_STORAGE,
  geojsonByLayerId = new Map(),
  mapFontAttachments = null,
  rendererAdapter = maplibreAdapter,
  styleAdapter = null,
  layerArchiveAccess = null,
  saveProject = null,
  saveProjectAs = null,
  importLocalFile = null,
  registerSource = null,
  startSourceDiscovery = null,
  getSourceDiscovery = null,
  sourceDiscoveryPollIntervalMs = 750,
  sourceDiscoveryPollAttempts = 20,
  canRequestProjectCompute = null,
  estimateProtectedCopy = null,
  requestProtectedCopy = null,
  listProtectedCopies = null,
  cancelProtectedCopy = null,
  requestPmtilesDerivative = null,
  getPmtilesConversionCapabilities = null,
  listPmtilesDerivatives = null,
  cancelPmtilesDerivative = null,
  reviewPmtilesDisplay = null,
  admitPmtilesDisplay = null,
  loadManagedDatasetMetadata = null,
  protectedCopyJobs = [],
  pmtilesDerivativeJobs = [],
  refreshDurableJobs = null,
  initialDurableJobsMessage = null,
  loadDatasetFeatures = null,
  loadDatasetVersionPreview = null,
  queryDatasetFeatures = null,
  listQueryLocations = null,
  getQueryLocation = null,
  previewVectorAnalysis = null,
  cancelVectorAnalysis = null,
  createAnalysisRegistration = null,
  getAnalysisCollection = null,
  onProjectSaved = null,
  refreshKmlNetworkLink = null,
  applyGeoLibreImport = null,
  prepareGeoLibreHandoff = null,
  reviewGeoLibreReturn = null,
  resolveBasemapStyle = null,
  sources = [],
  persistenceMode = "api",
  mapVersion = null,
  savedProjectOrigin = null,
  initialPanel = null,
  initialDatasetTarget = null,
  startBlank = false,
  publicDemo = false,
  demoSurface = false,
  landingMode = false,
  printFrame = false,
  projectNavigation = null,
  projectSwitcher = null,
  draftScopeId = null,
  restoreDraftScopeId = draftScopeId,
  restoreBrowserDraft = true,
  account = null,
  canResumeRenderer = null,
  onPublicationMapExport = null,
  analysisRuntime = null
} = {}) {
  const shell = document.createElement("section");
  shell.className = "opengeo-workbench";
  shell.dataset.colorMode = DEFAULT_WORKBENCH_COLOR_MODE;

  const workingLayers = layers
    .map(cloneLayer)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const dataByLayerId = new Map(geojsonByLayerId);
  for (const layer of workingLayers) if (layer.managedDisplayId) dataByLayerId.delete(layer.layerId);
  const initialKmlPlaces = placesForProject(project);
  if (initialKmlPlaces) {
    const initialKmlLayer = workingLayers.find(({layerId}) => layerId === "kml-places")
      ?? kmlPlacesLayer(initialKmlPlaces.name);
    if (!workingLayers.includes(initialKmlLayer)) workingLayers.push(initialKmlLayer);
    initialKmlLayer.kmlDocument = initialKmlPlaces;
    initialKmlLayer.kmlInterchangeReport = kmlReportForProject(project);
    initialKmlLayer.kmlNetworkLinkState = kmlNetworkLinkStateForProject(project);
    dataByLayerId.set(initialKmlLayer.layerId, placesToGeojson(initialKmlPlaces));
  }
  replaceLayerOrder(workingLayers, normalizeProjectLayerOrder(workingLayers, project?.layerTree));
  const initialProjection = projectionForProject(project);
  const initialSpatialBody = spatialBodyForProject(project);
  const initialMeasurements = normalizeSavedMeasurements(project?.measurements, {
    spatialBody: initialSpatialBody
  });
  const initialTerrain = terrainForProject(project);
  const initialOpenScene3d = openScene3dForProject(project);
  const initialPortalConfiguration = portalConfigurationForProject(project);
  const initialHistoricalImagery = historicalImageryForProject(project);
  const initialCameraTour = cameraTourForProject(project);
  const mobileAtStart = isMobileWorkbenchViewport();

  const storedUi = publicDemo ? null : readWorkspaceUiState(workspace?.workspaceId);
  const state = {
    mapFontSession: createMapFontSession(mapFontAttachments),
    activeLayerId: project?.activeLayerId ?? workingLayers[0]?.layerId ?? null,
    activePanel: initialDatasetTarget
      ? "add"
      : ["add", "catalog", "basemap", "processing", "query", "identify", "measure", "temporary", "history", "tour", "flight", "settings", "help"].includes(initialPanel)
      ? initialPanel
      : storedUi?.activePanel ?? "style",
    activeMenu: null,
    leftPanelMode: storedUi?.leftPanelMode ?? "layers",
    activeAddSource: "vector",
    activeToolId: "count",
    activeProcessingModelId: Array.isArray(project?.models)
      && project.models.some(({id}) => id === project?.activeProcessingModelId)
      ? project.activeProcessingModelId
      : project?.models?.[0]?.id ?? null,
    processingModels: normalizeProcessingModels(project?.models),
    processingHistory: normalizeProcessingHistory(project?.processingHistory),
    processingRunSequence: 0,
    pmtilesDerivativeDraft: null,
    pmtilesDerivativeBusy: false,
    pmtilesDisplayReview: null,
    managedDatasetMetadataRequest: null,
    sourceRegistrationPending: null,
    sourceDiscoveryPending: false,
    sourceDiscoveryDrafts: {
      arcgis: {
        serviceUrl: "https://services.example.org/arcgis/rest/services/example/FeatureServer",
        catalog: null,
        inspection: null,
        selectedRef: null,
        pending: null
      },
      wfs: {
        serviceUrl: "https://maps.example.org/geoserver/wfs",
        catalog: null,
        inspection: null,
        selectedRef: null,
        pending: null
      }
    },
    durableJobsBusy: false,
    durableJobActionPending: null,
    durableJobsMessage: initialDurableJobsMessage,
    basemapOpacity: savedBasemapOpacity(project),
    currentBasemapId: visibleBasemap(project),
    customBasemaps: projectBasemapChoices(project),
    selectedBasemapConnectionBindingId: visibleProviderBinding(project)
      ?? basemapConnectionBindings.find(({connection}) => (
        connection?.status === "configured" && connection?.credentialReady
      ))?.id
      ?? basemapConnectionBindings[0]?.id
      ?? null,
    basemapResolutionBusy: false,
    basemapSwitchRevision: 0,
    basemapActivationAttempt: 0,
    basemapActivationState: "idle",
    basemapActivationCandidateId: null,
    basemapActivationCandidateTitle: null,
    basemapActivationFailureCode: null,
    basemapActivationMessage: null,
    basemapActivationRetryChoice: null,
    cancelBasemapActivationProbe: null,
    basemapRuntimeHealth: createBasemapRuntimeHealth({basemapId: visibleBasemap(project)}),
    basemapRuntimeRecoveryPending: false,
    basemapRuntimeProbeInProgress: false,
    basemapRuntimeSwitchPending: false,
    basemapRuntimeSwitchTimer: null,
    basemapRuntimeManagedSourceIds: null,
    basemapChooserOpen: false,
    basemapChooserReturnFocus: null,
    basemapSourceToolsOpen: false,
    regionalBasemapDraft: {
      title: "Regional imagery",
      url: "https://tiles.example.org/{z}/{x}/{y}.png",
      attribution: "Source and data contributors",
      license: "CC-BY-4.0",
      coverage: "-180, -85, 180, 85",
      scheme: "xyz",
      coordinateBehavior: "wgs84_web_mercator"
    },
    basemapCatalogMessage: null,
    basemapGovernanceSubjectId: null,
    historicalImagery: initialHistoricalImagery,
    historicalAvailability: reviewedHistoricalDates(initialHistoricalImagery.sourceId),
    historicalAvailabilityStatus: "reviewed-capability-receipt",
    historicalAvailabilityMessage: "Showing the last reviewed provider time-domain dates. Visible pixels can still contain gaps or clouds.",
    historicalAvailabilityBusy: false,
    historicalAvailabilityAbortController: null,
    historicalPlaybackTimer: null,
    historicalPlaybackFrames: 0,
    cameraTour: initialCameraTour,
    cameraTourSelectedId: initialCameraTour?.keyframes?.[0]?.id ?? null,
    cameraTourElapsedMilliseconds: 0,
    cameraTourPlaybackTimer: null,
    cameraTourPlaybackStartedAt: null,
    cameraTourPlaybackStartElapsedMilliseconds: 0,
    flightProfileId: "survey-trainer",
    flightStartingAglMeters: 300,
    flightHeadingDegrees: Number.isFinite(project?.mapViews?.[0]?.bearing) ? project.mapViews[0].bearing : 0,
    flightSession: null,
    flightAnimationFrameId: null,
    flightLastFrameAt: null,
    flightAccumulatorMilliseconds: 0,
    flightKeyboardKeys: new Set(),
    flightManualControls: {pitch: 0, roll: 0, yaw: 0, throttleDeltaPerSecond: 0},
    flightControllerEnabled: false,
    flightControllerIndex: null,
    flightControllerStatus: "not-enabled",
    mapControlsOpen: false,
    mobileCommandSheetOpen: false,
    mobileCommandReturnFocus: null,
    colorMode: preferredWorkbenchColorMode(),
    coordinateText: "Move over the map",
    identify: true,
    measureMode: false,
    measurementKind: "path",
    spatialBody: initialSpatialBody,
    graticule: false,
    globe: initialProjection === "globe",
    projectionFallback: false,
    terrainEnabled: initialSpatialBody.id === "earth" && initialTerrain.enabled,
    terrainExaggeration: initialTerrain.exaggeration,
    terrainFallback: false,
    terrainFallbackReason: null,
    terrainDeploymentClass: terrainDeploymentClass(),
    terrainGovernanceStatus: "unverified",
    terrainOutageGuard: createTerrainOutageGuard(),
    openScene3dEnabled: initialSpatialBody.id === "earth" && initialOpenScene3d.enabled,
    openScene3dFallback: false,
    openScene3dFallbackReason: null,
    openScene3dGovernanceStatus: "unverified",
    openScene3dOutageGuard: createTerrainOutageGuard({sourceId: OPEN_3D_SCENE_SOURCE.sourceId}),
    openScene3dBuildingFeatures: 0,
    openScene3dWoodlandFeatures: 0,
    kmlPlaces: initialKmlPlaces,
    kmlContentsOpen: false,
    kmlInterchangeReport: kmlReportForProject(project),
    kmlNetworkLinkState: kmlNetworkLinkStateForProject(project),
    kmlNetworkLinkApprovals: new Map(),
    kmlNetworkLinkDocuments: new Map(),
    kmlNetworkLinkInFlight: new Map(),
    kmlNetworkLinkTimers: new Map(),
    kmlNetworkLinkRegionActive: new Map(),
    kmlNetworkLinkRequestCount: 0,
    kmlNetworkLinkLastConditional: null,
    portalConfiguration: initialPortalConfiguration,
    portalConfigurationOpen: false,
    portalConversionReport: portalReportForProject(project),
    portalExtensions: portalExtensionForProject(project),
    selectedKmlPlaceId: null,
    primaryAuthoringKind: null,
    mapAuthoring: null,
    mapAuthoringCreatedKmlPlaces: false,
    temporaryWorkMessage: null,
    temporaryPromotionLayerId: null,
    temporaryPromotionBusy: false,
    temporaryEdit: null,
    authoringCoordinateDraft: null,
    overlayExtentDraft: null,
    globeTelemetry: createGlobeTelemetry(),
    globeTelemetryPresentedSamples: -1,
    restoredMapViews: null,
    leftOpen: mobileAtStart ? false : storedUi?.leftOpen ?? true,
    quickToolsOpen: storedUi?.quickToolsOpen ?? true,
    rightOpen: Boolean(initialDatasetTarget) || initialPanel !== null
      ? true
      : mobileAtStart ? false : storedUi?.rightOpen ?? false,
    projectTreeOpen: true,
    openLayerTreeGroupIds: initialOpenLayerTreeGroupIds(project?.layerTree),
    exampleTreeOpen: projectNavigation?.open !== false,
    openNavigationGroupIds: initialOpenNavigationGroupIds(projectNavigation?.nodes),
    filterText: "",
    queryDraft: null,
    queryResult: null,
    queryRunning: false,
    queryError: null,
    queryDrawing: null,
    querySelectionClipboard: null,
    querySelectedFeatureId: null,
    queryResultHandlersBound: false,
    queryRequestRevision: 0,
    queryAbortController: null,
    queryLocationState: null,
    savedQueryReceipts: [],
    savedQueryReceiptBusy: false,
    savedQueryReceiptError: null,
    identifyRunning: false,
    identifyRequestRevision: 0,
    identifyAbortController: null,
    identifyPendingLocation: null,
    identifyReport: null,
    statusMessage: landingMode
      ? "Local scratch map · changes and files stay in this browser"
      : publicDemo
        ? "Public demo · changes and local files stay in this browser"
      : startBlank
        ? "New unsaved map · add data to begin"
        : DEFAULT_STATUS,
    processingLog: [],
    runtimeJobs: [],
    saveAsOpen: false,
    saveAsReturnFocus: null,
    saveAsImport: null,
    preservationDialog: null,
    preservationReturnFocus: null,
    preservationReturnFocusKey: null,
    pluginState: new Set(),
    extensionAudit: [],
    mapExportState: "idle",
    styleClipboard: null,
    selectedFeatureIndex: null,
    measurements: initialMeasurements,
    selectedMeasurementId: initialMeasurements[0]?.id ?? null,
    editingMeasurementId: null,
    measurePoints: [],
    map: null,
    layerHandles: new Map(),
    archiveTileSessions: new Map(),
    resolvedLayerStyles: new Map(),
    layerStyleErrors: new Map(),
    pmtilesReady: false
  };

  if (restoreBrowserDraft && (!startBlank || landingMode)) applyLocalDraft({
    workspace,
    project,
    layers: workingLayers,
    state,
    publicDemo,
    landingMode,
    draftScopeId: restoreDraftScopeId,
    presentationOnly: restoreBrowserDraft === "presentation",
    dataByLayerId
  });
  replaceLayerOrder(workingLayers, normalizeProjectLayerOrder(workingLayers, project?.layerTree));

  const context = {
    analysisRuntime,
    canResumeRenderer,
    rendererAdapter,
    mapFontAttachments,
    mapboxSession: createMapboxSession(),
    mapboxLoader: createMapboxLoader(),
    rendererSwitchStatus: {},
    onPublicationMapExport,
    styleAdapter,
    layerArchiveAccess,
    esriBasemapSession: createEsriBasemapSession(),
    workspace,
    role,
    project,
    workspaces,
    layers: workingLayers,
    datasets,
    allDatasets,
    browserCatalog,
    onBrowserProjectCreated,
    onLocalProjectLoaded,
    localProjectRecord,
    onDemoCapture,
    browserRegistrations: publicDemo ? readBrowserLayerCatalog(browserLocalStorage()) : new Map(),
    objects,
    allObjects,
    layouts,
    jobs,
    connectionBindings,
    basemapConnectionBindings,
    saveProject,
    saveProjectAs,
    importLocalFile,
    registerSource,
    startSourceDiscovery,
    getSourceDiscovery,
    sourceDiscoveryPollIntervalMs,
    sourceDiscoveryPollAttempts,
    canRequestProjectCompute: canRequestProjectCompute === null
      ? ["admin", "owner", "editor"].includes(role)
      : canRequestProjectCompute === true,
    estimateProtectedCopy,
    requestProtectedCopy,
    listProtectedCopies,
    cancelProtectedCopy,
    requestPmtilesDerivative,
    getPmtilesConversionCapabilities,
    listPmtilesDerivatives,
    cancelPmtilesDerivative,
    reviewPmtilesDisplay,
    admitPmtilesDisplay,
    loadManagedDatasetMetadata,
    protectedCopyJobs,
    pmtilesDerivativeJobs,
    refreshDurableJobs,
    loadDatasetFeatures,
    loadDatasetVersionPreview,
    queryDatasetFeatures,
    listQueryLocations,
    getQueryLocation,
    previewVectorAnalysis,
    cancelVectorAnalysis,
    createAnalysisRegistration,
    getAnalysisCollection,
    onProjectSaved,
    refreshKmlNetworkLink,
    applyGeoLibreImport,
    prepareGeoLibreHandoff,
    reviewGeoLibreReturn,
    resolveBasemapStyle,
    sources,
    persistenceMode,
    publicDemo,
    demoSurface: publicDemo && demoSurface,
    landingMode,
    printFrame,
    projectNavigation,
    projectSwitcher,
    initialDatasetTarget,
    draftScopeId,
    serverMapVersion: mapVersion,
    savedProjectOrigin: savedProjectOrigin ? structuredClone(savedProjectOrigin) : null,
    startBlank,
    storage: normalizeStorage(storage),
    dataByLayerId,
    loadingDatasetLayerIds: new Set(),
    failedDatasetLayerIds: new Set(),
    archivedGeojsonLoads: new Map(),
    layerToolsOpen: new Set(),
    layerArchiveModes: new Map(),
    layerArchiveControls: new Map(),
    preservedDatasetDisplays: new Map(),
    pendingPointSymbolLayers: new Map(),
    liveFeatureRequests: new Map(),
    liveFeatureQueue: [],
    liveFeatureActive: 0,
    state,
    shell,
    render: null,
    addLayer: null
  };
  for (const layer of workingLayers) {
    if (layer.sourceType === "governed-dataset" && isPreservedDatasetLayer(context, layer)) dataByLayerId.delete(layer.layerId);
  }
  state.preparePointSymbols = layer => loadInlinePointSymbolAssets(context, layer);
  if (restoreBrowserDraft) restoreTemporaryLayers(context);
  const restoredBasemap = activeBasemap(context);
  if (["retired", "disabled"].includes(restoredBasemap?.governance?.lifecycle)) {
    state.statusMessage = basemapGovernanceMessage(restoredBasemap, {savedProject: true});
  }
  context.lastConversionReport = null;
  context.pendingGeoLibreImport = null;
  context.pendingGeoLibreSource = null;
  context.pendingGeoMooseImport = null;
  context.pendingGeoMooseSource = null;
  context.lastImportRecovery = null;
  if (context.project?.extensions?.opengeoRenderer?.id === "cesium") {
    context.rendererSwitchStatus = {message:"Reopening the saved Cesium view after its Layers and Styles are ready. MapLibre remains available if it cannot open."};
    state.statusMessage = context.rendererSwitchStatus.message;
  }
  if (context.project?.extensions?.opengeoRenderer?.id === "mapbox") {
    context.rendererSwitchStatus = {message:"This Project prefers Mapbox. Enter your public token under View → Rendering engine to use it. MapLibre is active meanwhile."};
    state.statusMessage = context.rendererSwitchStatus.message;
  }

  state.onKmlFeatureClick = (layer, event) => {
    state.activeLayerId = layer.layerId;
    syncKmlLayerContext(context);
    const place = findKmlPlaceForUi(state.kmlPlaces, event.features?.[0]?.id);
    if (place?.kind === "placemark") {
      state.selectedKmlPlaceId = place.id;
      context.render();
      editKmlShape(context, place.id);
    }
  };
  shell.__opengeoLayers = workingLayers;
  shell.__opengeoData = dataByLayerId;
  shell.openPublicationMapExport = () => exportInteractiveMap(context, "offline");
  shell.getPrintContext = () => context.disposed ? null : ({
    map: state.map,
    renderer: context.rendererAdapter.id,
    layers: context.layers,
    handles: state.layerHandles,
    basemap: activeBasemap(context),
    project: currentProjectDefinition(context),
    savedProjectOrigin: context.savedProjectOrigin,
    ready: !context.loadingDatasetLayerIds.size && !context.liveFeatureRequests.size && !context.pendingPointSymbolLayers.size
      && context.layers.every(layer => layer.visible === false || (
        !context.failedDatasetLayerIds.has(layer.layerId)
        && !state.layerStyleErrors.has(layer.layerId)
        && !state.rendererLayerIssues?.has(layer.layerId)
      ))
  });
  shell.isPublicationMapExportReady = () => {
    const map = state.map;
    if (context.disposed || context.rendererAdapter.id !== "maplibre" || !map?.isStyleLoaded?.()
      || context.publicationLayersInstalledMap !== map
      || context.loadingDatasetLayerIds.size || context.liveFeatureRequests.size || context.pendingPointSymbolLayers.size) return false;
    return context.layers.every(layer => {
      // Hidden, failed and unsupported content stays disclosed in the review.
      if (layer.visible === false || context.failedDatasetLayerIds.has(layer.layerId)
        || state.layerStyleErrors.has(layer.layerId) || state.rendererLayerIssues?.has(layer.layerId)) return true;
      if (layer.styleReference && !state.resolvedLayerStyles.has(layer.layerId)) return false;
      if (!context.dataByLayerId.has(layer.layerId)) return true;
      const handle = state.layerHandles.get(layer.layerId);
      return Boolean(handle && map.getSource(handle.sourceId) && handle.layerIds?.length
        && handle.layerIds.every(id => map.getLayer(id)));
    });
  };
  shell.saveDraftForNavigation = () => {
    if (state.mapAuthoring || state.authoringCoordinateDraft) return false;
    if (context.localProjectRecord) return !context.localSaveBusy && localDraftSignature(context) === context.localDraftBaseline;
    return saveLocalDraft(context) === true;
  };
  shell.releaseRendererCredentials = () => releaseRendererCredentials(context);
  shell.resumeRenderer = async () => {
    if (context.disposed) return false;
    if (!context.rendererSuspended) return true;
    await switchRenderingEngine(context, "maplibre", {resume: true});
    return !context.rendererSuspended && Boolean(state.map);
  };
  const accountNavigation = () => {
    context.analysisConsole?.dispose();
    context.analysisConsole = null;
    context.queryLocationScopeInvalid = true;
    cancelDrillDownIdentify(context);
    cancelQueryLocationRequest(context);
    releaseRendererCredentials(context);
  };
  const browser = shell.ownerDocument.defaultView;
  browser.addEventListener("opengeo:account-navigation", accountNavigation);
  shell.dispose = () => {
    if (context.disposed) return;
    context.disposed = true;
    context.analysisConsole?.dispose();
    context.browserPrintStudio?.dispose?.();
    context.localProjectDialog?.dispose?.();
    context.pointSymbolDialog?.dispose?.();
    context.rasterViewshed?.view.dispose();
    context.polygon3dDialog?.dispose();
    state.managedDatasetMetadataRequest?.controller.abort();
    for (const choice of context.preservedDatasetDisplays.values()) choice.controller?.abort();
    cancelDrillDownIdentify(context);
    cancelQueryLocationRequest(context);
    browser.removeEventListener("opengeo:account-navigation", accountNavigation);
    context.cancelRendererSwitch?.();
    context.mapboxSession.clear();
    context.rendererPanel?.clearCredentialInput();
    context.disconnectionObserver?.disconnect();
    context.disposeResizablePanels?.();
    context.disposeCompactPanelTransitions?.();
    // Selection dialogs can exist before a renderer has initialized.
    if (!context.disposeResources) {
      for (const control of context.layerArchiveControls.values()) control.dispose();
      context.layerArchiveControls.clear();
    }
    context.disposeResources?.();
    context.rendererSuspended = null;
  };

  const topbar = document.createElement("header");
  topbar.className = "gis-topbar";
  const leftPanel = document.createElement("aside");
  leftPanel.className = "gis-panel gis-panel-left";
  const mapColumn = document.createElement("div");
  mapColumn.className = "gis-map-column";
  const mapContainer = document.createElement("div");
  mapContainer.className = "gis-map";
  mapContainer.role = "region";
  mapContainer.tabIndex = 0;
  mapContainer.setAttribute("aria-label", `${project?.name ?? workspace?.title ?? "OpenGeo Studio"} interactive map`);
  const mapChrome = document.createElement("div");
  mapChrome.className = "gis-map-chrome";
  const statusbar = document.createElement("footer");
  statusbar.className = "gis-statusbar";
  statusbar.setAttribute("aria-label", "Map status");
  const rightPanel = document.createElement("aside");
  rightPanel.className = "gis-panel gis-panel-right";
  const mobileToolbar = document.createElement("nav");
  mobileToolbar.className = "gis-mobile-toolbar";
  mobileToolbar.ariaLabel = "Mobile map tools";
  const modalLayer = document.createElement("div");
  modalLayer.className = "gis-modal-layer";

  const rendererSurface = document.createElement("div");
  rendererSurface.className = "gis-renderer-surface";
  context.mapContainer = mapContainer;
  context.mapSurface = rendererSurface;
  mapContainer.append(rendererSurface, mapChrome);
  const attribution = document.createElement("div");
  attribution.className = "gis-map-attribution maplibregl-map";
  attribution.setAttribute("aria-label", "Map attribution");
  mapColumn.append(mapContainer, attribution, statusbar);
  context.mapColumn = mapColumn;
  shell.append(topbar, leftPanel, mapColumn, rightPanel, mobileToolbar, modalLayer);
  context.modalLayer = modalLayer;

  context.addLayer = (layer, geojson, {panelAfterAdd = "style"} = {}) => addRuntimeLayer({
    ...context,
    layer,
    geojson,
    panelAfterAdd
  });
  context.render = () => {
    context.analysisConsole?.setTheme(state.colorMode === "dark");
    if(context.rasterObserverPick&&state.activePanel!=="style")context.rasterViewshed?.view.cancelPick();
    const area = state.queryLocationState;
    if (area && (area.layer !== activeLayer(context) || area.draft !== state.queryDraft
      || state.activePanel !== "query")) cancelQueryLocationRequest(context);
    if (context.rendererAdapter.id === "cesium") return renderCesiumWorkbench(context,
      {topbar,leftPanel,mapChrome,rightPanel,mobileToolbar,modalLayer,statusbar});
    shell.dataset.renderer=context.rendererAdapter.id;
    syncKmlLayerContext(context);
    syncPinnedMapFonts(context);
    const kmlVisible = context.layers.some((layer) => layer.layerId === editingKmlLayerId(context) && layer.visible !== false);
    if (state.shapeEditor && (!kmlVisible || !findKmlPlaceForUi(state.kmlPlaces, state.shapeEditor.id))) closeShapeEditor(context);
    if (state.imageOverlayEditor && (!kmlVisible || !findKmlPlaceForUi(state.kmlPlaces, state.imageOverlayEditor.id))) closeImageOverlayEditor(context);
    if (!publicDemo) {
      writeWorkspaceUiState(workspace?.workspaceId, {
        activePanel: state.activePanel,
        leftPanelMode: state.leftPanelMode,
        leftOpen: state.leftOpen,
        quickToolsOpen: state.quickToolsOpen,
        rightOpen: state.rightOpen
      });
    }
    shell.dataset.colorMode = state.colorMode;
    shell.dataset.basemapActivationState = state.basemapActivationState;
    const runtimeHealth = state.basemapRuntimeHealth.snapshot();
    shell.dataset.basemapRuntimeState = runtimeHealth.state;
    shell.dataset.basemapRuntimeFailures = `${runtimeHealth.failureCount}`;
    shell.dataset.basemapRuntimeResources = runtimeHealth.issueKinds.join(",");
    const governance = activeBasemap(context)?.governance;
    shell.dataset.basemapLifecycle = governance?.lifecycle ?? "project-managed";
    shell.dataset.basemapHealth = governance?.observation?.status ?? "not-recorded";
    updateKmlPresentation(shell, state);
    shell.classList.toggle("gis-map-only", Boolean(state.mapOnly));
    shell.classList.toggle("gis-map-controls-hidden", !state.mapControlsOpen || Boolean(state.mapOnly));
    shell.classList.toggle("left-collapsed", !state.leftOpen);
    shell.classList.toggle("right-collapsed", !state.rightOpen);
    updateProjectionPresentation(context);
    renderTopbar(topbar, context);
    renderLeftPanel(leftPanel, context);
    renderMapChrome(mapChrome, context);
    renderRightPanel(rightPanel, context);
    updateFlightPresentation(context);
    renderMobileToolbar(mobileToolbar, context);
    renderModalLayer(modalLayer, context);
    updateStatusbar(statusbar, context);
    updateGlobeTelemetryPresentation(context);
    syncGraticule(state);
    requestAnimationFrame(() => state.map?.resize());
    maybeRestoreSavedRenderer(context);
  };

  context.disposeCompactPanelTransitions = bindCompactPanelTransitions(context);
  context.localDraftBaseline = localDraftSignature(context);
  if (account) context.accountControls = StudioAccountControls({...account,
    saveDraft: async () => context.localProjectRecord ? Boolean(await savePersonalProject(context)) : saveLocalDraft(context),
    hasUnsavedChanges: () => Boolean(state.mapAuthoring || state.authoringCoordinateDraft)
      || localDraftSignature(context) !== context.localDraftBaseline
  });
  shell.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.code === "Backquote" && !event.defaultPrevented) {
      event.preventDefault();toggleAnalysisConsole(context);return;
    }
    if (event.key === "Escape" && state.mapOnly && !event.defaultPrevented
      && !event.target.closest("dialog")) {
      event.preventDefault();
      event.stopPropagation();
      setMapOnly(context, false);
    }
  });
  shell.addEventListener("workbench:render", () => context.render());
  shell.__opengeoRefreshDurableJobsView = ({message = null} = {}) => {
    state.durableJobsMessage = message;
    context.render();
  };
  context.render();
  context.disposeResizablePanels = bindResizablePanels({shell, leftPanel, rightPanel, mapColumn, state,
    render: context.render, isCompact: isMobileWorkbenchViewport,
    storageKey: `opengeo.panel-sizes.${workspace?.workspaceId ?? project?.projectId ?? "local"}`});
  void loadPersistedDatasetLayers(context);
  for (const layer of workingLayers) if (layer.styleReference) void loadBoundLayerStyle(context, layer);

  whenConnected(shell, () => {
    if (context.disposed) return;
    context.disconnectionObserver = observeDisconnection(shell, () => shell.dispose());
    if (!globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__) initializeMap(rendererSurface, context);
  });

  return shell;
}

function renderCesiumWorkbench(context, {topbar,leftPanel,mapChrome,rightPanel,mobileToolbar,modalLayer,statusbar}) {
  const {state,shell}=context;
  shell.dataset.renderer="cesium";
  shell.dataset.colorMode=state.colorMode;
  shell.classList.toggle("gis-map-only",Boolean(state.mapOnly));
  shell.classList.toggle("gis-map-controls-hidden",!state.mapControlsOpen || Boolean(state.mapOnly));
  shell.classList.toggle("left-collapsed",!state.leftOpen);
  shell.classList.toggle("right-collapsed",!state.rightOpen);
  renderTopbar(topbar,context);renderLeftPanel(leftPanel,context);renderRightPanel(rightPanel,context);
  mapChrome.replaceChildren();
  if(state.mapControlsOpen && !state.mapOnly) {
    const controls=document.createElement("div");controls.className="gis-map-control-stack";controls.dataset.expanded="true";
    const heading=document.createElement("div");heading.className="gis-controller-heading";
    heading.append(textElement("span","Map controls"),iconButton("Hide map controls","×",()=>{state.mapControlsOpen=false;context.render();}));
    controls.append(heading,
      actionButton("+",()=>state.map.easeTo({zoom:Math.min(22,state.map.getZoom()+1)})),
      actionButton("−",()=>state.map.easeTo({zoom:Math.max(0,state.map.getZoom()-1)})),
      actionButton("North",()=>state.map.easeTo({bearing:0})),
      actionButton("Top down",()=>state.map.easeTo({pitch:0})),
      rangeInput("Tilt",{min:0,max:85,step:1,value:state.map.getPitch(),onInput:value=>state.map.easeTo({pitch:value})}));
    mapChrome.append(controls);
  }
  mobileToolbar.replaceChildren(
    actionButton("Layers",()=>{state.leftOpen=!state.leftOpen;context.render();}),
    actionButton("Rendering engine",()=>{state.activePanel="renderer";state.rightOpen=true;context.render();}),
    actionButton(state.mapOnly?"Show tools":"Map only",()=>setMapOnly(context,!state.mapOnly)));
  renderModalLayer(modalLayer,context);updateStatusbar(statusbar,context);
  requestAnimationFrame(()=>state.map?.resize());
}

function cesiumDetailsPanel(context) {
  const panel=panelShell(), selection=context.state.cesiumSelection;
  panel.append(textElement("p","Click a feature on the globe to inspect its recorded attributes."));
  if(selection) {
    const layer=context.layers.find(layer=>layer.layerId===selection.layerId);
    panel.append(textElement("h3",layer?.title??selection.layerId));
    const table=document.createElement("dl");
    for(const [key,value] of Object.entries(selection.feature.properties??{})) {
      table.append(textElement("dt",key),textElement("dd",typeof value==='object'?JSON.stringify(value):String(value)));
    }
    panel.append(table);
  }
  panel.append(actionButton("Rendering engine",()=>{context.state.activePanel="renderer";context.render();}));
  return panel;
}

function cloneLayer(layer) {
  return {
    ...layer,
    ...(layer.kmlDocument ? {kmlDocument: structuredClone(layer.kmlDocument)} : {}),
    tileUrl: layer.tileUrl ?? (["xyz-raster", "wms-raster"].includes(layer.sourceType) ? layer.sourceUrl : undefined),
    ...(Object.hasOwn(layer,"filter")?{filter:structuredClone(validateMapFilter(layer.filter))}:{}),
    style: ["Point", "MultiPoint"].includes(layer.geometryType) && hasPointSymbolStyle(layer.style)
      ? normalizePointSymbolStyle(layer.style) : {...layer.style},
    ...(layer.pointClustering ? {pointClustering: {...validatePointClustering(layer.pointClustering)}} : {}),
    labels: {...layer.labels}
  };
}

function initializeMap(container, context) {
  if (context.disposed || !context.shell.isConnected) return;
  const {project, layers, datasets, dataByLayerId, state} = context;
  state.pmtilesReady = registerArchiveProtocols(context.rendererAdapter);
  const savedView = state.restoredMapViews?.[0] ?? project?.mapViews?.[0];
  const restoreSavedCamera = savedView && typeof savedView === "object";
  try {
    context.rendererAdapter.initialize();
    state.map = createMap(
    context.rendererAdapter,
    container,
    savedView,
    state.globe ? "globe" : "mercator",
    activeBasemap(context),
    (url, type) => state.mapFontSession.transformRequest(url, type, context.esriBasemapSession.transformRequest, context.rendererAdapter.id)
    );
    state.mapInitializationFailed = false;
    context.render();
  } catch {
    state.map = null;
    state.mapInitializationFailed = true;
    // A failed constructor can leave a canvas behind; retry only on request.
    container.replaceChildren();
    const notice = document.createElement("section");
    notice.className = "gis-map-startup-error";
    notice.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry map";
    retry.addEventListener("click", () => {
      notice.remove();
      initializeMap(container, context);
    });
    notice.append(textElement("strong", "Map graphics unavailable"),
      textElement("p", "The browser could not start the map graphics renderer. Close unused map tabs, then retry. If this continues, check your browser’s graphics acceleration settings. Your saved layers are unchanged."), retry);
    container.append(notice);
    setStatus(context, "Map graphics unavailable. Retry the map to continue.");
    context.render();
    return;
  }
  context.shell.__opengeoMap = state.map;
  const attribution = container.querySelector(".maplibregl-ctrl-attrib");
  if (attribution) context.shell.querySelector(".gis-map-attribution").append(attribution);
  context.localDraftBaseline = localDraftSignature(context);

  let resizeObserver = null;
  const resizeMap = () => state.map?.resize();

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => requestAnimationFrame(resizeMap));
    resizeObserver.observe(container);
  }

  context.disposeResources = () => {
    context.disconnectionObserver?.disconnect();
    context.disposeMapEvents?.();
    state.analysisPreviewController?.abort();
    closeShapeEditor(context);
    closeImageOverlayEditor(context);
    resizeObserver?.disconnect();
    if (state.kmlRegionFrame) cancelAnimationFrame(state.kmlRegionFrame);
    state.cancelBasemapActivationProbe?.();
    state.historicalAvailabilityAbortController?.abort();
    for (const request of context.liveFeatureRequests.values()) request.controller.abort();
    context.liveFeatureRequests.clear();
    for (const control of context.layerArchiveControls.values()) control.dispose();
    context.layerArchiveControls.clear();
    context.layerArchiveModes.clear();
    for (const session of state.archiveTileSessions.values()) session.dispose();
    state.archiveTileSessions.clear();
    for (const queued of context.liveFeatureQueue.splice(0)) queued.resolve(null);
    if (state.historicalPlaybackTimer) clearTimeout(state.historicalPlaybackTimer);
    stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
    stopFlightLoop(context);
    if (state.basemapRuntimeSwitchTimer) clearTimeout(state.basemapRuntimeSwitchTimer);
    const map = state.map;
    state.map = null;
    context.shell.__opengeoMap = null;
    context.rendererAdapter.disposeMap(map);
  };

  context.disposeMapEvents = bindMapEvents(context, {restoreSavedCamera});
}

function rendererSnapshot(context, map) {
  const style = map.getStyle();
  if (JSON.stringify(style).length > 40_000_000) throw Error("renderer_snapshot_limit");
  const images = new Map((context.rendererImages ?? []).map(image => [image.id,image]));
  if (typeof map.getImage === "function") for (const id of map.listImages()) {
    const image = map.getImage(id);
    if (image?.data?.data) images.set(id,{id, pixels:{width:image.data.width,height:image.data.height,data:image.data.data.slice()},
      options:{pixelRatio:image.pixelRatio ?? 1, sdf:image.sdf ?? false}});
  }
  for (const resolved of context.state.resolvedLayerStyles.values()) for (const image of resolved.images ?? []) {
    images.set(image.id,{id:image.id,pixels:image.pixels,options:{pixelRatio:image.pixelRatio}});
  }
  const preparedImages = [...images.values()];
  if (preparedImages.reduce((sum,image)=>sum+(image.pixels.data?.byteLength ?? 0),0)>32_000_000) throw Error("renderer_snapshot_limit");
  return {style, camera:captureMapView(map), images:preparedImages,
    sky:context.rendererAdapter.id === "maplibre" ? style.sky : context.rendererSky};
}

function releaseRendererCredentials(context) {
  const {state} = context;
  context.rendererRestoreToken = null;
  context.rendererRestorationSettled = true;
  context.cancelRendererSwitch?.();
  context.mapboxSession.clear();
  context.rendererPanel?.clearCredentialInput();
  if (context.disposed || !["mapbox","cesium"].includes(context.rendererAdapter.id) || !state.map) return;
  const map = state.map;
  // Save camera to the canonical draft fallback before releasing the native map.
  context.project = {...context.project, mapViews:mapViewsForSave(map, context.project?.mapViews)};
  try { context.rendererSuspended = rendererSnapshot(context, map); }
  catch { context.rendererSuspended = {}; } // Still dispose if a snapshot is too large/unavailable.
  context.disposeMapEvents?.(); context.disposeMapEvents = null;
  state.analysisPreviewController?.abort();
  state.cancelBasemapActivationProbe?.();
  state.historicalAvailabilityAbortController?.abort();
  if (state.historicalPlaybackTimer) clearTimeout(state.historicalPlaybackTimer);
  stopCameraTourPlayback(context, {reset:false,render:false,announce:false});
  stopFlightLoop(context);
  for (const handle of state.layerHandles.values()) {
    handle.needsInteractionRebind = Boolean(handle.mapEventHandlers?.length);
    handle.mapEventHandlers = [];
  }
  state.map = null; context.shell.__opengeoMap = null;
  context.rendererAdapter.disposeMap(map);
  context.mapSurface.replaceChildren();
  context.rendererAdapter = maplibreAdapter;
  const notice = document.createElement("section");
  notice.className = "gis-renderer-paused";
  const message = textElement("p", "Map paused after account access changed. Your layers and edits are retained; the Mapbox token has been cleared.");
  message.setAttribute("role", "status");
  const resume = actionButton("Resume with MapLibre", async () => {
    resume.disabled = true;
    try {
      if (context.canResumeRenderer && !await context.canResumeRenderer()) {
        message.textContent = "Project access could not be confirmed. Sign in to the original account, then retry.";
        return;
      }
      if (!await context.shell.resumeRenderer()) message.textContent = "The map could not resume. Save your browser draft before reloading, or retry.";
    } catch { message.textContent = "Project access could not be confirmed. Retry when your connection is available."; }
    finally { resume.disabled = false; }
  });
  notice.append(message, resume); context.mapContainer.append(notice);
  context.rendererPauseNotice = notice;
  context.rendererSwitchStatus = {message:message.textContent};
  state.statusMessage = message.textContent;
  context.render();
}

// Restore once after the existing loaders have produced a usable fallback.
// Re-rendering does not poll providers or retry a failed optional renderer.
function maybeRestoreSavedRenderer(context) {
  const {state} = context;
  if (context.disposed || context.rendererRestorationSettled || context.rendererPreference
    || context.project?.extensions?.opengeoRenderer?.id !== "cesium"
    || context.rendererSwitchStatus.pending || context.rendererSuspended
    || !state.map?.loaded?.()) return;
  if (context.loadingDatasetLayerIds.size || context.liveFeatureRequests.size
    || context.layers.some(layer => layer.styleReference
      && !state.resolvedLayerStyles.has(layer.layerId) && !state.layerStyleErrors.has(layer.layerId))) return;
  const report = cesiumWorkbenchContent(context);
  context.rendererRestorationSettled = true;
  if (!report.ready) {
    context.rendererSwitchStatus = {message:`The saved Cesium view cannot display all of this Project yet. MapLibre remains active. ${report.issues[0]?.message ?? "Review compatibility under Rendering engine."}`};
    state.statusMessage = context.rendererSwitchStatus.message;
    queueMicrotask(() => {if (!context.disposed) context.render();});
    return;
  }
  const token = Symbol();
  context.rendererRestoreToken = token;
  queueMicrotask(() => {
    if (context.disposed || context.rendererRestoreToken !== token) return;
    context.rendererRestoreToken = null;
    void switchRenderingEngine(context, "cesium", {automatic:true});
  });
}

async function switchRenderingEngine(context, engineId, {resume = false, automatic = false} = {}) {
  if (!automatic) {
    context.rendererRestoreToken = null;
    context.rendererRestorationSettled = true;
  }
  const {state} = context;
  const original = state.map, previousAdapter = context.rendererAdapter;
  if (context.rendererSwitchStatus.pending) return;
  if (context.rendererSuspended && !resume) return;
  if (engineId === previousAdapter.id && !resume) {
    context.rendererPreference = engineId;
    context.rendererSwitchStatus = {message:`${rendererTitle(engineId)} selected for this Project. Save to keep this preference.`};
    context.render(); return;
  }
  if (!resume && !original?.isStyleLoaded()) {
    context.rendererSwitchStatus = {message:"Wait for the current map to finish loading."};
    context.render(); return;
  }
  const compatibility = mapboxCompatibility({layers:context.layers, state, style:original?.getStyle()});
  if (!resume && ((engineId === "mapbox" && !compatibility.ready) || compatibility.issues.some(issue=>issue.code === "active-edit"))) {
    context.rendererSwitchStatus = {message:"Keep MapLibre for the listed content, or finish the active edit before switching."};
    context.render(); return;
  }
  if (engineId === "cesium" && !cesiumWorkbenchContent(context).ready) {
    context.rendererSwitchStatus = {message:"Keep the current renderer for the listed content. Your Project is unchanged."};
    context.render(); return;
  }
  const controller = new AbortController();
  context.cancelRendererSwitch = () => controller.abort();
  context.rendererSwitchStatus = {pending:true, message:resume ? "Resuming with MapLibre…" : `Opening ${rendererTitle(engineId)}… Your current map remains available.`};
  state.statusMessage = context.rendererSwitchStatus.message;
  context.render();
  let candidate = null, surface = null, adapter = null, rollback = null;
  try {
    adapter = engineId === "cesium" ? cesiumWorkbenchAdapter : engineId === "mapbox" ? await context.mapboxLoader.load(context.mapboxSession) : maplibreAdapter;
    if (controller.signal.aborted || context.disposed) throw Error("renderer_switch_cancelled");
    const snapshot = resume ? context.rendererSuspended : rendererSnapshot(context, original);
    if (!snapshot?.style) throw Error("renderer_snapshot_unavailable");
    const {style, camera, images:preparedImages, sky:retainedSky} = snapshot;
    const signature = JSON.stringify(style);
    const draftSignature = localDraftSignature(context);
    surface = document.createElement("div"); surface.className = "gis-renderer-surface";
    surface.dataset.pending = "true"; surface.setAttribute("aria-hidden","true"); surface.inert = true;
    context.mapContainer.prepend(surface);
    candidate = engineId === "cesium"
      ? await prepareCesiumWorkbench({container:surface,...cesiumWorkbenchContent(context),snapshot,signal:controller.signal})
      : await prepareRendererMap({adapter,container:surface,
        style:rendererStyle(style,engineId,retainedSky),camera,images:preparedImages,signal:controller.signal,
        transformRequest:(url,type)=>state.mapFontSession.transformRequest(url,type,context.esriBasemapSession.transformRequest,engineId)});
    if (controller.signal.aborted || context.disposed) throw Error("renderer_switch_cancelled");
    if (original !== state.map || draftSignature !== localDraftSignature(context)
      || (!resume && (signature !== JSON.stringify(original.getStyle()) || !sameRendererCamera(camera,captureMapView(original))))) {
      throw Error("renderer_view_changed");
    }
    // All preparation succeeded. Preserve canonical state and replace only the
    // SDK map, its event bindings and surface. No record creation or save occurs.
    const previousSurface = context.mapSurface;
    const previousPreference = context.rendererPreference, previousSky = context.rendererSky, previousImages = context.rendererImages;
    const previousHandles = new Map([...state.layerHandles].map(([id,handle])=>[id,{...handle}]));
    const previousQueryHandlersBound = state.queryResultHandlersBound;
    rollback = () => {
      context.disposeMapEvents?.();
      state.map = original; context.rendererAdapter = previousAdapter; context.mapSurface = previousSurface;
      context.rendererPreference = previousPreference; context.rendererSky = previousSky; context.rendererImages = previousImages;
      context.shell.__opengeoMap = original;
      state.layerHandles = previousHandles;
      state.queryResultHandlersBound = previousQueryHandlersBound;
      context.disposeMapEvents = original ? bindMapEvents(context) : null;
    };
    context.disposeMapEvents?.();
    state.map = candidate; context.rendererAdapter = adapter; context.mapSurface = surface;
    if (!resume) context.rendererPreference = engineId;
    context.rendererSky = retainedSky;
    context.rendererImages = preparedImages; context.shell.__opengeoMap = candidate;
    context.disposeMapEvents = bindMapEvents(context);
    if (engineId !== "cesium") for (const layer of context.layers) {
      const handle = state.layerHandles.get(layer.layerId);
      if (!handle?.mapEventHandlers?.length && !handle?.needsInteractionRebind) continue;
      handle.mapEventHandlers = handle.paintLayerIds.flatMap(id => bindLayerInteraction(state,candidate,layer,id,context.datasets));
      delete handle.needsInteractionRebind;
    }
    // Result sources survived the style snapshot; their SDK event listeners did
    // not. Recreate just this transient overlay with the retained selection.
    if (engineId !== "cesium") {
    for (const id of ["opengeo-query-result-fill","opengeo-query-result-line","opengeo-query-result-point"]) {
      if (candidate.getLayer(id)) candidate.removeLayer(id);
    }
    if (candidate.getSource("opengeo-query-result-source")) candidate.removeSource("opengeo-query-result-source");
    state.queryResultHandlersBound = false;
    syncQueryResultLayer(context,state.queryResult?.features ?? []);
    }
    if (engineId === "maplibre") {
      state.rendererLayerIssues?.clear();
      for (const layer of context.layers) addMapLayer(state,layer,context.dataByLayerId.get(layer.layerId),context.datasets);
      syncLayerOrder(context);
    }
    const attribution = surface.querySelector(".maplibregl-ctrl-attrib, .mapboxgl-ctrl-attrib");
    if (attribution) context.shell.querySelector(".gis-map-attribution").replaceChildren(attribution);
    if (engineId === "cesium") context.shell.querySelector(".gis-map-attribution").textContent =
      context.layers.map(layer=>layer.attribution).filter(Boolean).join(" | ");
    surface.inert = false; surface.removeAttribute("aria-hidden"); delete surface.dataset.pending;
    try { previousAdapter.disposeMap(original); } catch { /* Candidate is already usable. */ }
    rollback = null;
    previousSurface.remove(); candidate = null; surface = null;
    context.rendererSuspended = null;
    context.rendererPauseNotice?.remove(); context.rendererPauseNotice = null;
    context.rendererSwitchStatus = {message:`Using ${rendererTitle(engineId)}. Project layers and edits are retained.`};
    setStatus(context,context.rendererSwitchStatus.message);
  } catch (error) {
    rollback?.();
    if (candidate && candidate !== state.map) adapter?.disposeMap(candidate);
    if (surface && surface !== context.mapSurface) surface.remove();
    context.rendererSwitchStatus = {message: resume || context.rendererSuspended ? "The map is paused. Your layers and edits are retained; retry or save a browser draft before reloading." : error.message === "mapbox_public_token_required"
      ? "Enter your public Mapbox token to continue."
      : error.message === "renderer_view_changed" ? "The map changed while opening the renderer. Your current view is retained; try again when ready."
        : error.message === "renderer_switch_cancelled" ? "Renderer switch cancelled. Your current map is retained."
          : "The renderer could not open. Your current map is retained. Check the token, connection and compatibility, then retry."};
    state.statusMessage = context.rendererSwitchStatus.message;
  } finally {
    context.cancelRendererSwitch = null;
    if (!context.disposed) context.render();
  }
}

function bindMapEvents(context, {restoreSavedCamera = true} = {}) {
  if (context.rendererAdapter.id === "cesium") {
    const scene=context.state.map.scene;
    const pick=scene.onPick(({feature})=>{
      context.state.cesiumSelection=feature;
      if(feature){context.state.activeLayerId=feature.layerId;context.state.selectedFeatureIndex=feature.featureIndex;}
      context.state.activePanel="identify";context.state.rightOpen=true;context.render();
    });
    const camera=scene.onCameraChange(()=>updateStatusbar(context.shell.querySelector(".gis-statusbar"),context));
    const imagery=scene.onBasemapError(message=>{context.state.statusMessage=message;updateStatusbar(context.shell.querySelector(".gis-statusbar"),context);});
    return ()=>{pick();camera();imagery();};
  }
  const {state, layers, datasets, dataByLayerId} = context;
  const map = state.map;
  const resizeMap = () => map.resize();
  const fitMap = () => { resizeMap(); fitVisibleLayers(map, layers, dataByLayerId); };
  let disposed = false, frame = null;
  const timers = [], listeners = [];
  const on = (type, callback) => {
    const handler = (...args) => { if (!disposed && state.map === map) callback(...args); };
    map.on(type, handler); listeners.push({type, handler});
  };
  on("cogstatus", event => setStatus(context, event.message));
  on("coglayerready", () => context.render());
  const sampleAnimationFrame = () => {
    if (disposed) return;
    recordGlobeFrame(state.globeTelemetry);
    const samples = state.globeTelemetry.frameIntervals.length;
    if (samples > 0 && samples % 5 === 0 && samples !== state.globeTelemetryPresentedSamples) {
      state.globeTelemetryPresentedSamples = samples;
      updateGlobeTelemetryPresentation(context);
    }
    if (samples < GLOBE_TELEMETRY_LIMITS.maximumFrameSamples) {
      frame = requestAnimationFrame(sampleAnimationFrame);
    }
  };
  frame = requestAnimationFrame(sampleAnimationFrame);

  on("load", () => {
    recordGlobeLoad(state.globeTelemetry);
    const projection = applyMapProjection(state.map, state.globe ? "globe" : "mercator");
    state.globe = projection.effective === "globe";
    state.projectionFallback = projection.fallback;
    if (state.terrainEnabled && state.globe) beginTerrainTiming(state.globeTelemetry);
    const activation = currentTerrainActivation(state);
    const terrain = applyOpenTerrain(
      state.map,
      state.terrainEnabled && state.globe,
      {exaggeration: state.terrainExaggeration, activation}
    );
    state.terrainEnabled = terrain.effective;
    state.terrainExaggeration = terrain.exaggeration;
    state.terrainFallback = terrain.fallback;
    state.terrainFallbackReason = terrain.reason;
    if (terrain.fallback) cancelTerrainTiming(state.globeTelemetry);
    recordGlobeCamera(state.globeTelemetry, state.map);
    updateProjectionPresentation(context);
    resizeMap();
    installRasterBasemap(state, activeBasemap(context));
    captureBasemapOpacityLayers(state);
    setBasemapOpacity(state);
    const openScene3dActivation = currentOpenScene3dActivation(state);
    const openScene3d = applyOpenScene3d(
      state.map,
      state.openScene3dEnabled && state.globe,
      {globe: state.globe, activation: openScene3dActivation}
    );
    state.openScene3dEnabled = openScene3d.effective;
    state.openScene3dFallback = openScene3d.fallback;
    state.openScene3dFallbackReason = openScene3d.reason;
    updateProjectionPresentation(context);
    for (const layer of [...layers].reverse()) {
      const geojson = dataByLayerId.get(layer.layerId);
      addMapLayer(state, layer, geojson, datasets);
    }
    syncMeasureLayer(state);
    syncSunlightGuide(state);
    syncTemporaryEditLayer(state);
    void loadPersistedDatasetLayers(context);
    if (context.publicDemo) void restoreBrowserCatalogLayers({
      layers: context.layers, catalog: context.browserCatalog, dataByLayerId,
      isCurrent: layer => context.shell.isConnected && context.layers.includes(layer),
      onData: (layer, data) => {
        removeMapLayer(state, layer.layerId);
        addMapLayer(state, layer, data, datasets);
        syncLayerOrder(context);
        context.render();
      },
      onStatus: message => setStatus(context, message)
    });
    context.publicationLayersInstalledMap = map;
    signalPublicationMapReadiness(context);
    const settleInitialView = restoreSavedCamera ? resizeMap : fitMap;
    timers.push(setTimeout(settleInitialView, 0));
    timers.push(setTimeout(settleInitialView, 150));
    timers.push(setTimeout(settleInitialView, 500));
    context.render();
    const selectedBasemap = activeBasemap(context);
    if (["provider-style", "provider-raster"].includes(selectedBasemap?.kind)
      && !(selectedBasemap.styleUrl ?? selectedBasemap.url)) {
      void selectBasemapChoice(context, selectedBasemap);
    }
  });

  on("moveend", () => {
    syncGraticule(state);
    updateStatusbar(context.shell.querySelector(".gis-statusbar"), context);
    recordGlobeCamera(state.globeTelemetry, state.map);
    refreshKmlRegionPresentation(state);
    scheduleKmlNetworkLinkViewRefresh(context);
    refreshBasemapCoverage(context);
    updateGlobeTelemetryPresentation(context);
  });

  on("move", () => {
    context.updateCameraControls?.();
    if (state.kmlRegionFrame) return;
    state.kmlRegionFrame = requestAnimationFrame(() => {
      state.kmlRegionFrame = null;
      refreshKmlRegionPresentation(state);
    });
  });

  on("idle", () => {
    installCachedDatasetLayers(context);
    syncPinnedMapFonts(context);
    if (Number.isFinite(state.globeTelemetry.terrainStartedAt)) {
      completeTerrainTiming(state.globeTelemetry);
    }
    const outageBeforeIdle = state.terrainOutageGuard.snapshot();
    if (state.terrainEnabled) {
      state.terrainOutageGuard.recordSuccess(OPEN_TERRAIN_SOURCE.sourceId);
      if (outageBeforeIdle.state === "half-open") updateProjectionPresentation(context);
    }
    if (state.openScene3dEnabled) recordOpenScene3dVisibleFeatures(state);
    // The retained map can emit idle while an isolated retry probe is still
    // running. Only the probe may decide whether that recovery attempt passed.
    if (!state.basemapRuntimeSwitchPending && !state.basemapRuntimeProbeInProgress) {
      const runtimeBeforeIdle = state.basemapRuntimeHealth.snapshot();
      const runtimeAfterIdle = state.basemapRuntimeHealth.recordReady(state.currentBasemapId);
      if (runtimeAfterIdle.state !== runtimeBeforeIdle.state) {
        if (runtimeBeforeIdle.state === "retrying") {
          const message = basemapRuntimeMessage({title: activeBasemap(context)?.title, runtime: runtimeAfterIdle});
          setStatus(context, message);
        }
        context.render();
      }
      refreshBasemapCoverage(context);
    }
    recordGlobeCamera(state.globeTelemetry, state.map);
    updateProjectionPresentation(context);
    updateGlobeTelemetryPresentation(context);
    maybeRestoreSavedRenderer(context);
    signalPublicationMapReadiness(context);
  });

  on("sourcedata", (event) => {
    if (state.openScene3dEnabled && event.sourceId === OPEN_3D_SCENE_SOURCE.sourceId
      && event.sourceDataType === "content" && event.isSourceLoaded) {
      state.openScene3dOutageGuard.recordSuccess(event.sourceId);
    }
  });

  on("error", (event) => {
    if (state.openScene3dEnabled && event?.sourceId === OPEN_3D_SCENE_SOURCE.sourceId) {
      const outage = state.openScene3dOutageGuard.recordFailure(event.sourceId);
      if (!outage.allowed) {
        applyOpenScene3d(state.map, false);
        state.openScene3dEnabled = false;
        state.openScene3dFallback = true;
        state.openScene3dFallbackReason = "source-outage";
        state.openScene3dGovernanceStatus = "source-outage";
        state.openScene3dBuildingFeatures = 0;
        state.openScene3dWoodlandFeatures = 0;
        setStatus(context, openScene3dGovernanceMessage("source-outage"));
        context.render();
      }
    }
    if (state.terrainEnabled && event?.sourceId === OPEN_TERRAIN_SOURCE.sourceId) {
      const outage = state.terrainOutageGuard.recordFailure(event.sourceId);
      if (!outage.allowed) {
        applyOpenTerrain(state.map, false, {exaggeration: state.terrainExaggeration});
        state.terrainEnabled = false;
        state.terrainFallback = true;
        state.terrainFallbackReason = "source-outage";
        state.terrainGovernanceStatus = "source-outage";
        cancelTerrainTiming(state.globeTelemetry);
        markFlightTerrainUnavailable(context);
        setStatus(context, terrainGovernanceMessage({status: "source-outage"}));
        context.render();
      }
    }
    if (state.basemapRuntimeProbeInProgress) return;
    const basemap = activeBasemap(context);
    const managedSourceIds = workbenchManagedSourceIds(state);
    for (const sourceId of state.basemapRuntimeManagedSourceIds ?? []) managedSourceIds.add(sourceId);
    if (!basemapRuntimeErrorApplies({
      basemap,
      event,
      managedSourceIds,
      networkAllowed: basemapNetworkAllowed(basemap)
    })) return;
    const runtimeBeforeError = state.basemapRuntimeHealth.snapshot();
    const issue = basemapRuntimeIssueFromError({event, style: state.map?.getStyle?.()});
    const runtimeAfterError = state.basemapRuntimeHealth.recordFailure(state.currentBasemapId, issue);
    if (runtimeSnapshotSignature(runtimeAfterError) !== runtimeSnapshotSignature(runtimeBeforeError)) {
      if (runtimeAfterError.state === "outage" && state.basemapRuntimeSwitchTimer) {
        clearTimeout(state.basemapRuntimeSwitchTimer);
        state.basemapRuntimeSwitchTimer = null;
      }
      const message = basemapRuntimeMessage({title: basemap?.title, runtime: runtimeAfterError});
      setStatus(context, message);
      context.render();
    }
  });

  on("pointcluster", event => setStatus(context, event.message));

  on("mousemove", (event) => {
    if (state.mapAuthoring) {
      const draft = state.mapAuthoring;
      draft.canClose = polygonOriginHit(state, draft, event.point);
      draft.hover = draft.canClose ? draft.coordinates[0] : [event.lngLat.lng, event.lngLat.lat];
      state.map.getCanvas().style.cursor = draft.canClose ? "pointer" : "crosshair";
      context.shell.dataset.polygonCanClose = String(draft.canClose);
      const hint = context.shell.querySelector(".gis-map-authoring-guide > span");
      if (hint) hint.textContent = draft.canClose ? "Click the first point to complete the polygon." : mapAuthoringInstruction(draft);
      syncMapAuthoringLayer(state);
    }
    state.coordinateText = `${event.lngLat.lng.toFixed(5)}, ${event.lngLat.lat.toFixed(5)}`;
    updateStatusbar(context.shell.querySelector(".gis-statusbar"), context);
  });

  on("click", (event) => {
    if(context.rasterObserverPick){const pick=context.rasterObserverPick;context.rasterObserverPick=null;
      if(pick.root.isConnected&&pick.root.open&&!state.temporaryEdit&&!state.queryDrawing&&!state.mapAuthoring&&!state.measureMode){
        const point=event.lngLat.wrap?.()??event.lngLat;pick.callback([point.lng,point.lat]);return;}
      context.rasterViewshed?.view.cancelPick();}
    if (state.temporaryEdit) {
      handleTemporaryEditMapClick(context, event);
      return;
    }
    if (state.queryDrawing) {
      addQueryDrawingPoint(context, event.lngLat, event.point);
      return;
    }
    if (state.mapAuthoring) {
      addMapAuthoringPoint(context, event.lngLat, event.point);
      return;
    }
    if (state.measureMode) {
      addMeasurePoint(context, event.lngLat);
      return;
    }
    const clusterLayers = [...state.layerHandles.values()].flatMap(handle => handle.clusterLayerIds ?? []).filter(id => state.map.getLayer(id));
    if (clusterLayers.length && state.map.queryRenderedFeatures(event.point, {layers: clusterLayers}).length) return;
    if (selectImageOverlayAt(context, event.point)) return;
    if (state.identify && (visibleCogLayers(context).length || !mapClickUsesLocalInteraction(context, event))) {
      void runDrillDownIdentify(context, event.lngLat, event.point);
    }
  });
  return () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    for (const timer of timers) clearTimeout(timer);
    for (const {type, handler} of listeners) map.off(type, handler);
  };
}

function mapClickUsesLocalInteraction(context, event) {
  const {map, layerHandles} = context.state;
  if (!map || typeof map.queryRenderedFeatures !== "function" || !event?.point) return false;
  const interactiveLayerIds = [
    "opengeo-query-result-fill",
    "opengeo-query-result-line",
    "opengeo-query-result-point"
  ];
  for (const layer of context.layers) {
    if (isGovernedDatasetLayer(layer)) continue;
    const handle = layerHandles.get(layer.layerId);
    interactiveLayerIds.push(...(handle?.paintLayerIds ?? []));
  }
  return renderedFeatureHit(map, event.point, interactiveLayerIds);
}

function observeDisconnection(element, dispose) {
  if (typeof MutationObserver === "undefined" || !element.isConnected) return null;
  const observer = new MutationObserver(() => {
    if (element.isConnected) return;
    observer.disconnect();
    dispose();
  });
  observer.observe(element.ownerDocument.documentElement, {childList: true, subtree: true});
  return observer;
}


function renderTopbar(topbar, context) {
  const {workspace, workspaces, role, state, startBlank, publicDemo, landingMode} = context;
  topbar.replaceChildren();

  const brand = document.createElement("a");
  brand.className = "gis-brand";
  brand.href = publicDemo ? "/" : "/";
  brand.append(
    textElement("strong", "OpenGeo Studio"),
    textElement("span", landingMode
      ? "Untitled local map"
      : publicDemo
        ? "Public workbench demo"
      : startBlank
        ? "Untitled map"
        : context.project?.name ?? workspace?.title ?? "Untitled Project")
  );

  const appNav = document.createElement("nav");
  appNav.className = "gis-app-nav";
  appNav.ariaLabel = "Application navigation";
  appNav.append(...(context.demoSurface ? demoNavigationItems() : studioNavigationItems(context.persistenceMode === "fixture" ? "fixture" : null))
    .filter(item => !context.projectSwitcher || ["projects", "data", "styles", "collections", "publishing"].includes(item.id))
    .map(item => navLink(item.label, item.href)));

  const publicWorkspaceOptions = context.demoSurface && Array.isArray(context.projectNavigation?.workspaceOptions)
    ? context.projectNavigation.workspaceOptions
    : [];
  const publicMapOptions = context.demoSurface && Array.isArray(context.projectNavigation?.mapOptions)
    ? context.projectNavigation.mapOptions
    : [];
  const workspaceChoices = publicWorkspaceOptions.length
    ? publicWorkspaceOptions
    : workspaces.length
      ? workspaces
      : [workspace].filter(Boolean);
  const workspaceSelect = document.createElement("select");
  workspaceSelect.className = "gis-workspace-select";
  workspaceSelect.ariaLabel = context.demoSurface ? "Switch public project or map" : landingMode ? "Current Project" : "Switch access workspace";
  workspaceSelect.disabled = landingMode || (publicDemo && publicWorkspaceOptions.length < 2);
  if (landingMode) workspaceSelect.title = "Create or open a project to use the workspace switcher";
  else if (publicDemo) workspaceSelect.title = "Switch between public demonstration projects and reviewed map presets";
  if (publicDemo && publicMapOptions.length) {
    const starter = publicWorkspaceOptions.find(({pageId}) => pageId === "community-facilities");
    if (starter) workspaceSelect.append(selectOption({
      value: starter.pageId,
      title: starter.title,
      selected: starter.pageId === context.projectNavigation.activePageId
    }));
    const groupedOptions = new Map();
    for (const candidate of publicMapOptions) {
      const group = groupedOptions.get(candidate.group) ?? document.createElement("optgroup");
      group.label = candidate.group;
      if (!groupedOptions.has(candidate.group)) {
        groupedOptions.set(candidate.group, group);
        workspaceSelect.append(group);
      }
      group.append(selectOption({
        value: candidate.pageId,
        title: candidate.title,
        selected: candidate.pageId === context.projectNavigation.activePageId
      }));
    }
  } else {
    for (const candidate of workspaceChoices) {
      workspaceSelect.append(selectOption({
        value: candidate.workspaceId,
        title: candidate.title,
        selected: candidate.workspaceId === workspace?.workspaceId
      }));
    }
  }
  workspaceSelect.addEventListener("change", () => {
    if (landingMode) return;
    if (publicDemo) {
      context.projectNavigation?.onSelectPage?.(workspaceSelect.value);
      return;
    }
    if (workspaceSelect.value && workspaceSelect.value !== workspace?.workspaceId) {
      location.href = projectHref(workspaceSelect.value, {
        adapterKind: fixtureAdapterKind(context.persistenceMode)
      });
    }
  });
  appNav.append(context.projectSwitcher ? savedProjectSwitcher(context) : workspaceSelect);

  const menus = document.createElement("nav");
  menus.className = "gis-menubar";
  menus.ariaLabel = "Full workspace menus";
  for (const menu of toolbarMenus(context)) {
    menus.append(menuButton(menu, context));
  }

  const toolstrip = document.createElement("div");
  toolstrip.className = "gis-toolstrip";
  const quickTools = primaryToolbar(context);
  quickTools.hidden = !state.quickToolsOpen;
  const quickToggle = actionButton(state.quickToolsOpen ? "Hide quick tools" : "Show quick tools", () => {
    state.quickToolsOpen = !state.quickToolsOpen;
    context.render();
    topbar.querySelector(".gis-quick-tools-toggle")?.focus();
  });
  quickToggle.classList.add("gis-quick-tools-toggle");
  quickToggle.setAttribute("aria-expanded", String(state.quickToolsOpen));
  quickToggle.title = "The same actions remain available in the menus.";
  menus.append(quickToggle);
  const controlsVisible = state.mapControlsOpen && !state.mapOnly;
  const controls = iconButton(controlsVisible ? "Hide map controls" : "Show map controls", "☷", () => {
    state.mapControlsOpen = !controlsVisible;
    state.mapOnly = false;
    context.render();
    topbar.querySelector(".gis-controls-command")?.focus();
  });
  controls.classList.add("gis-controls-command");
  controls.setAttribute("aria-pressed", String(controlsVisible));
  menus.append(controls);
  toolstrip.append(menus, quickTools);

  const right = document.createElement("div");
  right.className = "gis-top-actions";
  const roleBadge = textElement("span", context.localProjectRecord ? "Saved on this device" : landingMode ? "Browser draft" : publicDemo ? "public demo" : role ?? "viewer");
  if (landingMode) roleBadge.title = "Saved in this browser only, not in your OpenGeo Studio account. Signing in does not upload this map.";
  roleBadge.className = `badge ${publicDemo || landingMode ? "demo" : role ?? "viewer"}`;
  roleBadge.classList.add("gis-role-badge");
  const commands = workbenchCommandRegistry(context);
  const saveCommand = commands.find(({id}) => id === "save");
  const saveAsCommand = commands.find(({id}) => id === "save-as");
  const save = actionButton(saveCommand.label, saveCommand.action);
  save.disabled = saveCommand.disabled;
  save.title = saveCommand.title;
  save.classList.add("gis-save-command");
  const saveAs = actionButton(saveAsCommand.label, saveAsCommand.action);
  saveAs.disabled = saveAsCommand.disabled;
  saveAs.title = saveAsCommand.title;
  saveAs.classList.add("gis-save-as-command");
  const mode = actionButton(state.colorMode === "dark" ? "Light" : "Dark", () => {
    state.colorMode = state.colorMode === "dark" ? "light" : "dark";
    saveWorkbenchColorMode(state.colorMode);
    if (state.portalConfiguration) {
      state.portalConfiguration = normalizePortalConfiguration({
        ...state.portalConfiguration,
        revision: state.portalConfiguration.revision + 1,
        theme: state.colorMode === "light"
          ? {id: "opengeo-light", title: "OpenGeo Studio light", colorMode: "light"}
          : {id: "opengeo-default", title: "OpenGeo Studio default", colorMode: "dark"}
      });
    }
    context.render();
    setStatus(context, `${state.colorMode} app theme`);
  });
  mode.classList.add("gis-theme-command");
  right.append(roleBadge, save, saveAs, mode);
  if (publicDemo && !context.printFrame) right.append(actionButton("On this device", () => void openPersonalProjects(context)));
  const mapOnly = actionButton(state.mapOnly ? "Show tools" : "Map only", () => {
    setMapOnly(context, !state.mapOnly);
    topbar.querySelector(".gis-map-only-command")?.focus();
  });
  mapOnly.classList.add("gis-map-only-command");
  mapOnly.title = state.mapOnly ? "Restore panels and map controls" : "Hide Layers, Inspector and all map controls";
  mapOnly.setAttribute("aria-pressed", String(Boolean(state.mapOnly)));
  right.append(mapOnly);
  if (context.accountControls) right.append(context.accountControls);

  if (context.rendererAdapter.id === "cesium") {
    toolstrip.replaceChildren(actionButton("Rendering engine",()=>{state.activePanel="renderer";state.rightOpen=true;context.render();}),
      actionButton("Fit",()=>fitVisibleLayers(state.map,context.layers,context.dataByLayerId)),controls,
      textElement("small","Cesium · pan, zoom, inspect and organize Layers. Use MapLibre for editing and other tools."));
  }
  topbar.append(brand, appNav, right, toolstrip);
}

function savedProjectSwitcher(context) {
  if (context.savedProjectSelect) return context.savedProjectSelect;
  const select = document.createElement("select");
  select.className = "gis-workspace-select";
  select.ariaLabel = "Switch project";
  const currentId = context.project?.mapId ?? "";
  const currentTitle = context.project?.name ?? "Untitled local map";
  let loaded = false, loading = false;
  const fill = (records = [], message = null) => {
    select.replaceChildren(selectOption({value: currentId, title: currentTitle, selected: true}));
    for (const record of records) {
      if (record.id !== currentId) select.append(selectOption({value: record.id, title: record.name}));
    }
    if (message) {
      const status = selectOption({value: "", title: message});
      status.disabled = true;
      select.append(status);
    }
    select.append(selectOption({value: "browse", title: "Browse all projects…"}));
  };
  fill(context.projectSwitcher.initial);
  const load = async () => {
    if (loaded || loading || !context.projectSwitcher.load) return;
    loading = true;
    select.setAttribute("aria-busy", "true");
    try {
      fill(await context.projectSwitcher.load());
      loaded = true;
    } catch (error) {
      fill(context.projectSwitcher.initial, error?.status === 401 ? "Sign in to load projects" : "Projects unavailable — reopen to retry");
    } finally {
      loading = false;
      select.removeAttribute("aria-busy");
    }
  };
  select.addEventListener("focus", load);
  select.addEventListener("pointerdown", load);
  select.addEventListener("change", () => {
    const id = select.value;
    if (id === currentId) return;
    const dirty = localDraftSignature(context) !== context.localDraftBaseline;
    if (dirty && !globalThis.confirm("Leave this map with unsaved changes? Save it first to keep your work.")) {
      select.value = currentId;
      return;
    }
    const adapterKind = fixtureAdapterKind(context.persistenceMode);
    location.href = id === "browse" ? directoryHref({adapterKind}) : compositionHref(id, {adapterKind});
  });
  context.savedProjectSelect = select;
  return select;
}

function primaryToolbar(context) {
  const toolbar = document.createElement("nav");
  toolbar.className = "gis-primary-toolbar";
  toolbar.ariaLabel = "Primary project and drawing tools";
  const commands = workbenchCommandRegistry(context).filter(({desktop}) => desktop);
  for (const [groupId, label] of [["project", "Project"], ["create", "Create"], ["map", "Map tools"], ["layer", "Layer order"]]) {
    const groupCommands = commands.filter(({group}) => group === groupId);
    if (!groupCommands.length) continue;
    const group = primaryCommandGroup(label);
    group.append(...groupCommands.map((command) => commandButton(command)));
    toolbar.append(group);
  }
  return toolbar;
}

function renderMobileToolbar(toolbar, context) {
  const definitions = workbenchCommandRegistry(context).filter(({mobile}) => mobile);
  let buttons = [...toolbar.querySelectorAll(":scope > .gis-mobile-command")];
  if (buttons.length !== definitions.length) {
    buttons = definitions.map((command) => {
      const button = commandButton(command, command.mobileLabel ?? command.label);
      button.classList.add("gis-mobile-command");
      return button;
    });
    toolbar.replaceChildren(...buttons);
    return;
  }
  for (const [index, command] of definitions.entries()) {
    const button = buttons[index];
    button.title = command.title;
    button.disabled = command.disabled;
    button.classList.toggle("active", command.active);
    if (command.active) button.setAttribute("aria-pressed", "true");
    else button.removeAttribute("aria-pressed");
  }
}

function openFeatureQueryPanel(context) {
  const {state} = context;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  state.activePanel = "query";
  state.rightOpen = true;
  setStatus(context, "Governed query builder opened.");
  context.render();
}

function workbenchCommandRegistry(context) {
  const {publicDemo, landingMode, state} = context;
  const layer = activeLayer(context);
  const moveState = layer ? projectLayerMoveState(context, layer) : null;
  return [
    {
      id: "layers", label: "Layers", symbol: "layers", mobile: true,
      title: state.leftOpen ? "Close project contents" : "Open project contents",
      active: state.leftOpen, disabled: false, action: () => {
        state.rightOpen = false;
        state.leftOpen = !state.leftOpen;
        setStatus(context, state.leftOpen ? "Project contents opened." : "Project contents closed.");
        context.render();
      }
    },
    {
      id: "new-project", label: "New project", symbol: "new-project", group: "project", sheet: true,
      title: publicDemo && !landingMode ? "Start a new browser-only demo map" : "Start a new durable project",
      active: false, disabled: false, action: () => {
        if (publicDemo) newWorkspaceProject(context);
        else location.href = "/workspaces?new=1";
      }
    },
    {
      id: "open-project", label: "Open project", symbol: "open-project", group: "project", sheet: true,
      title: "Open the project directory",
      active: false, disabled: false, action: () => {
        location.href = publicDemo && !landingMode ? "/?view=examples" : "/workspaces";
      }
    },
    {
      id: "open-file", label: "Open file", symbol: "open-file", group: "project", desktop: true, sheet: true,
      title: "Choose a supported Project file to review and open", active: false, disabled: false,
      action: () => openProjectFile(context)
    },
    {
      id: "add-data", label: "Add data", symbol: "add-data", group: "project", desktop: true, sheet: true,
      title: "Add files, services, or connected data to this project", active: state.activePanel === "add", disabled: false,
      action: () => openAddSource(context, "vector")
    },
    {
      id: "catalog", label: "Catalog", symbol: "open-file", group: "project", desktop: publicDemo, sheet: true,
      title: publicDemo ? "Choose catalog Layers to add to this Project" : "Browse this instance's projects, data and files",
      active: state.activePanel === "catalog" && state.rightOpen, disabled: false,
      action: () => {
        if (publicDemo && !context.projectSwitcher) { state.activePanel = "catalog"; state.rightOpen = true; context.render(); }
        else location.href = directoryHref({view: "data", adapterKind: fixtureAdapterKind(context.persistenceMode)});
      }
    },
    {
      id: "save", label: context.landingMode ? "Save in browser" : publicDemo ? "Save locally" : "Save", symbol: "save", sheet: true,
      title: publicDemo ? "Save this Project on this device without an account. Download a backup for important work."
        : canPersist(context) ? "Save the authoritative map record" : "Your current role cannot update this map",
      active: false, disabled: context.printFrame || context.localSaveBusy || (!publicDemo && !canPersist(context)),
      action: () => publicDemo ? void savePersonalProject(context) : void saveAuthoritativeProject(context)
    },
    {
      id: "save-as", label: "Save as", symbol: "save-as", sheet: true,
      title: "Save a map copy or export a Project file in a supported format",
      active: false, disabled: false, action: () => openProjectExportDialog(context)
    },
    {
      id: "point", label: "Point", symbol: "point", group: "create", desktop: true, mobile: true,
      title: "Draw a point directly on the map", active: state.mapAuthoring?.kind === "Point" && state.mapAuthoring?.target !== "temporary", disabled: false,
      action: () => beginMapAuthoring(context, "Point")
    },
    {
      id: "path", label: "Path", symbol: "path", group: "create", desktop: true, mobile: true,
      title: "Draw a path directly on the map", active: state.mapAuthoring?.kind === "LineString" && state.mapAuthoring?.target !== "temporary", disabled: false,
      action: () => beginMapAuthoring(context, "LineString")
    },
    {
      id: "polygon", label: "Polygon", symbol: "polygon", group: "create", desktop: true, mobile: true,
      title: "Draw a polygon directly on the map", active: state.mapAuthoring?.kind === "Polygon" && state.mapAuthoring?.target !== "temporary", disabled: false,
      action: () => beginMapAuthoring(context, "Polygon")
    },
    {
      id: "overlay", label: "Image overlay", mobileLabel: "Overlay", symbol: "image-overlay", group: "create", mobile: true,
      title: "Choose an image, then position, resize, or rotate it on the map", active: Boolean(state.imageOverlayEditor), disabled: false,
      action: () => chooseImageOverlay(context)
    },
    {
      id: "fit", label: "Fit", symbol: "fit", group: "map", desktop: true,
      title: "Fit all visible layers on the map", active: false, disabled: false,
      action: () => fitVisibleLayers(state.map, context.layers, context.dataByLayerId)
    },
    {
      id: "identify", label: "Identify", symbol: "identify", group: "map", desktop: true,
      title: state.identify ? "Turn identify off" : "Turn identify on", active: state.identify, disabled: false,
      action: () => {
        state.identify = !state.identify;
        setStatus(context, state.identify ? "Identify enabled." : "Identify disabled.");
        context.render();
      }
    },
    {
      id: "query", label: "Query", symbol: "query", group: "map",
      title: "Search attributes or draw a spatial query", active: state.activePanel === "query", disabled: false,
      action: () => openFeatureQueryPanel(context)
    },
    {
      id: "history", label: "Imagery history", symbol: "history", group: "map",
      title: "Browse reviewed historical imagery dates and the sunlight guide",
      active: state.activePanel === "history", disabled: state.spatialBody.id !== "earth",
      action: () => openHistoricalImageryPanel(context)
    },
    {
      id: "tour", label: "Camera tour", symbol: "tour",
      title: "Record, edit, and play a deterministic sequence of map views",
      active: state.activePanel === "tour", disabled: false,
      action: () => openCameraTourPanel(context)
    },
    {
      id: "flight", label: "Flight simulator", mobileLabel: "Flight", symbol: "flight",
      title: "Open the bounded terrain-aware training simulator",
      active: state.activePanel === "flight", disabled: state.spatialBody.id !== "earth",
      action: () => openFlightSimulatorPanel(context)
    },
    {
      id: "measure", label: "Measure", symbol: "measure", group: "map",
      title: "Open line, path, polygon, and circle measurement tools",
      active: state.activePanel === "measure", disabled: false,
      action: () => openMeasurementPanel(context)
    },
    ...(publicDemo && context.onDemoCapture ? [{
      id: "demo-capture", label: "Try field capture", symbol: "point", group: "map", desktop: false, sheet: true,
      title: "Try temporary observations, attachments and review in this browser tab",
      active: false, disabled: false, action: () => {
        closeMobileCommandSheet(context);
        void context.onDemoCapture().catch(() => setStatus(context, "Capture demonstration could not load. Try again."));
      }
    }] : []),
    {
      id: "temporary", label: publicDemo && !landingMode ? "Edit sample" : "Temporary work", symbol: "temporary", group: "map", sheet: true,
      title: "Draw or upload isolated browser-only annotations that expire after 24 hours",
      active: state.activePanel === "temporary", disabled: false,
      action: () => openTemporaryWorkPanel(context)
    },
    {
      id: "layer-up", label: "Layer up", symbol: "layer-up", group: "layer", sheet: true,
      title: layer ? "Move the active layer up in the stack" : "Select a project layer before changing its order",
      active: false, disabled: !moveState?.canMoveUp, action: () => moveLayer(context, layer, -1)
    },
    {
      id: "layer-down", label: "Layer down", symbol: "layer-down", group: "layer", sheet: true,
      title: layer ? "Move the active layer down in the stack" : "Select a project layer before changing its order",
      active: false, disabled: !moveState?.canMoveDown, action: () => moveLayer(context, layer, 1)
    },
    {
      id: "more", label: "Actions", symbol: "commands", mobile: true,
      title: "Open project navigation, data, layer, map, processing, and settings actions",
      active: state.mobileCommandSheetOpen, disabled: false, action: () => openMobileCommandSheet(context)
    }
  ];
}

function commandButton(command, label = command.label) {
  return primaryCommand(label, command.symbol, command.action, command.title, {
    id: command.id,
    disabled: command.disabled,
    active: command.active
  });
}

const COMPACT_WORKBENCH_MEDIA = "(max-width: 820px), (max-width: 1000px) and (max-height: 500px)";

function isMobileWorkbenchViewport() {
  try {
    return globalThis.matchMedia?.(COMPACT_WORKBENCH_MEDIA).matches === true;
  } catch {
    return false;
  }
}

function bindCompactPanelTransitions(context) {
  let media;
  try {
    media = globalThis.matchMedia?.(COMPACT_WORKBENCH_MEDIA);
  } catch {
    return () => {};
  }
  if (!media) return () => {};

  let desktopPanelState = null;
  let compact = media.matches;
  const handleChange = (event) => {
    const nextCompact = Boolean(event.matches);
    if (nextCompact === compact) return;
    compact = nextCompact;
    if (nextCompact) {
      if (!context.state.leftOpen && !context.state.rightOpen) return;
      desktopPanelState = {
        leftOpen: context.state.leftOpen,
        rightOpen: context.state.rightOpen
      };
      context.state.leftOpen = false;
      context.state.rightOpen = false;
      context.render();
      return;
    }
    if (!desktopPanelState) return;
    context.state.leftOpen = desktopPanelState.leftOpen;
    context.state.rightOpen = desktopPanelState.rightOpen;
    desktopPanelState = null;
    context.render();
  };
  const handleResize = () => handleChange({matches: media.matches});

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleChange);
    globalThis.addEventListener?.("resize", handleResize);
    return () => {
      media.removeEventListener("change", handleChange);
      globalThis.removeEventListener?.("resize", handleResize);
    };
  }
  media.addListener?.(handleChange);
  globalThis.addEventListener?.("resize", handleResize);
  return () => {
    media.removeListener?.(handleChange);
    globalThis.removeEventListener?.("resize", handleResize);
  };
}

function saveWorkbenchColorMode(mode) {
  try { globalThis.localStorage?.setItem("opengeo.workbench.color-mode", mode); } catch { /* Session preference remains usable. */ }
}

function preferredWorkbenchColorMode() {
  try {
    const saved = globalThis.localStorage?.getItem("opengeo.workbench.color-mode");
    if (saved === "dark" || saved === "light") return saved;
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return DEFAULT_WORKBENCH_COLOR_MODE;
  }
}

function primaryCommandGroup(label) {
  const group = document.createElement("div");
  group.className = "gis-primary-command-group";
  group.role = "group";
  group.setAttribute("aria-label", label);
  return group;
}

function primaryCommand(label, symbol, action, title, {id = null, disabled = false, active = false} = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-primary-command";
  button.dataset.primaryCommand = id ?? label.toLowerCase().replaceAll(" ", "-");
  button.disabled = disabled;
  if (active) button.setAttribute("aria-pressed", "true");
  button.classList.toggle("active", active);
  button.title = title;
  const symbolElement = primaryCommandIcon(symbol);
  symbolElement.setAttribute("aria-hidden", "true");
  button.append(
    symbolElement,
    textElement("strong", label)
  );
  button.addEventListener("click", action);
  return button;
}

function primaryCommandIcon(name) {
  const wrapper = document.createElement("span");
  wrapper.className = "gis-command-icon";
  const drawings = {
    "new-project": '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 14h6M12 11v6"/>',
    "open-project": '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/>',
    "open-file": '<path d="M3 7h7l2 2h9v10H3z"/><path d="M12 16V5M8.5 8.5 12 5l3.5 3.5"/>',
    "add-data": '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
    point: '<path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11z"/><circle cx="12" cy="10" r="2"/>',
    path: '<path d="m4 18 5-9 6 6 5-10"/><circle cx="4" cy="18" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="15" cy="15" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
    polygon: '<path d="m5 6 8-3 6 6-3 10H7L3 12z"/><circle cx="5" cy="6" r="1.25"/><circle cx="13" cy="3" r="1.25"/><circle cx="19" cy="9" r="1.25"/><circle cx="16" cy="19" r="1.25"/><circle cx="7" cy="19" r="1.25"/><circle cx="3" cy="12" r="1.25"/>',
    "image-overlay": '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8" cy="9" r="1.5"/><path d="m5 17 4.5-4.5 3 3 2-2L19 17"/>',
    fit: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    identify: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
    query: '<circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5"/><path d="M7 10h6M10 7v6"/>',
    measure: '<path d="m5 17 12-12 3 3L8 20z"/><path d="m9 13 2 2M12 10l2 2M15 7l2 2"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/><path d="M4 5v5h5"/>',
    tour: '<path d="M4 7h10a4 4 0 0 1 0 8H8"/><path d="m8 11-4 4 4 4"/><circle cx="5" cy="7" r="2"/><circle cx="18" cy="11" r="2"/>',
    flight: '<path d="m3 13 7-2 3-7 2 1-1 6 6 2-1.5 2-5-1-.5 6-2-1-1-6-6-1z"/><path d="M11 11h3"/>',
    temporary: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/><path d="M17 15v6M14 18h6"/>',
    layers: '<path d="m4 8 8-4 8 4-8 4z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
    commands: '<circle cx="5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="19" cy="12" r="1.25"/>',
    save: '<path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 16h8"/>',
    "save-as": '<path d="M4 3h11l2 2v8"/><path d="M7 3v6h7V3M8 18h11M15 14l4 4-4 4"/>',
    "layer-up": '<path d="m4 15 8 4 8-4M4 11l8 4 8-4M4 7l8-4 8 4-8 4z"/>',
    "layer-down": '<path d="m4 9 8-4 8 4-8 4zM4 13l8 4 8-4M12 17v4M9 19l3 3 3-3"/>',
    "panel-close": '<path d="M6 5h12v14H6zM10 5v14M14 9l-3 3 3 3"/>',
    visibility: '<path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5z"/><circle cx="12" cy="12" r="2.5"/>',
    "visibility-off": '<path d="M3 3l18 18M9.8 7.2A10.5 10.5 0 0 1 12 7c6 0 9.5 5 9.5 5a16 16 0 0 1-3 3.2M6.2 8.2A16 16 0 0 0 2.5 12s3.5 5 9.5 5c.8 0 1.6-.1 2.3-.3"/><path d="M10.4 10.4a2.3 2.3 0 0 0 3.2 3.2"/>',
    "expand-all": '<path d="M5 3v6h6M19 21v-6h-6M11 9 5 3M13 15l6 6"/>',
    "collapse-all": '<path d="M11 9H5V3M13 15h6v6M5 9l6-6M19 15l-6 6"/>'
  };
  const drawing = drawings[name];
  if (!drawing) {
    wrapper.textContent = name;
    return wrapper;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = drawing;
  wrapper.append(svg);
  return wrapper;
}

function beginMapAuthoring(context, kind, {target = "places"} = {}) {
  closeShapeEditor(context);
  closeImageOverlayEditor(context);
  const {state} = context;
  pauseFlightSimulation(context, {render: false, announce: false});
  cancelQueryDrawing(context, {render: false, announce: false});
  cancelMapAuthoring(context, {render: false, announce: false});
  cancelTemporaryEdit(context, {render: false, announce: false});
  state.mapAuthoring = {kind, coordinates: [], target};
  state.measureMode = false;
  state.editingMeasurementId = null;
  state.measurePoints = [];
  syncMeasureLayer(state);
  state.leftOpen = target === "temporary" ? true : !isMobileWorkbenchViewport();
  state.rightOpen = false;
  state.leftPanelMode = "layers";
  state.kmlContentsOpen = target !== "temporary";
  state.selectedKmlPlaceId = null;
  if (target === "places" && !state.kmlPlaces) {
    state.mapAuthoringCreatedKmlPlaces = true;
    state.kmlInterchangeReport = emptyKmlReport();
    applyKmlPlacesDocument(context, createPlacesDocument(), mapAuthoringInstruction(state.mapAuthoring));
  }
  setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
  syncMapAuthoringLayer(state);
  context.render();
}

function polygonOriginHit(state, draft, point) {
  const map = state.map;
  if (!map || map.isMoving?.()) return false;
  const canvas = map.getCanvas();
  return canClosePolygon(draft, point, coordinate => map.project(coordinate), 12,
    {width: canvas.clientWidth, height: canvas.clientHeight});
}

function addMapAuthoringPoint(context, lngLat, point) {
  const {state} = context;
  if (!state.mapAuthoring) return;
  if (polygonOriginHit(state, state.mapAuthoring, point)) {
    finishMapAuthoring(context);
    return;
  }
  state.mapAuthoring.hover = null;
  state.mapAuthoring.canClose = false;
  state.mapAuthoring.coordinates.push([
    boundedCoordinate(lngLat?.lng, 0),
    boundedCoordinate(lngLat?.lat, 0)
  ]);
  syncMapAuthoringLayer(state);
  if (state.mapAuthoring.kind === "Point") {
    finishMapAuthoring(context);
    return;
  }
  setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
  context.render();
}

function undoMapAuthoringPoint(context) {
  const {state} = context;
  if (!state.mapAuthoring?.coordinates.length) return;
  state.mapAuthoring.coordinates.pop();
  syncMapAuthoringLayer(state);
  setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
  context.render();
}

function finishMapAuthoring(context) {
  const {state} = context;
  const draft = state.mapAuthoring;
  if (!draft || !mapAuthoringCanFinish(draft)) return;
  const kind = draft.kind;
  if (draft.target === "temporary") {
    try {
      const entry = createTemporaryAnnotation({kind, coordinates: draft.coordinates});
      state.mapAuthoring = null;
      state.primaryAuthoringKind = null;
      syncMapAuthoringLayer(state);
      context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});
      persistTemporaryWork(context);
      state.leftPanelMode = "layers";
      state.leftOpen = true;
      state.rightOpen = true;
      setStatus(context, `${entry.layer.title} added as browser-only temporary work. It expires after 24 hours and is excluded from authoritative saves.`);
      context.render();
    } catch (error) {
      state.mapAuthoring = null;
      syncMapAuthoringLayer(state);
      setStatus(context, `Temporary annotation rejected safely (${error?.code ?? "invalid_annotation"}).`);
      context.render();
    }
    return;
  }
  if (kind === "image-overlay") {
    const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = draft.coordinates;
    state.overlayExtentDraft = [
      Math.min(firstLongitude, secondLongitude),
      Math.min(firstLatitude, secondLatitude),
      Math.max(firstLongitude, secondLongitude),
      Math.max(firstLatitude, secondLatitude)
    ];
  } else {
    const coordinates = draft.coordinates.map(([longitude, latitude]) => [longitude, latitude]);
    if (kind === "Polygon") coordinates.push([...coordinates[0]]);
    const name = kind === "LineString" ? "Path" : kind;
    try {
      const next = addKmlPlace(state.kmlPlaces, state.kmlPlaces.id, {
        kind: "placemark", name,
        geometry: parseAuthoringGeometry(kind, coordinates.map((coordinate) => coordinate.join(",")).join(" ")),
        altitudeMode: "clampToGround", tessellate: kind !== "Point",
        style: defaultAuthoredKmlStyle(kind, "ff00a5f5")
      });
      state.selectedKmlPlaceId = findNewestKmlPlace(state.kmlPlaces, next).id;
      state.mapAuthoring = null;
      state.mapAuthoringCreatedKmlPlaces = false;
      state.primaryAuthoringKind = null;
      state.authoringCoordinateDraft = null;
      syncMapAuthoringLayer(state);
      applyKmlPlacesDocument(context, next, `${name} added to the map. You can edit its shape or details at any time.`);
      return;
    } catch (error) {
      setStatus(context, `The shape is still a draft (${error?.code ?? "invalid geometry"}). Adjust its points and try again.`);
      return;
    }
  }
  state.mapAuthoring = null;
  state.primaryAuthoringKind = kind;
  if (isMobileWorkbenchViewport()) state.leftOpen = true;
  syncMapAuthoringLayer(state);
  setStatus(context, kind === "image-overlay"
    ? "Overlay extent captured. Choose a local image and confirm its details."
    : `${kind === "LineString" ? "Path" : kind} geometry captured. Name it and add it to the KML layer.`);
  context.render();
  requestAnimationFrame(() => {
    const selector = kind === "image-overlay"
      ? '.gis-overlay-authoring [data-kml-overlay-field="name"]'
      : '.gis-place-authoring [data-kml-authoring-field="name"]';
    context.shell.querySelector(selector)?.focus();
  });
}

function cancelMapAuthoring(context, {render = true, announce = true} = {}) {
  const {state} = context;
  const wasActive = Boolean(state.mapAuthoring);
  state.mapAuthoring = null;
  syncMapAuthoringLayer(state);
  if (wasActive && state.mapAuthoringCreatedKmlPlaces) {
    const placeholder = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
    if (placeholder) {
      removeMapLayer(state, placeholder.layerId);
      context.layers.splice(context.layers.indexOf(placeholder), 1);
      context.dataByLayerId.delete(placeholder.layerId);
    }
    state.kmlPlaces = null;
    state.kmlInterchangeReport = null;
    state.mapAuthoringCreatedKmlPlaces = false;
  }
  if (wasActive && context.layers.length === 0) state.leftPanelMode = "layers";
  if (announce && wasActive) setStatus(context, "Map drawing canceled.");
  if (render && wasActive) context.render();
}

function mapAuthoringCanFinish(draft) {
  const minimum = draft?.kind === "LineString" || draft?.kind === "image-overlay"
    ? 2
    : draft?.kind === "Polygon"
      ? 3
      : 1;
  return (draft?.coordinates?.length ?? 0) >= minimum;
}

function mapAuthoringInstruction(draft) {
  const count = draft?.coordinates?.length ?? 0;
  const temporary = draft?.target === "temporary" ? "Temporary " : "";
  if (draft?.kind === "Point") return `${temporary}point tool active · click the map to place a point.`;
  if (draft?.kind === "LineString") return `${temporary}path tool active · ${count ? `${count} ${count === 1 ? "vertex" : "vertices"} · ` : ""}click to add vertices, then Finish path.`;
  if (draft?.kind === "Polygon") return `${temporary}polygon tool active · ${count ? `${count} ${count === 1 ? "vertex" : "vertices"} · ` : ""}click at least three corners, then click the first point or Finish polygon.`;
  return `Image overlay tool active · ${count ? "click the opposite corner" : "click the first extent corner"}.`;
}

function syncMapAuthoringLayer(state) {
  const map = state.map;
  if (!map?.isStyleLoaded()) return;
  const sourceId = "opengeo-authoring-source";
  const fillId = "opengeo-authoring-fill";
  const lineId = "opengeo-authoring-line";
  const pointId = "opengeo-authoring-points";
  map.getCanvas().style.cursor = state.mapAuthoring ? (state.mapAuthoring.canClose ? "pointer" : "crosshair") : "";
  const data = mapAuthoringPreview(state.mapAuthoring);
  if (map.getSource(sourceId)) { map.getSource(sourceId).setData(data); return; }
  if (!state.mapAuthoring) return;
  map.addSource(sourceId, {type: "geojson", data});
  map.addLayer({id: fillId, type: "fill", source: sourceId, filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#38bdf8", "fill-opacity": 0.22}});
  map.addLayer({id: lineId, type: "line", source: sourceId, filter: ["!=", ["geometry-type"], "Point"], paint: {"line-color": "#38bdf8", "line-width": 3, "line-dasharray": [2, 1]}});
  map.addLayer({id: pointId, type: "circle", source: sourceId, filter: ["==", ["geometry-type"], "Point"], paint: {"circle-color": ["case", ["boolean", ["get", "close"], false], "#4ade80", "#f8fafc"], "circle-radius": ["case", ["boolean", ["get", "close"], false], 9, 6], "circle-stroke-color": "#0284c7", "circle-stroke-width": 3}});
}

function beginQueryDrawing(context, kind, replaceIndex = null) {
  const {state} = context;
  cancelMapAuthoring(context, {render: false, announce: false});
  cancelTemporaryEdit(context, {render: false, announce: false});
  state.measureMode = false;
  state.editingMeasurementId = null;
  state.measurePoints = [];
  syncMeasureLayer(state);
  state.queryDrawing = {kind, coordinates: [], replaceIndex};
  state.activePanel = "query";
  state.rightOpen = true;
  state.queryError = null;
  syncQueryGeometryLayer(state);
  setStatus(context, queryDrawingInstruction(state.queryDrawing));
  context.render();
}

function addQueryDrawingPoint(context, lngLat, point) {
  const {state} = context;
  if (!state.queryDrawing) return;
  if (polygonOriginHit(state, state.queryDrawing, point)) {
    finishQueryDrawing(context);
    return;
  }
  state.queryDrawing.coordinates.push([
    boundedCoordinate(lngLat?.lng, 0),
    boundedCoordinate(lngLat?.lat, 0)
  ]);
  syncQueryGeometryLayer(state);
  if (state.queryDrawing.kind === "Point") {
    finishQueryDrawing(context);
    return;
  }
  setStatus(context, queryDrawingInstruction(state.queryDrawing));
  context.render();
}

function undoQueryDrawingPoint(context) {
  if (!context.state.queryDrawing?.coordinates.length) return;
  context.state.queryDrawing.coordinates.pop();
  syncQueryGeometryLayer(context.state);
  setStatus(context, queryDrawingInstruction(context.state.queryDrawing));
  context.render();
}

function finishQueryDrawing(context) {
  const {state} = context;
  const drawing = state.queryDrawing;
  if (!drawing || !queryDrawingCanFinish(drawing)) return;
  const layer = activeLayer(context);
  if (!layer?.datasetId) {
    cancelQueryDrawing(context, {render: false, announce: false});
    setStatus(context, "The query selection was canceled because its governed layer is no longer active.");
    context.render();
    return;
  }
  const coordinates = drawing.coordinates.map((coordinate) => [...coordinate]);
  let geometry;
  if (drawing.kind === "Point") geometry = {type: "Point", coordinates: coordinates[0]};
  else if (drawing.kind === "MultiPoint") geometry = {type: "MultiPoint", coordinates};
  else if (drawing.kind === "LineString") geometry = {type: "LineString", coordinates};
  else if (drawing.kind === "Box") {
    const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = coordinates;
    const west = Math.min(firstLongitude, secondLongitude);
    const east = Math.max(firstLongitude, secondLongitude);
    const south = Math.min(firstLatitude, secondLatitude);
    const north = Math.max(firstLatitude, secondLatitude);
    if (west === east || south === north) {
      setStatus(context, "A box selection needs two different map corners.");
      return;
    }
    geometry = {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    };
  } else geometry = {type: "Polygon", coordinates: [[...coordinates, coordinates[0]]]};
  const draft = featureQueryDraft(state, layer, propertyFields(
    context.dataByLayerId.get(layer.layerId)
  ));
  const step = {kind: "spatial", relation: "intersects", geometry, buffer_meters: 0};
  let capacityError = false;
  if (Number.isInteger(drawing.replaceIndex) && draft.steps[drawing.replaceIndex]?.kind === "spatial") {
    const previous = draft.steps[drawing.replaceIndex];
    step.relation = previous.relation;
    step.buffer_meters = previous.buffer_meters;
    draft.steps.splice(drawing.replaceIndex, 1, step);
  } else if (draft.steps.length < FEATURE_QUERY_LIMITS.maximumSteps) {
    draft.steps.push(step);
  } else {
    capacityError = true;
  }
  state.queryDrawing = null;
  invalidateFeatureQueryResult(context);
  if (capacityError) state.queryError = "maximum_query_steps_reached";
  syncQueryGeometryLayer(state);
  const selectionLabel = drawing.kind === "Box" ? "Box" : geometry.type;
  setStatus(context, `${selectionLabel} query selection captured. Run the query to link map and table results.`);
  context.render();
}

function useVisibleQueryArea(context) {
  const layer = activeLayer(context);
  if (!layer?.datasetId) {
    setStatus(context, "Select a governed layer before adding the visible map area to a query.");
    return;
  }
  const bounds = context.state.map?.getBounds?.();
  if (!bounds) {
    setStatus(context, "The visible map area is unavailable until the map is ready.");
    return;
  }
  const west = Math.max(-180, boundedCoordinate(bounds.getWest(), -180));
  const south = Math.max(-90, boundedCoordinate(bounds.getSouth(), -90));
  const east = Math.min(180, boundedCoordinate(bounds.getEast(), 180));
  const north = Math.min(90, boundedCoordinate(bounds.getNorth(), 90));
  if (east <= west || north <= south) {
    setStatus(context, "Visible-area queries cannot cross the antimeridian; draw a bounded polygon instead.");
    return;
  }
  const draft = featureQueryDraft(context.state, layer, propertyFields(
    context.dataByLayerId.get(layer.layerId)
  ));
  const step = {
    kind: "spatial",
    relation: "intersects",
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    },
    buffer_meters: 0
  };
  const existing = draft.steps.findIndex(({kind}) => kind === "spatial");
  let capacityError = false;
  if (existing >= 0) draft.steps.splice(existing, 1, step);
  else if (draft.steps.length < FEATURE_QUERY_LIMITS.maximumSteps) draft.steps.push(step);
  else capacityError = true;
  invalidateFeatureQueryResult(context);
  if (capacityError) context.state.queryError = "maximum_query_steps_reached";
  setStatus(context, "Visible map area added as a reproducible box query condition.");
  context.render();
}

function cancelQueryDrawing(context, {render = true, announce = true} = {}) {
  const wasActive = Boolean(context.state.queryDrawing);
  context.state.queryDrawing = null;
  syncQueryGeometryLayer(context.state);
  if (wasActive && announce) setStatus(context, "Query drawing canceled.");
  if (wasActive && render) context.render();
}

function queryDrawingCanFinish(drawing) {
  const minimum = ["LineString", "Box"].includes(drawing?.kind)
    ? 2
    : drawing?.kind === "Polygon"
      ? 3
      : 1;
  return (drawing?.coordinates?.length ?? 0) >= minimum;
}

function queryDrawingInstruction(drawing) {
  const count = drawing?.coordinates?.length ?? 0;
  if (drawing?.kind === "Point") return "Point query active · click the map to select a location.";
  if (drawing?.kind === "LineString") return `Line query active · ${count} ${count === 1 ? "vertex" : "vertices"} · add at least two, then finish.`;
  if (drawing?.kind === "MultiPoint") return `Multiple-point query active · ${count} ${count === 1 ? "point" : "points"} · add locations, then finish.`;
  if (drawing?.kind === "Box") return `Box query active · ${count ? "click the opposite corner, then finish" : "click the first corner"}.`;
  return `Polygon query active · ${count} ${count === 1 ? "vertex" : "vertices"} · add at least three, then click the first point or finish.`;
}

function syncQueryGeometryLayer(state) {
  const map = state.map;
  if (!map?.isStyleLoaded()) return;
  const sourceId = "opengeo-query-drawing-source";
  const layerIds = ["opengeo-query-drawing-fill", "opengeo-query-drawing-line", "opengeo-query-drawing-points"];
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  const drawing = state.queryDrawing;
  if (!drawing?.coordinates.length) return;
  const features = drawing.coordinates.map((coordinate) => ({
    type: "Feature",
    properties: {kind: "vertex"},
    geometry: {type: "Point", coordinates: coordinate}
  }));
  if (drawing.coordinates.length >= 2) features.push({
    type: "Feature",
    properties: {kind: "edge"},
    geometry: {type: "LineString", coordinates: drawing.coordinates}
  });
  if (drawing.kind === "Polygon" && drawing.coordinates.length >= 3) features.push({
    type: "Feature",
    properties: {kind: "area"},
    geometry: {type: "Polygon", coordinates: [[...drawing.coordinates, drawing.coordinates[0]]]}
  });
  if (drawing.kind === "Box" && drawing.coordinates.length >= 2) {
    const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = drawing.coordinates;
    const west = Math.min(firstLongitude, secondLongitude);
    const east = Math.max(firstLongitude, secondLongitude);
    const south = Math.min(firstLatitude, secondLatitude);
    const north = Math.max(firstLatitude, secondLatitude);
    features.push({
      type: "Feature",
      properties: {kind: "area"},
      geometry: {
        type: "Polygon",
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
      }
    });
  }
  map.addSource(sourceId, {type: "geojson", data: {type: "FeatureCollection", features}});
  map.addLayer({id: layerIds[0], type: "fill", source: sourceId, filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#f59e0b", "fill-opacity": 0.24}});
  map.addLayer({id: layerIds[1], type: "line", source: sourceId, filter: ["!=", ["geometry-type"], "Point"], paint: {"line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 1]}});
  map.addLayer({id: layerIds[2], type: "circle", source: sourceId, filter: ["==", ["geometry-type"], "Point"], paint: {"circle-color": "#fff7ed", "circle-radius": 6, "circle-stroke-color": "#d97706", "circle-stroke-width": 3}});
}

function toolbarMenus(context) {
  const {state} = context;
  const menus = [
    {
      id: "project",
      label: "Project",
      sections: projectMenuSections(context)
    },
    {
      id: "edit",
      label: "Edit",
      sections: [
        [
          menuAction("Draw point on map", () => beginMapAuthoring(context, "Point")),
          menuAction("Draw path on map", () => beginMapAuthoring(context, "LineString")),
          menuAction("Draw polygon on map", () => beginMapAuthoring(context, "Polygon")),
          menuAction("Place image overlay on map", () => chooseImageOverlay(context)),
          menuAction("Draw image overlay extent", () => beginMapAuthoring(context, "image-overlay")),
          menuAction("Temporary annotations and uploads…", () => openTemporaryWorkPanel(context)),
          menuAction("Duplicate active layer", () => duplicateActiveLayer(context)),
          menuAction("Remove active layer from project", () => removeLayer(context), {shortcut: "Del"})
        ],
        [
          menuAction("Clear map filters", () => clearAllFilters(context)),
          menuAction("Reset layer styling", () => resetActiveStyle(context))
        ]
      ]
    },
    {
      id: "view",
      label: "View",
      sections: [
        [
          menuAction("Zoom in", () => state.map?.zoomIn(), {shortcut: "+"}),
          menuAction("Zoom out", () => state.map?.zoomOut(), {shortcut: "-"}),
          menuAction("Fit visible layers", () => fitVisibleLayers(state.map, context.layers, context.dataByLayerId)),
          menuAction("Fit active layer", () => fitLayer(state.map, activeLayer(context), context.dataByLayerId))
        ],
        [
          menuAction(state.globe ? "Use Mercator projection" : "Use globe projection", () => toggleProjection(context)),
          menuAction("Change basemap", () => openBasemapChooser(context)),
          menuAction("Rendering engine…", () => {
            state.activePanel = "renderer"; state.rightOpen = true; context.render();
          }),
          menuAction("Analysis console", () => toggleAnalysisConsole(context), {shortcut: "Ctrl+`"}),
          menuAction(state.mapOnly ? "Show panels and tools" : "Map only", () => setMapOnly(context, !state.mapOnly)),
          menuAction("Camera tour", () => openCameraTourPanel(context)),
          menuAction("Flight simulator", () => openFlightSimulatorPanel(context), {
            disabled: state.spatialBody.id !== "earth",
            title: state.spatialBody.id === "earth" ? "Open flight simulator" : "Flight simulator is available for Earth projects"
          }),
          menuAction("Reset north and pitch", () => resetViewBearing(state)),
          menuAction(state.leftOpen ? "Hide layer panel" : "Show layer panel", () => {
            state.leftOpen = !state.leftOpen;
            setStatus(context, state.leftOpen ? "Layer panel shown." : "Layer panel hidden.");
          }),
          menuAction(state.rightOpen ? "Hide inspector" : "Show inspector", () => {
            state.rightOpen = !state.rightOpen;
            setStatus(context, state.rightOpen ? "Inspector shown." : "Inspector hidden.");
          })
        ]
      ]
    },
    {
      id: "layer",
      label: "Layer",
      sections: [
        [
          menuAction("Add data…", () => {
            state.activePanel = "add";
            state.rightOpen = true;
            setStatus(context, "Add data opened.");
          }, {shortcut: "Ctrl+Shift+D"}),
          menuAction("Draw point", () => beginMapAuthoring(context, "Point")),
          menuAction("Draw path", () => beginMapAuthoring(context, "LineString")),
          menuAction("Draw polygon", () => beginMapAuthoring(context, "Polygon")),
          menuAction("Add local vector layer", () => openAddSource(context, "vector")),
          menuAction("Add PMTiles vector layer", () => openAddSource(context, "pmtiles")),
          menuAction("Add XYZ tile layer", () => openAddSource(context, "xyz"))
        ],
        [
          menuAction("Open attribute table", () => {
            state.activePanel = "attributes";
            state.rightOpen = true;
            setStatus(context, "Attribute table opened.");
          }, {shortcut: "F6"}),
          menuAction("Query features…", () => openFeatureQueryPanel(context)),
          menuAction("Layer properties", () => {
            state.activePanel = "style";
            state.rightOpen = true;
            setStatus(context, "Layer properties opened.");
          }),
          ...(activeLayer(context)?.sourceType === "cog-raster" ? [
            menuAction("Refresh raster window", () => refreshCogWindow(context, activeLayer(context)))
          ] : []),
          ...projectManagementActions(context, activeLayer(context)),
          menuAction("Zoom to layer", () => fitLayer(state.map, activeLayer(context), context.dataByLayerId)),
          menuAction("Show selected layer", () => {
            const layer = activeLayer(context);
            if (layer) setLayerVisible(context, layer, true);
            context.render();
          }),
          menuAction("Hide selected layer", () => {
            const layer = activeLayer(context);
            if (layer) setLayerVisible(context, layer, false);
            context.render();
          })
        ],
        [
          menuAction("Copy style", () => copyActiveStyle(context)),
          menuAction("Paste style", () => pasteActiveStyle(context)),
          menuAction("Reset style", () => resetActiveStyle(context)),
          menuAction("Remove layer", () => removeLayer(context), {shortcut: "Ctrl+D"})
        ]
      ]
    },
    {
      id: "add",
      label: "Add Data",
      sections: ADD_DATA_SOURCES.map(({section, sources}) => [
        menuLabel(section),
        ...sources.map(([id, label]) => menuAction(label, () => {
          openAddSource(context, id);
        }))
      ])
    },
    {
      id: "processing",
      label: "Processing",
      sections: [[menuAction("Analysis console…", () => toggleAnalysisConsole(context)),
        menuAction("Project processing jobs", () => openProjectCatalog(context))], ...groupedTools().map(([category, tools]) => [
        menuLabel(category),
        ...tools.map((tool) => menuAction(`${tool.title} (${tool.engine})`, () => {
          if (isMobileWorkbenchViewport()) state.leftOpen = false;
          state.activeToolId = tool.id;
          state.activePanel = tool.id === "sql-workspace" ? "sql" : "processing";
          state.rightOpen = true;
          setStatus(context, `${tool.title} selected.`);
        }))
      ])]
    },
    {
      id: "controls",
      label: "Controls",
      sections: [
        [
          menuAction(state.mapOnly || !state.mapControlsOpen ? "Show map controls" : "Hide map controls", () => {
            state.mapControlsOpen = state.mapOnly || !state.mapControlsOpen;
            state.mapOnly = false;
            context.render();
          }),
          menuAction(state.mapOnly ? "Show panels and tools" : "Map only", () => setMapOnly(context, !state.mapOnly))
        ],
        [
          menuAction(state.identify ? "Disable identify" : "Enable identify", () => {
            state.identify = !state.identify;
            setStatus(context, state.identify ? "Identify enabled." : "Identify disabled.");
          }),
          menuAction("Measure line", () => beginMeasurement(context, "line")),
          menuAction("Measure path and elevation", () => beginMeasurement(context, "path")),
          menuAction("Measure polygon area", () => beginMeasurement(context, "polygon")),
          menuAction("Measure circle area", () => beginMeasurement(context, "circle")),
          menuAction("Imagery history", () => openHistoricalImageryPanel(context)),
          menuAction("Camera tour", () => openCameraTourPanel(context)),
          menuAction("Flight simulator", () => openFlightSimulatorPanel(context), {
            disabled: state.spatialBody.id !== "earth",
            title: state.spatialBody.id === "earth" ? "Open flight simulator" : "Flight simulator is available for Earth projects"
          }),
          menuAction(state.graticule ? "Hide graticule" : "Show graticule", () => {
            state.graticule = !state.graticule;
            setStatus(context, state.graticule ? "Graticule enabled." : "Graticule hidden.");
          })
        ],
        [
          menuAction("Open style inspector", () => state.activePanel = "style"),
          menuAction("Open attribute table", () => state.activePanel = "attributes"),
          menuAction("Open controls panel", () => state.activePanel = "controls")
        ]
      ]
    },
    {
      id: "plugins",
      label: "Plugins",
      sections: [
        PLUGINS.map(([id, label]) => menuAction(id === "time" ? "Open imagery history" : `${state.pluginState.has(id) ? "Disable" : "Enable"} ${label}`, () => {
          togglePlugin(context, id);
        }))
      ]
    },
    {
      id: "settings",
      label: "Settings",
      sections: [
        [
          menuAction("Theme: automatic", () => {
            saveWorkbenchColorMode("auto");
            state.colorMode = preferredWorkbenchColorMode();
            setStatus(context, "Theme follows the browser color scheme.");
          }),
          menuAction("Theme: dark", () => {
            state.colorMode = "dark";
            saveWorkbenchColorMode("dark");
            setStatus(context, "Dark app theme.");
          }),
          menuAction("Theme: light", () => {
            state.colorMode = "light";
            saveWorkbenchColorMode("light");
            setStatus(context, "Light app theme.");
          })
        ],
        [
          ...(context.landingMode ? [menuAction("Welcome screen and startup", () => {
            context.shell.dispatchEvent(new Event("workbench:welcome"));
          })] : []),
          menuAction(context.landingMode ? "Browser draft and account storage" : context.demoSurface ? "Demo privacy and storage" : "Project storage settings", () => {
            state.activePanel = "settings";
            setStatus(context, context.demoSurface ? "Demo privacy and browser-only storage opened." : "Project storage settings opened.");
          })
        ]
      ]
    },
    {
      id: "help",
      label: "Help",
      sections: [
        [
          menuAction("Keyboard shortcuts", () => {
            state.activePanel = "help";
            setStatus(context, "Keyboard shortcuts panel opened.");
          }),
          menuAction("About OpenGeo Studio", () => {
            state.activePanel = "help";
            setStatus(context, context.demoSurface
              ? "This public workbench demonstrates browser-native OpenGeo Studio GIS workflows without private data or credentials."
              : "OpenGeo Studio keeps desktop GIS-style workflows in a browser-native AWS workspace.");
          })
        ]
      ]
    }
  ];
  const compactSections = menus
    .filter(({id}) => !["project", "layer"].includes(id))
    .flatMap((menu) => [[menuLabel(menu.label)], ...menu.sections]);
  return [...menus, {
    id: "more",
    label: "More",
    sections: compactSections
  }];
}

function projectManagementActions(context, layer = null) {
  if (context.landingMode || context.publicDemo || !context.workspace?.workspaceId) return [];
  const actions = layer
    ? [["data", "Layer data and metadata"], ["resources", "Metadata, citations and saved styles"], ["services", "Layer services and publishing"]]
    : [["data", "Manage project data"], ["resources", "Metadata, citations and saved styles"], ["services", "Manage map services"], ["publishing", "Stories and site publishing"], ["print", "Open Print Studio"]];
  return actions.map(([management, label]) => menuAction(label, () => {
    if (saveLocalDraft(context) !== true) {
      context.render();
      return;
    }
    location.href = management === "print" && context.savedProjectOrigin?.id
      ? compositionHref(context.savedProjectOrigin.id, {
        adapterKind: fixtureAdapterKind(context.persistenceMode), management: "print"
      })
      : projectHref(context.workspace.workspaceId, {
      adapterKind: fixtureAdapterKind(context.persistenceMode),
      management,
      datasetId: layer?.datasetId
    });
  }, {title: management === "print" ? "Open Print Studio for this saved Project." : "Open the project's management workspace."}));
}

function projectMenuSections(context) {
  const {state, layouts, publicDemo} = context;
  if (context.printFrame) return [[menuAction("Export interactive map…", () => exportInteractiveMap(context, "offline"))]];
  const openCatalog = () => {
    if (publicDemo) { state.activePanel = "catalog"; state.rightOpen = true; context.render(); }
    else location.href = directoryHref({view: "data", adapterKind: fixtureAdapterKind(context.persistenceMode)});
  };
  if (publicDemo) {
    return [
      [
        ...(context.demoSurface ? [
          menuAction("Demo home", () => location.href = "/", {shortcut: "Home"}),
          menuAction("Sample datasets", () => location.href = "/?view=examples", {shortcut: "Ctrl+O"})
        ] : [
          menuAction("Open application home", () => location.href = "/", {shortcut: "Home"}),
          menuAction("Browse projects", () => location.href = "/workspaces", {shortcut: "Ctrl+O"})
        ]),
        menuAction(context.demoSurface ? "Open demo data catalog" : "Open data catalog", openCatalog, {shortcut: "Ctrl+L"})
      ],
      [
        menuAction(context.demoSurface ? "New empty demo map" : "New empty map", () => newWorkspaceProject(context)),
        menuAction("Save on this device", () => void savePersonalProject(context), {shortcut: "Ctrl+S"}),
        menuAction("Save a personal copy…", () => void savePersonalProject(context, {copy: true})),
        menuAction("Projects on this device", () => void openPersonalProjects(context)),
        ...(context.demoSurface ? [menuAction("Reset public demo", () => resetPublicDemo(context), {disabled: Boolean(context.localProjectRecord)})] : []),
        menuAction("Open Project file…", () => openProjectFile(context), {shortcut: "Ctrl+O"}),
        menuAction("Save as / export…", () => openProjectExportDialog(context)),
        menuAction("Publish with OpenGeo…", () => exportInteractiveMap(context, "offline", "publication")),
        menuAction(context.localProjectRecord ? "Export or publish Project…" : "Share current link", () => context.localProjectRecord ? openProjectExportDialog(context) : shareCurrentLink(context))
      ],
      [
        menuAction("Open Print Studio", () => void openBrowserPrintStudio(context), {disabled: context.printFrame}),
        ...(context.demoSurface ? [menuAction("About demo privacy", () => {
          state.activePanel = "settings";
          state.rightOpen = true;
          setStatus(context, "Demo privacy and browser-only storage opened.");
        })] : [])
      ]
    ];
  }
  return [
    [
      menuAction("Open application home", () => location.href = "/", {shortcut: "Home"}),
      menuAction("Browse projects", () => location.href = "/workspaces", {shortcut: "Ctrl+O"}),
      menuAction("Open data catalog", openCatalog, {shortcut: "Ctrl+L"}),
      menuAction("Style library", () => location.href = directoryHref({view: "styles", adapterKind: fixtureAdapterKind(context.persistenceMode)}))
    ],
    [
      menuAction("Create new project", () => location.href = "/workspaces?new=1"),
      menuAction("Open Project file…", () => openProjectFile(context), {shortcut: "Ctrl+O"}),
      menuAction("Save as / export…", () => openProjectExportDialog(context), {shortcut: "Ctrl+Shift+S"}),
      menuAction("Save to browser draft", () => saveLocalDraft(context), {shortcut: "Ctrl+S"}),
      menuAction("Save authoritative map", () => void saveAuthoritativeProject(context), {shortcut: "API"}),
      menuAction("Share current link", () => shareCurrentLink(context))
    ],
    [
      menuAction(layouts[0] ? "Open print layout" : "Print current view", () => {
        if (context.savedProjectOrigin?.id) {
          if (saveLocalDraft(context) !== true) { context.render(); return; }
          location.href = compositionHref(context.savedProjectOrigin.id, {
            adapterKind: fixtureAdapterKind(context.persistenceMode), management: "print"
          });
          return;
        }
        if (layouts[0]) {
          location.href = `/print/${layouts[0].layoutId}`;
          return;
        }
        window.print();
        setStatus(context, "Printing the current map view.");
      }),
      menuAction("Export offline vector map…", () => exportInteractiveMap(context, "offline")),
      menuAction("Workspace records and data", openCatalog),
      ...projectManagementActions(context)
    ]
  ];
}

async function savePersonalProject(context, {copy = false, quiet = false} = {}) {
  if (!context.publicDemo || context.printFrame || context.disposed || context.localSaveBusy) return false;
  const origin = context.project;context.localSaveBusy = true;context.render();
  try {
    let title = context.localProjectRecord?.title;
    if (!title || copy) title = await personalProjectTitle(context, context.project.title ?? "My map");
    if (!title || context.disposed || context.project !== origin) return false;
    const snapshot = {...createLocalDraft(context), title};
    const data = structuredClone(context.dataByLayerId);
    const {LocalProjectStore} = await import("../lib/localProjectStore.js");
    if (context.disposed || context.project !== origin) return false;
    const current = copy ? null : context.localProjectRecord;
    const record = await new LocalProjectStore({catalog: context.browserCatalog}).save({
      ...(current ? {id: current.id, expectedRevision: current.revision} : {}), title, definition: snapshot, geojsonByLayerId: data});
    if (context.disposed || context.project !== origin) return record;
    context.project.title = title;context.localProjectRecord = record;
    context.localDraftBaseline = localDraftSignature(context, snapshot);
    const url = new URL(location.href);url.searchParams.set("localProject", record.id);history.replaceState(null, "", url);
    context.onLocalProjectLoaded?.(record);
    if (!quiet) setStatus(context, localDraftSignature(context) === context.localDraftBaseline
      ? `Saved on this device · revision ${record.revision}. Download a backup from On this device.`
      : "Project snapshot saved on this device. Newer map edits remain unsaved.");
    return record;
  } catch (error) {if (!context.disposed) setStatus(context, `${error.message} Export the current map to keep a backup.`);return false;}
  finally {context.localSaveBusy = false;if (!context.disposed) context.render();}
}

function personalProjectTitle(context, initial) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");dialog.className = "browser-print-studio local-project-title";
    dialog.dataset.colorMode = context.state.colorMode;dialog.setAttribute("aria-label", "Save personal Project");
    const input = document.createElement("input");input.type = "text";input.maxLength = 200;input.value = initial;input.setAttribute("aria-label", "Personal Project title");
    const finish = value => {dialog.close?.();dialog.remove();context.localProjectDialog = null;resolve(value);};
    dialog.dispose = () => finish(null);
    dialog.append(textElement("h2", "Save on this device"), textElement("p", "Keep a personal Project separate from samples. No account or upload is needed. Browser data can be cleared; download a backup for important work."), input,
      actionButton("Cancel", () => finish(null)), actionButton("Save Project", () => {if (input.value.trim()) finish(input.value.trim());else input.focus();}));
    dialog.addEventListener("cancel", event => {event.preventDefault();finish(null);});
    context.localProjectDialog = dialog;document.body.append(dialog);dialog.showModal?.();if (!dialog.open) dialog.open = true;input.focus();input.select();
  });
}

async function openPersonalProjects(context) {
  if (context.disposed || context.localSaveBusy || context.printFrame) return;
  if (context.localProjectDialog?.isConnected) {context.localProjectDialog.focus();return;}
  try {
    const [{LocalProjectLibrary}, {LocalProjectStore}] = await Promise.all([import("./LocalProjectLibrary.js"), import("../lib/localProjectStore.js")]);
    if (context.disposed || !context.shell.isConnected) return;
    const dialog = LocalProjectLibrary({store: new LocalProjectStore({catalog: context.browserCatalog}),
      beforeOpen: () => !context.localSaveBusy && localDraftSignature(context) === context.localDraftBaseline,
      onClose: () => {context.localProjectDialog = null;}});
    dialog.dataset.colorMode = context.state.colorMode;context.localProjectDialog = dialog;
    document.body.append(dialog);dialog.showModal?.();if (!dialog.open) dialog.open = true;
  } catch (error) {if (!context.disposed) setStatus(context, error.message);}
}

async function openBrowserPrintStudio(context) {
  if (!context.publicDemo || context.printFrame || context.disposed || context.browserPrintOpening) return;
  if (context.browserPrintStudio?.isConnected) {context.browserPrintStudio.focus();return;}
  if (context.state.mapAuthoring || context.state.authoringCoordinateDraft) {
    setStatus(context, "Finish or cancel the current drawing before opening Print Studio.");return;
  }
  const sourceProject = context.project;
  context.browserPrintOpening = true;
  try {
    const {BrowserPrintStudio} = await import("./BrowserPrintStudio.js");
    if (context.disposed || !context.shell.isConnected || context.project !== sourceProject) return;
    const definition = createLocalDraft(context);
    const projectId = definition.extensions?.opengeoPrintLayouts?.projectId ?? `browser-${crypto.randomUUID()}`;
    const data = structuredClone(context.dataByLayerId);
    const dialog = BrowserPrintStudio({definition, projectId, name: definition.title ?? "Local map",
      createWorkbench: snapshot => WorkbenchView({
        workspace: context.workspace, workspaces: [context.workspace], role: "local", project: snapshot,
        layers: snapshot.layers, geojsonByLayerId: structuredClone(data),
        mapFontAttachments: context.mapFontAttachments, rendererAdapter: context.rendererAdapter,
        browserCatalog: context.browserCatalog, registerSource: context.registerSource,
        publicDemo: true, demoSurface: context.demoSurface, landingMode: context.landingMode, printFrame: true,
        persistenceMode: "local", restoreBrowserDraft: false,
        draftScopeId: `print-${projectId}`
      }),
      saveDefinition: async saved => {
        if (context.disposed || !context.shell.isConnected || context.project !== sourceProject) {
          throw Object.assign(Error("The browser Project changed."), {status: 409});
        }
        const layouts = projectPrintLayouts({id: projectId, definition: saved});
        // Only layout metadata returns to the map; Print edits cannot replace its Layers or data.
        projectPrintLayouts({id: projectId, definition: {...currentProjectDefinition(context),
          extensions: {opengeoPrintLayouts: layouts}}});
        const previous = context.project.extensions;
        context.project.extensions = {...previous, opengeoPrintLayouts: layouts};
        if (context.localProjectRecord ? !await savePersonalProject(context, {quiet: true}) : saveLocalDraft(context) !== true) {
          context.project.extensions = previous;
          throw Error("The browser could not save the layout. Download its JSON before leaving Print Studio.");
        }
      },
      onClose: () => {context.browserPrintStudio = null;context.shell.querySelector('.gis-menu-wrap[data-menu="project"] > button')?.focus();}
    });
    dialog.dataset.colorMode = context.state.colorMode;
    context.browserPrintStudio = dialog;
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();else dialog.open = true;
    setStatus(context, "Local Print Studio opened. Layouts and exports use this browser; no hosted Project is required.");
    context.render();
  } catch (error) {
    context.browserPrintStudio?.dispose?.();context.browserPrintStudio = null;
    setStatus(context, `Print Studio could not open: ${error.message}`);
  } finally {context.browserPrintOpening = false;}
}

function menuButton(menu, context) {
  const {state} = context;
  const wrapper = document.createElement("div");
  wrapper.className = "gis-menu-wrap";
  wrapper.dataset.menu = menu.id;

  const button = actionButton(menu.label, () => {
    state.activeMenu = state.activeMenu === menu.id ? null : menu.id;
    context.render();
  });
  button.classList.add("gis-menu-button");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", state.activeMenu === menu.id ? "true" : "false");
  button.classList.toggle("active", state.activeMenu === menu.id);
  wrapper.append(button);

  if (state.activeMenu === menu.id) {
    const dropdown = document.createElement("div");
    dropdown.className = "gis-menu-dropdown";
    dropdown.role = "menu";
    dropdown.append(textElement("strong", menu.label));
    for (const section of menu.sections) {
      const group = document.createElement("div");
      group.className = "gis-menu-section";
      for (const item of section) group.append(item.render(context));
      dropdown.append(group);
    }
    wrapper.append(dropdown);
  }

  return wrapper;
}

function menuAction(label, action, {shortcut = "", disabled = false, title = ""} = {}) {
  return {
    render(context) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gis-menu-item";
      button.role = "menuitem";
      button.disabled = disabled;
      if (title) button.title = title;
      button.append(textElement("span", label));
      if (shortcut) {
        const hint = textElement("kbd", shortcut);
        button.append(hint);
      }
      button.addEventListener("click", () => {
        action();
        context.state.activeMenu = null;
        context.state.mobileCommandSheetOpen = false;
        context.state.mobileCommandReturnFocus = null;
        context.render();
      });
      return button;
    }
  };
}

function menuLabel(label) {
  return {
    render() {
      const element = textElement("span", label);
      element.className = "gis-menu-label";
      return element;
    }
  };
}

function groupedTools() {
  const groups = new Map();
  for (const tool of PROCESSING_TOOLS) {
    if (!groups.has(tool.category)) groups.set(tool.category, []);
    groups.get(tool.category).push(tool);
  }
  return [...groups];
}

function renderLeftPanel(panel, context) {
  if(context.rendererAdapter.id !== "cesium") syncFeatureHalo(context);
  panel.replaceChildren();

  const header = document.createElement("div");
  header.className = "gis-panel-header gis-left-panel-header";
  header.append(textElement("h2", "Layers"));
  const controls = document.createElement("div");
  controls.className = "gis-left-panel-controls";
  controls.append(layerToolbar(context));
  const close = svgIconButton("Close project contents", "panel-close", () => {
    context.state.leftOpen = false;
    context.render();
  });
  close.classList.add("gis-left-panel-close");
  controls.append(close);
  header.append(controls);

  panel.append(header, layerDock(context));
}

function kmlLayerEditor(context) {
  const {state} = context;
  const dock = document.createElement("section");
  dock.className = "gis-kml-layer-editor";
  const heading = document.createElement("div");
  heading.className = "gis-dock-heading";
  heading.append(textElement("h3", "KML/KMZ layer content"));
  dock.append(heading);

  if (!state.kmlPlaces) {
    dock.append(
      textElement("p", "No KML/KMZ source is attached. Import one from Add data."),
      actionButton("Import KML or KMZ", () => openAddSource(context, "vector")),
      actionButton("Create KML layer", () => {
        state.kmlInterchangeReport = emptyKmlReport();
        applyKmlPlacesDocument(context, createPlacesDocument(), "Created a new bounded KML layer.");
      })
    );
    return dock;
  }

  const counts = countPlaces(state.kmlPlaces);
  dock.dataset.folders = String(counts.folders);
  dock.dataset.placemarks = String(counts.placemarks);
  dock.dataset.overlays = String(counts.overlays);
  dock.dataset.networkLinks = String(counts.networkLinks);
  dock.dataset.linkedFeatures = String(linkedNetworkLinkFeatureCount(state));
  dock.dataset.losses = String(state.kmlInterchangeReport?.counts?.omitted ?? 0);
  dock.dataset.sharedStyles = String(state.kmlPlaces.styles?.length ?? 0);
  dock.dataset.schemas = String(state.kmlPlaces.schemas?.length ?? 0);
  dock.dataset.resources = String(state.kmlPlaces.resources?.length ?? 0);
  dock.dataset.resourceBytes = String(kmlResourceBytes(state.kmlPlaces));
  dock.append(compactKeyValues({
    "Document": state.kmlPlaces.name,
    "Folders": counts.folders,
    "Placemarks": counts.placemarks,
    "Image overlays": counts.overlays,
    "Network links": counts.networkLinks,
    "Linked map features": linkedNetworkLinkFeatureCount(state),
    "Shared styles": state.kmlPlaces.styles?.length ?? 0,
    "Typed schemas": state.kmlPlaces.schemas?.length ?? 0,
    "KMZ resources": state.kmlPlaces.resources?.length ?? 0,
    "Opaque resource bytes": kmlResourceBytes(state.kmlPlaces),
    "Import result": state.kmlInterchangeReport?.result ?? "restored supported model",
    "Declared losses": state.kmlInterchangeReport?.counts?.omitted ?? 0
  }));

  const actions = document.createElement("div");
  actions.className = "gis-action-grid";
  actions.append(
    actionButton("Download KML", () => downloadBlob(
      `${slug(state.kmlPlaces.name)}.kml`,
      exportKml(state.kmlPlaces),
      "application/vnd.google-earth.kml+xml"
    )),
    actionButton("Download KMZ", () => downloadBlob(
      `${slug(state.kmlPlaces.name)}.kmz`,
      exportKmz(state.kmlPlaces),
      "application/vnd.google-earth.kmz"
    )),
    actionButton("Download KML loss report", () => downloadBlob(
      `${slug(state.kmlPlaces.name)}-kml-loss-report.json`,
      JSON.stringify(state.kmlInterchangeReport ?? {result: "restored", counts: {}, entries: []}, null, 2),
      "application/json"
    ))
  );
  dock.append(actions);
  dock.append(kmlPlaceCreator(context));
  dock.append(kmlOverlayCreator(context));

  const tree = document.createElement("ul");
  tree.className = "gis-places-tree";
  tree.role = "tree";
  tree.setAttribute("aria-label", "KML layer hierarchy");
  appendPlaceNodes(tree, state.kmlPlaces.children, context);
  dock.append(tree);
  const selected = findKmlPlaceForUi(state.kmlPlaces, state.selectedKmlPlaceId);
  if (selected) dock.append(kmlPlaceEditor(context, selected));
  return dock;
}

function appendPlaceNodes(parent, children, context) {
  for (const child of children ?? []) {
    const item = document.createElement("li");
    item.dataset.placeKind = child.kind;
    item.dataset.placeId = child.id;
    item.classList.toggle("selected", context.state.selectedKmlPlaceId === child.id);
    if (child.kind === "folder") {
      const details = document.createElement("details");
      details.open = child.open === true;
      const summary = document.createElement("summary");
      summary.textContent = child.name;
      details.append(summary);
      details.append(actionButton(`Edit ${child.name}`, () => {
        context.state.selectedKmlPlaceId = child.id;
        context.render();
      }));
      const nested = document.createElement("ul");
      appendPlaceNodes(nested, child.children, context);
      details.append(nested);
      item.append(details);
    } else {
      const row = document.createElement("div");
      row.className = "gis-place-row";
      const hasMapFeature = child.geometry || ["ground-overlay", "photo-overlay"].includes(child.kind);
      const fly = actionButton(child.name, () => zoomToKmlPlace(context, child));
      fly.disabled = !hasMapFeature;
      fly.setAttribute("aria-label", hasMapFeature
        ? `Fly to ${child.name}`
        : child.kind === "network-link"
          ? `${child.name} is a governed NetworkLink; use its connection panel to refresh`
          : `${child.name} is a screen overlay`);
      const edit = actionButton(`Edit ${child.name}`, () => {
        context.state.selectedKmlPlaceId = child.id;
        context.render();
      });
      row.append(fly, edit);
      item.append(row);
    }
    parent.append(item);
  }
}

function kmlPlaceCreator(context) {
  const details = document.createElement("details");
  details.className = "gis-places-authoring gis-place-authoring";
  details.dataset.authoring = "place";
  const requestedKind = ["Point", "LineString", "Polygon"].includes(context.state.primaryAuthoringKind)
    ? context.state.primaryAuthoringKind
    : "Point";
  details.open = ["Point", "LineString", "Polygon"].includes(context.state.primaryAuthoringKind);
  const summary = document.createElement("summary");
  summary.textContent = "Create place or folder";
  details.append(summary);
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const name = textInput("Name", "New place");
  name.input.dataset.kmlAuthoringField = "name";
  const kind = selectInput("Kind", requestedKind, [
    ["Point", "Placemark point"],
    ["LineString", "Placemark path"],
    ["Polygon", "Placemark polygon"],
    ["folder", "Folder"]
  ]);
  kind.input.dataset.kmlAuthoringField = "kind";
  const parent = selectInput("Parent", context.state.kmlPlaces.id, kmlContainerOptions(context.state.kmlPlaces));
  parent.input.dataset.kmlAuthoringField = "parent";
  const coordinates = textAreaInput(
    "Coordinates",
    authoringCoordinateTemplate(context, requestedKind),
    "lon,lat[,alt] separated by spaces"
  );
  coordinates.input.dataset.kmlAuthoringField = "coordinates";
  const altitude = selectInput("Altitude mode", "clampToGround", [
    ["clampToGround", "Clamp to ground"],
    ["relativeToGround", "Relative to ground"],
    ["absolute", "Absolute"]
  ]);
  altitude.input.dataset.kmlAuthoringField = "altitude";
  const color = textInput("KML color (aabbggrr)", "ff00a5f5");
  color.input.dataset.kmlAuthoringField = "color";
  const create = actionButton("Add to KML layer", () => {
    try {
      const requestedKind = kind.input.value;
      const value = requestedKind === "folder"
        ? {kind: "folder", name: name.input.value}
        : {
            kind: "placemark",
            name: name.input.value,
            geometry: parseAuthoringGeometry(requestedKind, coordinates.input.value),
            altitudeMode: altitude.input.value,
            tessellate: requestedKind !== "Point",
            style: defaultAuthoredKmlStyle(requestedKind, color.input.value)
          };
      const next = addKmlPlace(context.state.kmlPlaces, parent.input.value, value);
      const created = findNewestKmlPlace(context.state.kmlPlaces, next);
      context.state.selectedKmlPlaceId = created?.id ?? null;
      context.state.mapAuthoringCreatedKmlPlaces = false;
      context.state.primaryAuthoringKind = null;
      context.state.authoringCoordinateDraft = null;
      applyKmlPlacesDocument(context, next, `Added ${name.input.value || "feature"} to the KML layer.`);
    } catch (error) {
      setStatus(context, `Place creation failed safely (${error?.code ?? "invalid_place"}).`);
    }
  });
  create.dataset.kmlAuthoringAction = "create";
  form.append(name.wrapper, kind.wrapper, parent.wrapper, coordinates.wrapper, altitude.wrapper, color.wrapper, create);
  details.append(form);
  return details;
}

function kmlPlaceEditor(context, selected) {
  const drafts = context.state.kmlMetadataDrafts ??= new Map();
  const draft = drafts.get(selected.id);
  const details = document.createElement("details");
  details.className = "gis-places-authoring gis-places-editor";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = `Edit ${selected.name}`;
  details.append(summary);
  if (selected.kind === "placemark" && selected.geometry) {
    details.append(actionButton("Edit shape on map", () => editKmlShape(context, selected.id)));
  }
  if (String(selected.kind).endsWith("-overlay")) {
    if (selected.kind === "ground-overlay") {
      details.append(actionButton("Adjust image on map", () => editImageOverlay(context, selected.id)));
    }
    const resource = context.state.kmlPlaces.resources?.find(({path}) => path === selected.icon?.href);
    details.append(compactKeyValues({
      "Overlay kind": selected.kind,
      "Resource": selected.icon?.href ?? "missing",
      "Region/LOD": selected.region ? `${selected.region.lod.minPixels}…${selected.region.lod.maxPixels}` : "always",
      "Rendering": selected.kind === "photo-overlay" ? "bounded static preview anchor" : "local image"
    }));
    if (resource) {
      const preview = document.createElement("img");
      preview.className = "gis-kml-overlay-preview";
      preview.alt = `${selected.name} preview`;
      preview.src = `data:${resource.mediaType};base64,${resource.dataBase64}`;
      details.append(preview);
    }
  }
  if (selected.kind === "network-link") details.append(kmlNetworkLinkPanel(context, selected));
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const name = textInput("Name", draft?.name ?? selected.name);
  name.input.dataset.kmlEditingField = "name";
  const description = textAreaInput("Description", draft?.description ?? selected.description ?? "", "Optional plain-text description");
  const visible = checkField("Visible", draft?.visibility ?? selected.visibility !== false, () => {});
  visible.querySelector("input").dataset.kmlEditingField = "visibility";
  const currentParent = findKmlParentForUi(context.state.kmlPlaces, selected.id)?.id ?? context.state.kmlPlaces.id;
  const parent = selectInput("Parent", draft?.parent ?? currentParent, kmlContainerOptions(context.state.kmlPlaces, selected.kind === "folder" ? selected.id : null));
  parent.input.dataset.kmlEditingField = "parent";
  const remember = () => drafts.set(selected.id, {name: name.input.value, description: description.input.value, visibility: visible.querySelector("input").checked, parent: parent.input.value});
  form.addEventListener("input", remember);
  form.addEventListener("change", remember);
  const save = actionButton("Apply place edits", () => {
    try {
      let next = updateKmlPlace(context.state.kmlPlaces, selected.id, {
        name: name.input.value,
        description: description.input.value,
        visibility: visible.querySelector("input").checked
      });
      const nextParent = parent.input.value;
      if (nextParent !== currentParent) next = moveKmlPlace(next, selected.id, nextParent);
      drafts.delete(selected.id);
      applyKmlPlacesDocument(context, next, `Updated ${name.input.value || selected.name}.`);
    } catch (error) {
      setStatus(context, `Place edit failed safely (${error?.code ?? "invalid_place"}).`);
    }
  });
  save.dataset.kmlAuthoringAction = "update";
  const remove = actionButton("Delete selected place", () => {
    if (typeof confirm === "function" && !confirm(`Delete ${selected.name} and any nested places?`)) return;
    try {
      const next = removeKmlPlace(context.state.kmlPlaces, selected.id);
      closeShapeEditor(context);
      closeImageOverlayEditor(context);
      drafts.delete(selected.id);
      context.state.selectedKmlPlaceId = null;
      applyKmlPlacesDocument(context, next, `Deleted ${selected.name} from the KML layer.`);
    } catch (error) {
      setStatus(context, `Place deletion failed safely (${error?.code ?? "invalid_place"}).`);
    }
  });
  remove.dataset.kmlAuthoringAction = "delete";
  form.append(name.wrapper, description.wrapper, visible, parent.wrapper, save, remove);
  details.append(form);
  return details;
}

function closeShapeEditor(context) {
  const editor = context.state.shapeEditor;
  context.state.shapeEditor = null;
  editor?.dispose();
}

function editKmlShape(context, id) {
  const selected = findKmlPlaceForUi(context.state.kmlPlaces, id);
  if (!selected?.geometry || !context.state.map) return;
  closeShapeEditor(context);
  closeImageOverlayEditor(context);
  cancelMapAuthoring(context, {render: false, announce: false});
  const preview = (geometry) => {
    const data = context.dataByLayerId.get(editingKmlLayerId(context));
    if (!data) return;
    const source = context.state.map?.getSource(context.state.layerHandles.get(editingKmlLayerId(context))?.sourceId);
    source?.setData({...data, features: data.features.map((feature) => String(feature.id) === String(id) ? {...feature, geometry} : feature)});
  };
  context.state.shapeEditor = {id, dispose: mountShapeEditor({
    map: context.state.map, geometry: selected.geometry,
    onPreview: preview,
    onCommit: (geometry) => applyKmlPlacesDocument(context, updateKmlPlace(context.state.kmlPlaces, id, {geometry}), "Shape updated. Save the project to retain it between sessions."),
    onClose: () => closeShapeEditor(context),
    onError: () => setStatus(context, "That vertex change could not be applied. The saved shape is unchanged.")
  })};
}

function kmlNetworkLinkPanel(context, selected) {
  const panel = document.createElement("section");
  panel.className = "gis-kml-network-link-panel";
  panel.dataset.kmlNetworkLink = selected.id;
  const approval = currentKmlNetworkLinkApproval(context.state, selected);
  const receipt = [...context.state.kmlNetworkLinkState.receipts].reverse().find(({linkId}) => linkId === selected.id) ?? null;
  const linked = context.state.kmlNetworkLinkDocuments.get(selected.id) ?? null;
  const inFlight = context.state.kmlNetworkLinkInFlight.has(selected.id);
  panel.dataset.authorization = approval ? "session-approved" : "required";
  panel.dataset.refreshState = inFlight ? "refreshing" : receipt ? "succeeded" : "idle";
  panel.append(
    textElement("h4", "Governed NetworkLink connection"),
    textElement("p", "Opening KML never authorizes networking. Approve this exact credential-free HTTPS target for the current session; the adapter must prove public-address DNS pinning, verified TLS, zero redirects, and bounded bytes."),
    compactKeyValues({
      "Target": selected.link.href,
      "Refresh": `${selected.link.refreshMode} · ${selected.link.refreshInterval}s`,
      "View refresh": `${selected.link.viewRefreshMode} · ${selected.link.viewRefreshTime}s`,
      "Authorization": approval ? `session only · expires ${approval.expiresAt}` : "required",
      "Adapter": typeof context.refreshKmlNetworkLink === "function" ? "governed adapter available" : "unavailable",
      "Last result": receipt ? `${receipt.status} · ${receipt.byteLength} bytes · ${receipt.fetchedAt}` : "not refreshed",
      "Linked content": linked ? `${placesToGeojson(linked.document).features.length} map features` : "not loaded",
      "Parse result": receipt?.content
        ? `${receipt.content.result} · ${receipt.content.declaredLossCount} declared losses`
        : "not parsed"
    })
  );
  const actions = document.createElement("div");
  actions.className = "gis-action-grid";
  const authorize = actionButton("Authorize exact link for this session", () => {
    try {
      const approvedAt = new Date();
      const expiresAt = new Date(approvedAt.getTime() + 15 * 60 * 1_000);
      context.state.kmlNetworkLinkApprovals.set(selected.id, authorizeKmlNetworkLink(selected.link, {
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      }));
      setStatus(context, `Authorized ${selected.name} for 15 minutes in this browser session. No credential was stored or sent.`);
      scheduleKmlNetworkLink(context, selected, "initial");
      context.render();
    } catch (error) {
      setStatus(context, `NetworkLink authorization failed safely (${error?.code ?? "invalid_network_link"}).`);
    }
  });
  authorize.dataset.kmlNetworkLinkAction = "authorize";
  authorize.disabled = typeof context.refreshKmlNetworkLink !== "function" || inFlight;
  const refreshReason = selected.link.viewRefreshMode === "onRequest" ? "view-request" : "manual";
  const refresh = actionButton("Refresh now", async () => refreshKmlNetworkLinkNow(context, selected, refreshReason));
  refresh.dataset.kmlNetworkLinkAction = "refresh";
  refresh.disabled = !approval || typeof context.refreshKmlNetworkLink !== "function" || inFlight;
  const cancel = actionButton("Cancel refresh", () => {
    const controller = context.state.kmlNetworkLinkInFlight.get(selected.id);
    controller?.abort();
  });
  cancel.dataset.kmlNetworkLinkAction = "cancel";
  cancel.disabled = !inFlight;
  actions.append(authorize, refresh, cancel);
  panel.append(actions);
  return panel;
}

async function refreshKmlNetworkLinkNow(context, selected, reason) {
  const epoch = context.state.kmlContextEpoch;
  const inFlight = context.state.kmlNetworkLinkInFlight;
  if (context.state.kmlNetworkLinkInFlight.has(selected.id)) return;
  if (context.state.kmlNetworkLinkInFlight.size >= KML_NETWORK_LINK_LIMITS.maximumConcurrentRequests) {
    setStatus(context, `${selected.name} refresh deferred: the four-request NetworkLink concurrency limit is active.`);
    return;
  }
  const approval = currentKmlNetworkLinkApproval(context.state, selected);
  const prior = [...context.state.kmlNetworkLinkState.receipts].reverse().find(({linkId}) => linkId === selected.id) ?? null;
  const linked = context.state.kmlNetworkLinkDocuments.get(selected.id) ?? null;
  const decision = kmlNetworkLinkRefreshDecision(selected.link, {
    lastSuccessAt: prior?.fetchedAt ?? null,
    expiresAt: prior?.expiresAt ?? null,
    contentAvailable: linked?.sourceHref === selected.link.href,
    inFlight: false
  }, {
    reason,
    now: new Date().toISOString(),
    ...(reason === "view-stop" ? {viewStoppedAt: new Date(Date.now() - selected.link.viewRefreshTime * 1_000).toISOString()} : {}),
    ...(reason === "region" ? {regionActive: true, previousRegionActive: false} : {})
  });
  if (!decision.due) return;
  const controller = new AbortController();
  try {
    const request = buildKmlNetworkLinkRequest(selected.link, approval, {
      linkId: selected.id,
      reason,
      now: new Date().toISOString(),
      view: kmlNetworkLinkView(context.state.map),
      etag: linked?.sourceHref === selected.link.href ? prior?.etag ?? null : null,
      lastModified: linked?.sourceHref === selected.link.href ? prior?.lastModified ?? null : null
    });
    context.state.kmlNetworkLinkRequestCount += 1;
    context.state.kmlNetworkLinkLastConditional = Boolean(request.conditional.etag || request.conditional.lastModified);
    context.state.kmlNetworkLinkInFlight.set(selected.id, controller);
    setStatus(context, `Refreshing ${selected.name} through the governed adapter…`);
    context.render();
    const rawReceipt = await executeKmlNetworkLinkRequest(context.refreshKmlNetworkLink, request, {controller});
    if (epoch !== context.state.kmlContextEpoch || controller.signal.aborted) return;
    const receipt = acceptKmlNetworkLinkReceipt(request, rawReceipt);
    let content = prior?.content ?? null;
    if (receipt.status === 200) {
      const parsed = await parseKmlNetworkLinkBody(receipt);
      if (epoch !== context.state.kmlContextEpoch || controller.signal.aborted) return;
      content = {
        result: parsed.report.result,
        featureCount: parsed.geojson.features.length,
        declaredLossCount: parsed.report.counts.omitted
      };
      context.state.kmlNetworkLinkDocuments.set(selected.id, {
        sourceHref: selected.link.href,
        document: parsed.document,
        report: parsed.report
      });
      const layer = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
      if (layer) {
        context.dataByLayerId.set(layer.layerId, combinedKmlGeojson(context.state));
        if (context.state.map?.isStyleLoaded()) repaintLayer(context, layer);
      }
      if (selected.flyToView) zoomToLinkedKmlDocument(context, selected.id);
    } else if (!linked || linked.sourceHref !== selected.link.href || !content) {
      throw Object.assign(new Error("kml_network_link_not_modified_without_content"), {code: "kml_network_link_not_modified_without_content"});
    } else {
      content = {...content, result: "not_modified"};
    }
    const safeReceipt = receiptForKmlNetworkLinkState({...receipt, content});
    context.state.kmlNetworkLinkState = kmlNetworkLinkStateForSave({
      schemaVersion: "1.0.0",
      receipts: [...context.state.kmlNetworkLinkState.receipts, safeReceipt].slice(-KML_NETWORK_LINK_LIMITS.maximumReceipts)
    });
    scheduleKmlNetworkLink(context, selected);
    setStatus(context, `${selected.name} refreshed: ${receipt.status}, ${receipt.byteLength} bounded bytes, ${content.featureCount} linked features, ${content.declaredLossCount} declared losses; DNS-pinned public HTTPS receipt accepted.`);
  } catch (error) {
    if (epoch !== context.state.kmlContextEpoch) return;
    setStatus(context, error?.code === "kml_network_link_timeout"
      ? `${selected.name} refresh stopped at the 10-second timeout.`
      : error?.name === "AbortError"
        ? `${selected.name} refresh cancelled.`
      : `${selected.name} refresh failed safely (${error?.code ?? "governed_refresh_failed"}).`);
  } finally {
    if (inFlight.get(selected.id) === controller) inFlight.delete(selected.id);
    if (epoch === context.state.kmlContextEpoch) context.render();
  }
}

function scheduleKmlNetworkLink(context, selected, requestedReason = null) {
  const current = context.state.kmlNetworkLinkTimers.get(selected.id);
  if (current) clearTimeout(current);
  context.state.kmlNetworkLinkTimers.delete(selected.id);
  if (!currentKmlNetworkLinkApproval(context.state, selected) || typeof context.refreshKmlNetworkLink !== "function") return;
  const prior = [...context.state.kmlNetworkLinkState.receipts].reverse().find(({linkId}) => linkId === selected.id) ?? null;
  let reason = requestedReason;
  let dueAt = Date.now();
  if (!reason && selected.link.refreshMode === "onInterval" && prior) {
    reason = "interval";
    dueAt = Date.parse(prior.fetchedAt) + selected.link.refreshInterval * 1_000;
  } else if (!reason && selected.link.refreshMode === "onExpire" && prior?.expiresAt) {
    reason = "expire";
    dueAt = Date.parse(prior.expiresAt);
  }
  if (!reason) return;
  const delay = Math.max(0, Math.min(2_147_000_000, dueAt - Date.now()));
  const timer = setTimeout(() => {
    context.state.kmlNetworkLinkTimers.delete(selected.id);
    const live = findKmlPlaceForUi(context.state.kmlPlaces, selected.id);
    if (live?.kind === "network-link") void refreshKmlNetworkLinkNow(context, live, reason);
  }, delay);
  context.state.kmlNetworkLinkTimers.set(selected.id, timer);
}

function scheduleKmlNetworkLinkViewRefresh(context) {
  for (const selected of kmlNetworkLinks(context.state.kmlPlaces)) {
    if (!currentKmlNetworkLinkApproval(context.state, selected)) continue;
    if (selected.link.viewRefreshMode === "onStop") {
      const current = context.state.kmlNetworkLinkTimers.get(`${selected.id}:view`);
      if (current) clearTimeout(current);
      const timer = setTimeout(() => {
        context.state.kmlNetworkLinkTimers.delete(`${selected.id}:view`);
        const live = findKmlPlaceForUi(context.state.kmlPlaces, selected.id);
        if (live?.kind === "network-link") void refreshKmlNetworkLinkNow(context, live, "view-stop");
      }, selected.link.viewRefreshTime * 1_000);
      context.state.kmlNetworkLinkTimers.set(`${selected.id}:view`, timer);
    }
    if (selected.link.viewRefreshMode === "onRegion" && selected.region) {
      const active = kmlRegionLodPresentation(selected.region, projectedRegionExtent(context.state.map, selected.region)).active;
      const previous = context.state.kmlNetworkLinkRegionActive.get(selected.id) ?? false;
      context.state.kmlNetworkLinkRegionActive.set(selected.id, active);
      const decision = kmlNetworkLinkRefreshDecision(selected.link, {regionActive: previous}, {
        reason: "region",
        now: new Date().toISOString(),
        regionActive: active,
        previousRegionActive: previous
      });
      if (decision.due) void refreshKmlNetworkLinkNow(context, selected, "region");
    }
  }
}

function kmlNetworkLinks(document) {
  const links = [];
  const visit = (children) => {
    for (const child of children ?? []) {
      if (child.kind === "network-link") links.push(child);
      if (child.kind === "folder") visit(child.children);
    }
  };
  visit(document?.children);
  return links;
}

async function parseKmlNetworkLinkBody(receipt) {
  if (receipt.bodyText !== null) return parseKml(receipt.bodyText);
  const bytes = browserBytesFromBase64(receipt.bodyBase64);
  return parseKmlFile({
    name: "network-link.kmz",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  });
}

function kmlNetworkLinkView(map) {
  const center = map?.getCenter?.();
  const bounds = map?.getBounds?.();
  return {
    west: bounds?.getWest?.() ?? -180,
    south: bounds?.getSouth?.() ?? -90,
    east: bounds?.getEast?.() ?? 180,
    north: bounds?.getNorth?.() ?? 90,
    longitude: center?.lng ?? 0,
    latitude: center?.lat ?? 0,
    pitch: map?.getPitch?.() ?? 0,
    bearing: map?.getBearing?.() ?? 0,
    terrainEnabled: Boolean(map?.getTerrain?.()),
    language: globalThis.navigator?.language ?? "en"
  };
}

function combinedKmlGeojson(state) {
  const primary = placesToGeojson(state.kmlPlaces);
  const features = [...primary.features];
  for (const [linkId, linked] of state.kmlNetworkLinkDocuments) {
    for (const feature of placesToGeojson(linked.document).features) features.push({
      ...feature,
      id: `${linkId}--${feature.id}`,
      properties: {...feature.properties, kmlNetworkLinkId: linkId}
    });
  }
  return {type: "FeatureCollection", features};
}

function linkedNetworkLinkFeatureCount(state) {
  let count = 0;
  for (const linked of state.kmlNetworkLinkDocuments.values()) count += placesToGeojson(linked.document).features.length;
  return count;
}

function currentKmlNetworkLinkApproval(state, selected, now = Date.now()) {
  const approval = state.kmlNetworkLinkApprovals.get(selected.id) ?? null;
  if (!approval || approval.href !== selected.link.href || Date.parse(approval.expiresAt) <= now) {
    if (approval) state.kmlNetworkLinkApprovals.delete(selected.id);
    return null;
  }
  return approval;
}

function zoomToLinkedKmlDocument(context, linkId) {
  const geojson = combinedKmlGeojson(context.state);
  const linked = {type: "FeatureCollection", features: geojson.features.filter(({properties}) => properties.kmlNetworkLinkId === linkId)};
  const bounds = geojsonBounds(linked);
  if (bounds) context.state.map?.fitBounds(bounds, {padding: 90, maxZoom: 16, duration: 350});
}

function chooseImageOverlay(context) {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.accept = "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp";
  input.dataset.imageOverlayFile = "true";
  input.addEventListener("cancel", () => input.remove(), {once: true});
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    try {
      if (!file) return;
      if (file.size > KML_PLACES_LIMITS.maximumKmzResourceBytes) throw new Error("Image exceeds the import size limit");
      const mediaType = overlayMediaType(file);
      const bitmap = await createImageBitmap(file);
      const {width, height} = bitmap;
      bitmap.close();
      if (!width || !height || width > KML_PLACES_LIMITS.maximumOverlayAxisPixels || height > KML_PLACES_LIMITS.maximumOverlayAxisPixels) throw new Error("Image dimensions exceed the import limit");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const {state} = context;
      if (!state.map?.isStyleLoaded()) throw new Error("Wait for the map to finish loading");
      closeImageOverlayEditor(context);
      cancelMapAuthoring(context, {render: false, announce: false});
      cancelQueryDrawing(context, {render: false, announce: false});
      cancelTemporaryEdit(context, {render: false, announce: false});
      state.measureMode = false;
      state.rightOpen = false;
      if (isMobileWorkbenchViewport()) state.leftOpen = false;
      context.render();
      state.map.resize();
      const container = state.map.getContainer();
      const coordinates = fitImageOverlay(container.clientWidth, container.clientHeight, width, height).map((point) => {
        const value = state.map.unproject(point);
        return [((value.lng + 180) % 360 + 360) % 360 - 180, value.lat];
      });
      const document = structuredClone(state.kmlPlaces ?? createPlacesDocument());
      const name = file.name.replace(/\.[^.]+$/, "") || "Image overlay";
      const path = uniqueKmlResourcePath(document, `overlays/${slug(name)}.${mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1]}`);
      document.resources.push({path, mediaType, byteLength: bytes.byteLength, dataBase64: browserBase64(bytes)});
      const next = addKmlPlace(document, document.id, {
        kind: "ground-overlay", name, icon: {href: path}, color: "ffffffff", drawOrder: 0,
        altitude: 0, altitudeMode: "clampToGround", box: null,
        quad: [coordinates[3], coordinates[2], coordinates[1], coordinates[0]]
      });
      const created = findNewestKmlPlace(document, next);
      state.selectedKmlPlaceId = created.id;
      applyKmlPlacesDocument(context, next, `Added ${name}. Drag the image handles to position, resize, or rotate it.`);
      state.kmlContentsOpen = false;
      context.render();
      editImageOverlay(context, created.id);
    } catch (error) {
      setStatus(context, `Image could not be added (${error?.code ?? error?.message ?? "invalid image"}).`);
    } finally { input.remove(); }
  }, {once: true});
  context.shell.append(input);
  input.click();
}

function imageOverlayCoordinates(state, id) {
  return placesToGeojson(state.kmlPlaces).features.find((feature) => feature.id === id)?.geometry?.coordinates?.[0]?.slice(0, 4);
}

function closeImageOverlayEditor(context) {
  const editor = context.state.imageOverlayEditor;
  context.state.imageOverlayEditor = null;
  editor?.dispose();
}

function selectImageOverlayAt(context, point) {
  const {state} = context;
  if (!state.kmlPlaces || !point || context.layers.find(({layerId}) => layerId === editingKmlLayerId(context))?.visible === false) return false;
  const overlays = collectKmlOverlays(state.kmlPlaces).filter(({overlay, visible}) => visible && overlay.kind === "ground-overlay")
    .sort((a, b) => b.overlay.drawOrder - a.overlay.drawOrder);
  for (const {overlay} of overlays) {
    const coordinates = imageOverlayCoordinates(state, overlay.id);
    if (!coordinates) continue;
    const screen = coordinates.map((coordinate) => { const value = state.map.project(coordinate); return [value.x, value.y]; });
    if (pointInImageOverlay([point.x, point.y], screen)) {
      if (state.imageOverlayEditor?.id !== overlay.id) editImageOverlay(context, overlay.id);
      return true;
    }
  }
  return false;
}

function editImageOverlay(context, id) {
  closeShapeEditor(context);
  const {state} = context;
  const selected = findKmlPlaceForUi(state.kmlPlaces, id);
  const coordinates = imageOverlayCoordinates(state, id);
  if (selected?.kind !== "ground-overlay" || !coordinates) return;
  closeImageOverlayEditor(context);
  const original = structuredClone(selected);
  state.selectedKmlPlaceId = id;
  const preview = (points, opacity) => {
    const layer = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
    if (!layer) return;
    state.map.getSource(`${sourceId(layer)}-image-${mapSafeId(id)}`)?.setCoordinates(points);
    const layerId = `${layer.layerId}-image-${mapSafeId(id)}`;
    if (state.map.getLayer(layerId)) state.map.setPaintProperty(layerId, "raster-opacity", opacity * (layer.opacity ?? 1));
  };
  const commit = (points, opacity) => {
    const color = `${Math.round(opacity * 255).toString(16).padStart(2, "0")}${original.color.slice(2)}`;
    const region = original.region ? structuredClone(original.region) : null;
    if (region) Object.assign(region.box, {
      west: Math.min(...points.map(([lng]) => lng)), east: Math.max(...points.map(([lng]) => lng)),
      south: Math.min(...points.map(([, lat]) => lat)), north: Math.max(...points.map(([, lat]) => lat))
    });
    const next = updateKmlPlace(state.kmlPlaces, id, {quad: [points[3], points[2], points[1], points[0]], box: null, color, region});
    applyKmlPlacesDocument(context, next, `Updated ${selected.name}. Save the map to keep these changes.`);
  };
  state.imageOverlayEditor = {id, dispose: mountImageOverlayEditor({
    map: state.map, coordinates, opacity: kmlColorOpacity(selected.color), name: selected.name,
    onPreview: preview, onCommit: commit,
    onError: () => setStatus(context, "The image could not be adjusted. Keep its handles within the map."),
    onClose: (cancel) => {
      closeImageOverlayEditor(context);
      if (cancel) applyKmlPlacesDocument(context, updateKmlPlace(state.kmlPlaces, id, {quad: original.quad, box: original.box, color: original.color, region: original.region}), `Restored ${selected.name}.`);
      else { setStatus(context, `Finished adjusting ${selected.name}. Save the map to keep these changes.`); context.render(); }
    }
  })};
}

function kmlOverlayCreator(context) {
  const details = document.createElement("details");
  details.className = "gis-places-authoring gis-overlay-authoring";
  details.dataset.authoring = "image-overlay";
  details.open = context.state.primaryAuthoringKind === "image-overlay";
  const summary = document.createElement("summary");
  summary.textContent = "Create image overlay";
  details.append(summary);
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const name = textInput("Name", "New overlay");
  name.input.dataset.kmlOverlayField = "name";
  const kind = selectInput("Kind", "ground-overlay", [
    ["ground-overlay", "Ground overlay"],
    ["screen-overlay", "Screen overlay"],
    ["photo-overlay", "Photo overlay"]
  ]);
  kind.input.dataset.kmlOverlayField = "kind";
  const parent = selectInput("Parent", context.state.kmlPlaces.id, kmlContainerOptions(context.state.kmlPlaces));
  parent.input.dataset.kmlOverlayField = "parent";
  const image = document.createElement("input");
  image.type = "file";
  image.accept = "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp";
  image.dataset.kmlOverlayField = "image";
  const extent = textInput(
    "Region/ground extent",
    (context.state.overlayExtentDraft ?? authoringMapExtent(context)).join(",")
  );
  extent.input.dataset.kmlOverlayField = "extent";
  const center = context.state.map?.getCenter?.();
  const point = textInput("Photo anchor", `${boundedCoordinate(center?.lng, 13.45)},${boundedCoordinate(center?.lat, 52.55)},40`);
  point.input.dataset.kmlOverlayField = "point";
  const minLod = textInput("Minimum LOD pixels", "0");
  minLod.input.dataset.kmlOverlayField = "min-lod";
  const maxLod = textInput("Maximum LOD pixels (-1 unlimited)", "-1");
  maxLod.input.dataset.kmlOverlayField = "max-lod";
  const color = textInput("KML color (aabbggrr)", "ffffffff");
  color.input.dataset.kmlOverlayField = "color";
  const create = actionButton("Add image overlay", async () => {
    try {
      const file = image.files?.[0];
      if (!file) throw Object.assign(new Error("kml_overlay_image_required"), {code: "kml_overlay_image_required"});
      if (file.size > KML_PLACES_LIMITS.maximumKmzResourceBytes) throw Object.assign(new Error("kmz_resource_too_large"), {code: "kmz_resource_too_large"});
      const mediaType = overlayMediaType(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let width = 1;
      let height = 1;
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(file);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close?.();
      }
      if (width < 1 || height < 1 || width > KML_PLACES_LIMITS.maximumOverlayAxisPixels || height > KML_PLACES_LIMITS.maximumOverlayAxisPixels) {
        throw Object.assign(new Error("kml_overlay_image_dimensions_invalid"), {code: "kml_overlay_image_dimensions_invalid"});
      }
      const [west, south, east, north] = extent.input.value.split(",").map(Number);
      if (![west, south, east, north].every(Number.isFinite)) throw Object.assign(new Error("kml_overlay_extent_invalid"), {code: "kml_overlay_extent_invalid"});
      const region = {
        box: {north, south, east, west, minAltitude: 0, maxAltitude: 0, altitudeMode: null},
        lod: {minPixels: Number(minLod.input.value), maxPixels: Number(maxLod.input.value), minFadeExtent: 0, maxFadeExtent: 0}
      };
      const resourcePath = uniqueKmlResourcePath(context.state.kmlPlaces, `overlays/${slug(name.input.value)}.${mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1]}`);
      const draft = structuredClone(context.state.kmlPlaces);
      draft.resources.push({path: resourcePath, mediaType, byteLength: bytes.byteLength, dataBase64: browserBase64(bytes)});
      const common = {
        kind: kind.input.value,
        name: name.input.value,
        icon: {href: resourcePath},
        color: color.input.value,
        drawOrder: 0,
        region
      };
      const value = kind.input.value === "ground-overlay"
        ? {...common, altitude: 0, altitudeMode: "clampToGround", box: {north, south, east, west, rotation: 0}, quad: null}
        : kind.input.value === "screen-overlay"
          ? {...common, rotation: 0, overlayXY: {x: 0, y: 0, xunits: "fraction", yunits: "fraction"}, screenXY: {x: 16, y: 16, xunits: "pixels", yunits: "insetPixels"}, rotationXY: {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}, size: {x: 180, y: 0, xunits: "pixels", yunits: "pixels"}}
          : {...common, rotation: 0, viewVolume: {leftFov: -20, rightFov: 20, bottomFov: -20, topFov: 20, near: 1}, imagePyramid: {tileSize: 256, maxWidth: width, maxHeight: height, gridOrigin: "upperLeft"}, point: parseAuthoringGeometry("Point", point.input.value).coordinates, shape: "rectangle"};
      const next = addKmlPlace(draft, parent.input.value, value);
      const created = findNewestKmlPlace(context.state.kmlPlaces, next);
      context.state.selectedKmlPlaceId = created?.id ?? null;
      context.state.mapAuthoringCreatedKmlPlaces = false;
      context.state.primaryAuthoringKind = null;
      context.state.overlayExtentDraft = null;
      applyKmlPlacesDocument(context, next, `Added ${name.input.value || "image overlay"} to the KML layer.`);
    } catch (error) {
      setStatus(context, `Overlay creation failed safely (${error?.code ?? "invalid_overlay"}).`);
    }
  });
  create.dataset.kmlOverlayAction = "create";
  form.append(name.wrapper, kind.wrapper, parent.wrapper, fieldWrap("Bounded local image", image), extent.wrapper, point.wrapper, minLod.wrapper, maxLod.wrapper, color.wrapper, create);
  details.append(form);
  return details;
}

function authoringCoordinateTemplate(context, kind) {
  if (context.state.authoringCoordinateDraft?.kind === kind) {
    return context.state.authoringCoordinateDraft.value;
  }
  const center = context.state.map?.getCenter?.();
  const longitude = boundedCoordinate(center?.lng, 13.405);
  const latitude = boundedCoordinate(center?.lat, 52.52);
  const zoom = context.state.map?.getZoom?.() ?? 10;
  const delta = Math.max(0.0001, Math.min(2, 18 / (2 ** Math.max(0, zoom))));
  const west = boundedCoordinate(longitude - delta, longitude);
  const east = boundedCoordinate(longitude + delta, longitude);
  const south = boundedCoordinate(latitude - delta, latitude);
  const north = boundedCoordinate(latitude + delta, latitude);
  if (kind === "LineString") return `${west},${latitude} ${east},${latitude}`;
  if (kind === "Polygon") {
    return `${west},${south} ${east},${south} ${east},${north} ${west},${north} ${west},${south}`;
  }
  return `${longitude},${latitude}`;
}

const DEFAULT_AUTHORING_EXTENT = Object.freeze([13.4, 52.5, 13.5, 52.6]);

export function normalizeWgs84CaptureExtent(value, fallback = DEFAULT_AUTHORING_EXTENT) {
  const safeFallback = validGeographicBounds(fallback)
    ? fallback.map((coordinate) => boundedCoordinate(coordinate, 0))
    : [...DEFAULT_AUTHORING_EXTENT];
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
    return [...safeFallback];
  }

  const rawWest = Number(value[0]);
  const rawSouth = Number(value[1]);
  const rawEast = Number(value[2]);
  const rawNorth = Number(value[3]);
  const south = Math.max(-90, Math.min(90, Math.min(rawSouth, rawNorth)));
  const north = Math.max(-90, Math.min(90, Math.max(rawSouth, rawNorth)));
  if (!(south < north)) return [...safeFallback];

  let span = rawEast - rawWest;
  if (!(span > 0)) span = ((span % 360) + 360) % 360;
  if (!(span > 0) || span >= 360) {
    return [-180, boundedCoordinate(south, safeFallback[1]), 180, boundedCoordinate(north, safeFallback[3])];
  }

  const midpoint = rawWest + (span / 2);
  const worldOffset = 360 * Math.floor((midpoint + 180) / 360);
  const west = rawWest - worldOffset;
  const east = west + span;
  // One ordered WGS84 bounding box cannot represent a wrapped viewport. Use
  // the whole longitude range so a protected copy never silently omits the
  // visible portion on the other side of the antimeridian.
  if (west < -180 || east > 180) {
    return [-180, boundedCoordinate(south, safeFallback[1]), 180, boundedCoordinate(north, safeFallback[3])];
  }
  return [
    boundedCoordinate(west, safeFallback[0]),
    boundedCoordinate(south, safeFallback[1]),
    boundedCoordinate(east, safeFallback[2]),
    boundedCoordinate(north, safeFallback[3])
  ];
}

function authoringMapExtent(context) {
  const bounds = context.state.map?.getBounds?.();
  if (bounds) return normalizeWgs84CaptureExtent([
    bounds.getWest?.(),
    bounds.getSouth?.(),
    bounds.getEast?.(),
    bounds.getNorth?.()
  ]);
  return [...DEFAULT_AUTHORING_EXTENT];
}

function boundedCoordinate(value, fallback) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : fallback;
}

function portalConfigurationDock(context) {
  const portal = context.state.portalConfiguration;
  const analysis = analyzePortalCatalog(portal, {layers: context.layers, sources: context.sources});
  const section = document.createElement("section");
  section.className = "gis-portal-configuration";
  section.dataset.sources = String(portal.sources.length);
  section.dataset.catalogNodes = String(countPortalNodes(portal.catalog));
  section.dataset.tools = String(countPortalNodes(portal.tools));
  section.dataset.searches = String(portal.searches.length);
  section.dataset.services = String(portal.services.length);
  section.dataset.locations = String(portal.locations.length);
  section.dataset.catalogLayers = String(analysis.counts.layers);
  section.dataset.directCatalogLayers = String(analysis.counts.direct);
  section.dataset.governedCatalogLayers = String(analysis.counts.governed);
  section.dataset.fixtureCatalogLayers = String(analysis.counts.fixture);
  section.dataset.displayedCatalogLayers = String(analysis.counts.displayed);
  section.dataset.unresolvedCatalogLayers = String(analysis.counts.unresolved);
  section.append(
    textElement("h3", "Configured portal"),
    textElement("p", "This project carries a versioned portal composition. Catalog entries become map layers only through an authorized OpenGeo Studio dataset and exact source revision."),
    compactKeyValues({
      "Configuration": `revision ${portal.revision}`,
      "Reference": portal.upstream ? `GeoMoose ${portal.upstream.version}` : "OpenGeo Studio native",
      "Sources": portal.sources.length,
      "Catalog entries": countPortalNodes(portal.catalog),
      "Tools": countPortalNodes(portal.tools),
      "Searches": portal.searches.length,
      "Services": portal.services.length,
      "Saved locations": portal.locations.length,
      "Catalog layer bindings": `${analysis.counts.governed} governed${analysis.counts.fixture ? ` · ${analysis.counts.fixture} browser demo` : ""}`,
      "Theme": portal.theme.title
    })
  );
  const coordinateNote = textElement("p", "Pointer coordinates are always shown in the map status bar. Saved locations retain center and zoom in this portal revision.");
  coordinateNote.className = "gis-portal-coordinate-note";
  section.append(coordinateNote);
  const configure = document.createElement("div");
  configure.className = "gis-action-grid gis-portal-actions";
  configure.append(actionButton("Save current view", () => saveCurrentPortalLocation(context)));
  section.append(configure);
  const catalog = document.createElement("div");
  catalog.className = "gis-portal-catalog";
  catalog.append(textElement("h4", "Portal catalog"));
  const catalogTree = document.createElement("ul");
  catalogTree.setAttribute("aria-label", "Configured portal catalog");
  appendPortalCatalogNodes(catalogTree, analysis.tree, context);
  catalog.append(catalogTree);
  section.append(catalog);

  const tools = document.createElement("div");
  tools.className = "gis-portal-tools";
  tools.append(textElement("h4", "Configured tools"));
  const toolTree = document.createElement("ul");
  toolTree.setAttribute("aria-label", "Configured portal tools");
  appendPortalToolNodes(toolTree, portal.tools, context);
  tools.append(toolTree);
  section.append(tools);

  if (portal.locations.length) {
    const locations = document.createElement("div");
    locations.className = "gis-action-grid";
    for (const location of portal.locations) {
      const row = document.createElement("div");
      row.className = "gis-portal-location";
      row.append(
        actionButton(location.title, () => {
          context.state.map?.flyTo({center: location.center, zoom: location.zoom, duration: 350});
          setStatus(context, `Opened configured location ${location.title}.`);
        }),
        labeledActionButton("Remove", `Remove saved location ${location.title}`, () => removePortalLocation(context, location.id))
      );
      locations.append(row);
    }
    section.append(textElement("h4", "Saved locations"), locations);
  }
  return section;
}

function saveCurrentPortalLocation(context) {
  const {map, portalConfiguration: portal} = context.state;
  if (!map || !portal) {
    setStatus(context, "The map must be ready before its current view can be saved to the portal configuration.");
    return;
  }
  const center = map.getCenter();
  const used = new Set(portal.locations.map(({id}) => id));
  let number = 1;
  while (used.has(`saved-view-${number}`)) number += 1;
  try {
    context.state.portalConfiguration = normalizePortalConfiguration({
      ...portal,
      revision: portal.revision + 1,
      locations: [
        ...portal.locations,
        {
          id: `saved-view-${number}`,
          title: `Saved view ${number}`,
          center: [Number(center.lng.toFixed(7)), Number(center.lat.toFixed(7))],
          zoom: Number(map.getZoom().toFixed(4))
        }
      ]
    });
    context.render();
    setStatus(context, `Saved view ${number} in portal configuration revision ${context.state.portalConfiguration.revision}.`);
  } catch (error) {
    setStatus(context, `The current view could not be saved (${error?.message ?? "invalid portal configuration"}).`);
  }
}

function removePortalLocation(context, locationId) {
  const portal = context.state.portalConfiguration;
  if (!portal) return;
  try {
    context.state.portalConfiguration = normalizePortalConfiguration({
      ...portal,
      revision: portal.revision + 1,
      locations: portal.locations.filter(({id}) => id !== locationId)
    });
    context.render();
    setStatus(context, `Saved location removed in portal configuration revision ${context.state.portalConfiguration.revision}.`);
  } catch (error) {
    setStatus(context, `The saved location could not be removed (${error?.message ?? "invalid portal configuration"}).`);
  }
}

function appendPortalCatalogNodes(parent, nodes, context) {
  for (const node of nodes) {
    const item = document.createElement("li");
    item.dataset.portalCatalogKind = node.kind;
    item.dataset.portalCatalogKey = node.key;
    if (node.kind === "group") {
      const disclosure = document.createElement("details");
      disclosure.open = node.expanded;
      const summary = document.createElement("summary");
      summary.append(
        textElement("strong", node.title),
        textElement("small", `${catalogLeafCount(node.children)} layer${catalogLeafCount(node.children) === 1 ? "" : "s"}${node.exclusive ? " · choose one" : ""}`)
      );
      const nested = document.createElement("ul");
      appendPortalCatalogNodes(nested, node.children, context);
      disclosure.append(summary, nested);
      item.append(disclosure);
    } else {
      item.append(portalCatalogLayerControl(context, node));
    }
    parent.append(item);
  }
}

function portalCatalogLayerControl(context, entry) {
  const row = document.createElement("article");
  row.className = "gis-portal-catalog-layer";
  row.dataset.compatibility = entry.compatibility;
  row.dataset.binding = entry.binding.status;
  const heading = document.createElement("div");
  heading.className = "gis-portal-catalog-layer-heading";
  heading.append(
    textElement("strong", entry.title),
    portalCatalogStatus(entry)
  );
  const reference = textElement("small", entry.reference || "No source reference");
  reference.title = entry.reference || "This catalog entry has no source reference";
  row.append(heading, reference);

  const layer = entry.binding.layer;
  if (entry.binding.status === "governed" || entry.binding.status === "fixture") {
    const controls = document.createElement("div");
    controls.className = "gis-portal-layer-controls";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = layer.visible;
    visible.setAttribute("aria-label", `Show ${entry.title}`);
    visible.addEventListener("change", () => {
      if (visible.checked) enforceExclusivePortalGroup(context, entry);
      setLayerVisible(context, layer, visible.checked);
      context.render();
    });
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = `${layer.opacity ?? 1}`;
    opacity.setAttribute("aria-label", `${entry.title} opacity`);
    opacity.addEventListener("input", () => {
      layer.opacity = Number(opacity.value);
      setLayerOpacity(context.state, layer.layerId, layer.opacity);
    });
    const moveState = projectLayerMoveState(context, layer);
    const up = iconButton(`Move ${entry.title} up`, "↑", () => moveLayer(context, layer, -1));
    const down = iconButton(`Move ${entry.title} down`, "↓", () => moveLayer(context, layer, 1));
    up.disabled = !moveState.canMoveUp;
    down.disabled = !moveState.canMoveDown;
    const remove = iconButton(`Remove ${entry.title} from map`, "Remove", () => removeLayer(context, layer));
    controls.append(visible, textElement("span", "Opacity"), opacity, up, down, remove);
    row.append(controls);
  } else if (entry.binding.status === "invalid") {
    const invalid = actionButton("Repair binding", () => {
      context.state.activePanel = "catalog";
      context.state.rightOpen = true;
      setStatus(context, `${entry.title} has an invalid or duplicate portal binding. Remove the invalid project layer before binding an authorized source.`);
      context.render();
    });
    row.append(invalid);
  } else if (entry.candidates.length === 1) {
    row.append(actionButton("Add authorized layer", () => addPortalCatalogLayer(context, entry, entry.candidates[0])));
  } else if (entry.candidates.length > 1) {
    const ambiguous = actionButton("Choose governed source", () => {
      context.state.activePanel = "catalog";
      context.state.rightOpen = true;
      setStatus(context, `${entry.title} matches more than one authorized source. Choose the intended source in the data catalog.`);
      context.render();
    });
    row.append(ambiguous);
  } else if (entry.compatibility === "direct" && entry.sourceDraft) {
    row.append(actionButton(
      context.publicDemo ? "Try in browser demo" : "Register governed source",
      () => registerPortalCatalogLayer(context, entry)
    ));
  } else if (entry.compatibility === "ingest_required") {
    row.append(actionButton("Open data manager", () => openAddSource(context, "vector")));
  } else {
    const unavailable = actionButton(entry.compatibility === "unresolved" ? "Source unresolved" : "Adapter required", () => {});
    unavailable.disabled = true;
    row.append(unavailable);
  }

  row.append(portalCatalogLegend(entry));
  return row;
}

function portalCatalogStatus(entry) {
  const status = textElement("span", {
    governed: "authorized",
    fixture: "browser demo",
    invalid: "invalid binding",
    none: entry.compatibility === "direct"
      ? "ready to connect"
      : entry.compatibility.replaceAll("_", " ")
  }[entry.binding.status] ?? entry.compatibility.replaceAll("_", " "));
  status.className = `gis-portal-source-status ${entry.binding.status}`;
  return status;
}

function portalCatalogLegend(entry) {
  const details = document.createElement("details");
  details.className = "gis-portal-legend";
  details.dataset.legendKind = entry.legend.kind;
  details.append(textElement("summary", "Legend"));
  const body = document.createElement("div");
  body.append(textElement("p", entry.legend.text));
  for (const swatch of entry.legend.swatches) {
    const item = document.createElement("span");
    const color = document.createElement("i");
    color.style.background = swatch.color;
    color.setAttribute("aria-hidden", "true");
    item.append(color, textElement("small", swatch.label));
    body.append(item);
  }
  if (entry.metadata.length) body.append(textElement("small", `${entry.metadata.length} metadata reference${entry.metadata.length === 1 ? "" : "s"} retained`));
  details.append(body);
  return details;
}

function catalogLeafCount(nodes) {
  return nodes.reduce((total, node) => total + (node.kind === "layer" ? 1 : catalogLeafCount(node.children)), 0);
}

function addPortalCatalogLayer(context, entry, source) {
  if (!canAddPortalCatalogLayer(context.layers.length)) {
    setStatus(context, `The map already has the ${PORTAL_CATALOG_RUNTIME_LIMITS.maximumDisplayedLayers}-layer limit. Remove a layer before adding ${entry.title}.`);
    return;
  }
  try {
    const layer = portalLayerFromGovernedSource(entry, source);
    if (entry.exclusiveGroupKey && layer.visible) enforceExclusivePortalGroup(context, entry);
    context.addLayer(layer, null);
    setStatus(context, context.publicDemo
      ? `${entry.title} is active through a reviewed browser-demo source. Authenticated Studio uses a governed dataset revision for the same control.`
      : `${entry.title} is active through authorized source revision ${source.versionNumber}. Save the map to persist this catalog binding.`);
  } catch (error) {
    setStatus(context, `${entry.title} could not be bound safely (${error?.message ?? "invalid source binding"}).`);
  }
}

async function registerPortalCatalogLayer(context, entry) {
  if (!canAddPortalCatalogLayer(context.layers.length)) {
    setStatus(context, `The map already has the ${PORTAL_CATALOG_RUNTIME_LIMITS.maximumDisplayedLayers}-layer limit. Remove a layer before registering ${entry.title}.`);
    return;
  }
  if (typeof context.registerSource !== "function") {
    setStatus(context, "A persistent project connection is required to register this portal source.");
    return;
  }
  setStatus(context, `Registering ${entry.title} through the normal project source boundary…`);
  try {
    const source = await context.registerSource(portalCatalogSourceRegistration(entry));
    context.sources.push(source);
    addPortalCatalogLayer(context, entry, source);
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Portal source registration failed (${error?.code ?? "invalid_source"}).${request}`);
  }
}

function enforceExclusivePortalGroup(context, entry) {
  if (!entry.exclusiveGroupKey) return;
  const analysis = analyzePortalCatalog(context.state.portalConfiguration, {layers: context.layers, sources: context.sources});
  for (const candidate of analysis.entries) {
    if (candidate.reference === entry.reference || candidate.exclusiveGroupKey !== entry.exclusiveGroupKey) continue;
    const layer = candidate.binding.layer;
    if (layer?.visible) setLayerVisible(context, layer, false);
  }
}

function appendPortalToolNodes(parent, nodes, context) {
  for (const node of nodes) {
    const item = document.createElement("li");
    item.dataset.portalToolKind = node.kind;
    if (node.kind === "drawer") {
      item.append(textElement("strong", node.title));
    } else {
      const handler = portalToolHandler(node.name, context);
      const control = actionButton(node.title, handler ?? (() => {}));
      control.disabled = !handler;
      control.title = handler
        ? `Run configured ${node.type} tool`
        : "This configured tool remains visible and requires an OpenGeo Studio service binding before it can run.";
      item.append(control, textElement("small", node.type));
    }
    if (node.children.length) {
      const nested = document.createElement("ul");
      appendPortalToolNodes(nested, node.children, context);
      item.append(nested);
    }
    parent.append(item);
  }
}

function portalToolHandler(name, context) {
  if (name === "fullextent") return () => fitVisibleLayers(context.state.map, context.layers, context.dataByLayerId);
  if (name === "measure") return () => openMeasurementPanel(context);
  if (name === "identify") return () => {
    context.state.identify = true;
    setStatus(context, "Configured identify tool active.");
    context.render();
  };
  if (name === "print") return context.publicDemo
    ? () => void openBrowserPrintStudio(context) : () => window.print();
  return null;
}

function countPortalNodes(nodes) {
  return (nodes ?? []).reduce((total, node) => total + 1 + countPortalNodes(node.children), 0);
}

function layerDock(context) {
  const {layers, datasets, state} = context;
  const dock = document.createElement("section");
  dock.className = "gis-layer-dock";
  const configuredTree = orderedProjectLayerTree(context.project?.layerTree, layers);

  const layerList = document.createElement("ul");
  layerList.className = "gis-layer-list gis-content-tree";
  layerList.setAttribute("aria-label", "Project contents");

  const projectNode = document.createElement("li");
  projectNode.className = "gis-content-tree-root";
  const projectGroup = document.createElement("details");
  projectGroup.open = state.projectTreeOpen;
  projectGroup.className = "gis-content-tree-group";
  projectGroup.addEventListener("toggle", () => state.projectTreeOpen = projectGroup.open);
  const projectSummary = document.createElement("summary");
  const visibleLayerCount = layers.filter(({visible}) => visible !== false).length;
  projectSummary.append(
    treeIcon("project"),
    textElement("strong", context.project?.name ?? context.workspace?.title ?? "Untitled project"),
    textElement("small", `${visibleLayerCount}/${layers.length} visible`)
  );
  const children = document.createElement("ul");
  const configuredIds = new Set(configuredLayerIds(configuredTree));
  const referencedLayerIds = new Set();
  const renderState = {nodes: 0};
  for (const layer of layers) {
    if (!configuredIds.has(layer.layerId)) {
      children.append(layerRow({context, layer, dataset: datasets.find((dataset) => dataset.datasetId === layer.datasetId)}));
    }
  }
  for (const node of configuredTree) {
    appendProjectLayerNode(children, node, context, referencedLayerIds, renderState, 0);
  }
  for (const layer of layers) {
    if (configuredIds.has(layer.layerId) && !referencedLayerIds.has(layer.layerId)) {
      children.append(layerRow({context, layer, dataset: datasets.find((dataset) => dataset.datasetId === layer.datasetId)}));
    }
  }
  children.append(basemapTreeRow(context));
  projectGroup.append(projectSummary, children);
  projectNode.append(projectGroup);
  layerList.append(projectNode);
  if (context.projectNavigation && !context.projectNavigation.workspaceOptions?.length) {
    layerList.append(projectNavigationTree(context));
  }
  if (!layers.length) layerList.append(
    context.landingMode ? emptyProjectTreeNote() : emptyProjectActions(context)
  );

  const support = document.createElement("div");
  support.className = "gis-layer-support";
  if (state.kmlPlaces || state.mapAuthoring?.target === "places" || state.primaryAuthoringKind) {
    support.append(kmlLayerContentsDisclosure(context));
  }
  const bookmarks = context.project?.bookmarks ?? [];
  if (bookmarks.length) support.append(bookmarkPanel(bookmarks, state));
  if (layers.length && context.rendererAdapter.id !== "cesium") support.append(searchPanel(context));
  if (state.portalConfiguration) support.append(portalConfigurationDisclosure(context));

  dock.append(LayerFolders({tree: configuredTree, layers, onApply: tree => {
    context.project = {...context.project, layerTree: tree};
    context.state.openLayerTreeGroupIds = new Set(projectLayerGroupIds(tree));
    replaceLayerOrder(context.layers, normalizeProjectLayerOrder(context.layers, tree));
    syncLayerOrder(context);
    context.render();
  }}), layerList);
  if (layers.length) {
    const help = document.createElement("details");
    help.className = "gis-layer-visibility-help";
    help.append(textElement("summary", "Layer visibility"), textElement("p", "Checkboxes show or hide layers. Selecting a name only selects it for editing. Hide all layers to see just the basemap; use Basemap to change the background."));
    if(context.rendererAdapter.id !== "cesium") help.append(FeatureHaloControls(context));
    dock.append(help);
  }
  if (support.childElementCount) dock.append(support);
  return dock;
}

function layerToolbar(context) {
  const {layers, state} = context;
  const groupIds = projectLayerGroupIds(orderedProjectLayerTree(context.project?.layerTree, layers));
  const allGroupsOpen = groupIds.length > 0
    && groupIds.every((groupId) => state.openLayerTreeGroupIds.has(groupId));
  const actions = document.createElement("div");
  actions.className = "gis-icon-row gis-layer-toolbar";
  actions.append(
    svgIconButton("Add data to project layers", "add-data", () => openAddSource(context, "vector")),
    svgIconButton("Show all layers", "visibility", () => {
      for (const layer of layers) setLayerVisible(context, layer, true);
      context.render();
    }),
    svgIconButton("Hide all layers", "visibility-off", () => {
      for (const layer of layers) setLayerVisible(context, layer, false);
      context.render();
    }),
    svgIconButton(
      allGroupsOpen ? "Collapse all layer groups" : "Expand all layer groups",
      allGroupsOpen ? "collapse-all" : "expand-all",
      () => {
        state.openLayerTreeGroupIds = allGroupsOpen ? new Set() : new Set(groupIds);
        context.render();
      }
    )
  );
  if(context.rendererAdapter.id === "cesium") {actions.firstElementChild.disabled=true;actions.firstElementChild.title="Switch to MapLibre to add Layers.";}
  return actions;
}

function kmlLayerContentsDisclosure(context) {
  const counts = countPlaces(context.state.kmlPlaces);
  const itemCount = counts.placemarks + counts.overlays + counts.networkLinks;
  const disclosure = document.createElement("details");
  disclosure.className = "gis-kml-contents";
  disclosure.open = context.state.kmlContentsOpen === true
    || Boolean(context.state.selectedKmlPlaceId)
    || Boolean(context.state.primaryAuthoringKind);
  disclosure.addEventListener("toggle", () => context.state.kmlContentsOpen = disclosure.open);
  disclosure.append(textElement("summary", `KML content (${itemCount})`), kmlLayerEditor(context));
  return disclosure;
}

function portalConfigurationDisclosure(context) {
  const disclosure = document.createElement("details");
  disclosure.className = "gis-portal-configuration-disclosure";
  disclosure.open = context.state.portalConfigurationOpen === true;
  disclosure.addEventListener("toggle", () => context.state.portalConfigurationOpen = disclosure.open);
  disclosure.append(textElement("summary", "Portal configuration"), portalConfigurationDock(context));
  return disclosure;
}

function bookmarkPanel(bookmarks, state) {
  const disclosure = document.createElement("details");
  disclosure.className = "gis-bookmark-strip";
  disclosure.open = state.bookmarkPanelOpen === true;
  disclosure.addEventListener("toggle", () => state.bookmarkPanelOpen = disclosure.open);
  disclosure.append(textElement("summary", `Bookmarks (${bookmarks.length})`));
  const actions = document.createElement("div");
  for (const bookmark of bookmarks) {
    actions.append(actionButton(bookmark.title, () => {
      const view = normalizeMapView(bookmark);
      state.map?.easeTo({
        center: view.center,
        zoom: view.zoom,
        pitch: view.pitch,
        bearing: view.bearing,
        duration: 350
      });
    }));
  }
  disclosure.append(actions);
  return disclosure;
}

function projectNavigationTree(context) {
  const navigation = context.projectNavigation;
  const item = document.createElement("li");
  item.className = "gis-example-map-tree";
  const disclosure = document.createElement("details");
  disclosure.className = "gis-content-tree-group gis-example-map-disclosure";
  disclosure.open = context.state.exampleTreeOpen;
  disclosure.addEventListener("toggle", () => context.state.exampleTreeOpen = disclosure.open);
  const summary = document.createElement("summary");
  summary.append(
    treeIcon("folder"),
    textElement("strong", navigation.title ?? "Example maps"),
    textElement("small", `${navigation.pageCount ?? countNavigationPages(navigation.nodes)} maps`)
  );
  const children = document.createElement("ul");
  const state = {nodes: 0, openGroupIds: context.state.openNavigationGroupIds};
  for (const node of navigation.nodes ?? []) appendNavigationNode(children, node, navigation, state, 0);
  disclosure.append(summary, children);
  item.append(disclosure);
  return item;
}

function appendNavigationNode(parent, node, navigation, state, depth) {
  if (!node || typeof node !== "object" || depth > 8 || state.nodes >= 128) return;
  state.nodes += 1;
  if (node.kind === "page") {
    if (typeof node.id !== "string" || typeof node.title !== "string") return;
    const item = document.createElement("li");
    item.className = "gis-example-map-page";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pageId = node.id;
    button.classList.toggle("active", node.id === navigation.activePageId);
    if (node.id === navigation.activePageId) button.setAttribute("aria-current", "page");
    button.append(textElement("span", node.title));
    if (node.summary) button.append(textElement("small", node.summary));
    button.addEventListener("click", () => navigation.onSelectPage?.(node.id));
    item.append(button);
    parent.append(item);
    return;
  }
  if (node.kind !== "group" || typeof node.title !== "string" || !Array.isArray(node.children)) return;
  const item = document.createElement("li");
  item.className = "gis-example-map-group";
  const disclosure = document.createElement("details");
  disclosure.className = "gis-content-tree-group";
  disclosure.open = state.openGroupIds.has(node.id);
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) state.openGroupIds.add(node.id);
    else state.openGroupIds.delete(node.id);
  });
  const summary = document.createElement("summary");
  summary.append(
    treeIcon("folder"),
    textElement("strong", node.title),
    textElement("small", `${countNavigationPages(node.children)} maps`)
  );
  const children = document.createElement("ul");
  for (const child of node.children) appendNavigationNode(children, child, navigation, state, depth + 1);
  disclosure.append(summary, children);
  item.append(disclosure);
  parent.append(item);
}

function countNavigationPages(nodes, depth = 0) {
  if (!Array.isArray(nodes) || depth > 8) return 0;
  return nodes.slice(0, 128).reduce((count, node) => (
    count + (node?.kind === "page" ? 1 : countNavigationPages(node?.children, depth + 1))
  ), 0);
}

function initialOpenLayerTreeGroupIds(nodes) {
  return new Set(projectLayerGroupIds(nodes, {openOnly: true}));
}

function projectLayerGroupIds(nodes, {openOnly = false} = {}, depth = 0, output = []) {
  if (!Array.isArray(nodes) || depth > 8 || output.length >= 256) return output;
  for (const node of nodes) {
    if (!node || node.kind !== "group" || typeof node.id !== "string") continue;
    if (!openOnly || node.open !== false) output.push(node.id);
    projectLayerGroupIds(node.children, {openOnly}, depth + 1, output);
  }
  return output;
}

function initialOpenNavigationGroupIds(nodes, depth = 0, output = new Set()) {
  if (!Array.isArray(nodes) || depth > 8 || output.size >= 128) return output;
  for (const node of nodes) {
    if (!node || node.kind !== "group" || typeof node.id !== "string") continue;
    if (node.open === true) output.add(node.id);
    initialOpenNavigationGroupIds(node.children, depth + 1, output);
  }
  return output;
}

function appendProjectLayerNode(parent, node, context, referencedLayerIds, state, depth) {
  if (!node || typeof node !== "object" || depth > 8 || state.nodes >= 256) return;
  state.nodes += 1;
  if (node.kind === "layer") {
    const layer = context.layers.find(({layerId}) => layerId === node.layerId);
    if (!layer || referencedLayerIds.has(layer.layerId)) return;
    referencedLayerIds.add(layer.layerId);
    parent.append(layerRow({
      context,
      layer,
      dataset: context.datasets.find((dataset) => dataset.datasetId === layer.datasetId)
    }));
    return;
  }
  if (node.kind !== "group" || typeof node.title !== "string" || !Array.isArray(node.children)) return;
  const item = document.createElement("li");
  item.className = "gis-project-layer-group";
  const disclosure = document.createElement("details");
  disclosure.className = "gis-content-tree-group gis-layer-tree-group";
  disclosure.open = context.state.openLayerTreeGroupIds.has(node.id);
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) context.state.openLayerTreeGroupIds.add(node.id);
    else context.state.openLayerTreeGroupIds.delete(node.id);
  });
  const summary = document.createElement("summary");
  const groupLayers = collectTreeLayers(node, context.layers);
  const visibility = document.createElement("input");
  visibility.type = "checkbox";
  visibility.checked = groupLayers.length > 0 && groupLayers.every(({visible}) => visible !== false);
  visibility.indeterminate = groupLayers.some(({visible}) => visible !== false)
    && !groupLayers.every(({visible}) => visible !== false);
  visibility.disabled = groupLayers.length === 0;
  visibility.setAttribute("aria-label", `Show all layers in ${node.title}`);
  visibility.addEventListener("click", (event) => event.stopPropagation());
  visibility.addEventListener("change", () => {
    for (const layer of groupLayers) setLayerVisible(context, layer, visibility.checked);
    context.render();
  });
  const groupMove = projectLayerGroupMoveState(context, node.id);
  const groupOrderControls = document.createElement("div");
  groupOrderControls.className = "gis-layer-order-controls gis-layer-group-order-controls";
  groupOrderControls.setAttribute("aria-label", `Folder order for ${node.title}`);
  const groupUp = iconButton(`Move ${node.title} group up`, "↑", () => moveLayerGroup(context, node.id, -1));
  const groupDown = iconButton(`Move ${node.title} group down`, "↓", () => moveLayerGroup(context, node.id, 1));
  groupUp.disabled = !groupMove.canMoveUp;
  groupDown.disabled = !groupMove.canMoveDown;
  for (const control of [groupUp, groupDown]) {
    control.addEventListener("click", (event) => event.stopPropagation());
  }
  groupOrderControls.append(groupUp, groupDown);
  summary.append(
    treeIcon("folder"),
    visibility,
    textElement("strong", node.title),
    textElement(
      "small",
      `${groupLayers.filter(({visible}) => visible !== false).length}/${groupLayers.length} on`
    ),
    groupOrderControls
  );
  const children = document.createElement("ul");
  for (const child of node.children) {
    appendProjectLayerNode(children, child, context, referencedLayerIds, state, depth + 1);
  }
  disclosure.append(summary, children);
  item.append(disclosure);
  parent.append(item);
}

function collectTreeLayers(node, layers) {
  const ids = new Set(configuredLayerIds([node]));
  return layers.filter(({layerId}) => ids.has(layerId));
}

function emptyProjectActions(context) {
  const empty = document.createElement("section");
  empty.className = "gis-empty-project-actions";
  empty.setAttribute("aria-label", "Start this empty project");
  const availableDatasets = context.datasets.length;
  empty.append(
    textElement("strong", "This map has no data layers yet"),
    textElement(
      "p",
      context.publicDemo
        ? "Choose Layers from the catalog, register a source, or begin drawing. Save locally to keep this Project within Demo storage limits."
        : availableDatasets
        ? `${availableDatasets} project ${availableDatasets === 1 ? "dataset is" : "datasets are"} available. Add one to this map, open a local GIS file, or begin drawing.`
        : "The project and map are saved, but no dataset is attached. Add data, open a local GIS file, or begin drawing."
    )
  );

  const actions = document.createElement("div");
  actions.className = "gis-empty-project-action-grid";
  actions.append(
    emptyProjectAction(
      context.publicDemo ? "Browse Layer catalog" : availableDatasets ? "Add project data" : "Add data source",
      "+",
      () => openProjectCatalog(context),
      {wide: true}
    ),
    emptyProjectAction("Open local file", "↥", () => openAddSource(context, "vector"), {wide: true}),
    emptyProjectAction("Draw point", "●", () => beginMapAuthoring(context, "Point")),
    emptyProjectAction("Draw path", "⌁", () => beginMapAuthoring(context, "LineString")),
    emptyProjectAction("Draw polygon", "⬠", () => beginMapAuthoring(context, "Polygon")),
    emptyProjectAction("Place image overlay", "▧", () => chooseImageOverlay(context))
  );
  empty.append(actions);
  return empty;
}

function openProjectCatalog(context) {
  context.state.activePanel = "catalog";
  context.state.rightOpen = true;
  setStatus(
    context,
    context.publicDemo
      ? "Layer catalog opened. Choose a Layer to review and add to this Project."
      : context.datasets.length
      ? "Project data catalog opened. Choose a governed dataset to add to this map."
      : "Data catalog opened. Connect or upload a governed source for this project."
  );
  context.render();
}

function emptyProjectTreeNote() {
  const note = document.createElement("li");
  note.className = "gis-empty-tree-note";
  note.append(
    textElement("strong", "No project layers yet"),
    textElement("span", "Use Point, Path, Polygon, Image overlay, Open file, or Add data in the toolbar above.")
  );
  return note;
}

function emptyProjectAction(label, symbol, action, {wide = false} = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-empty-project-action";
  button.classList.toggle("wide", wide);
  const symbolElement = textElement("span", symbol);
  symbolElement.setAttribute("aria-hidden", "true");
  button.append(symbolElement, textElement("strong", label));
  button.addEventListener("click", action);
  return button;
}

function treeIcon(kind) {
  const icon = textElement("span", ["project", "folder"].includes(kind) ? "▸" : kind === "basemap" ? "▧" : "◇");
  icon.className = "gis-tree-icon";
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function basemapTreeRow(context) {
  const item = document.createElement("li");
  item.className = "gis-basemap-tree-row";
  const basemap = activeBasemap(context);
  if(context.rendererAdapter.id === "cesium") {
    if(context.state.map.basemap) {
      const label=document.createElement('label'),visible=document.createElement('input');visible.type='checkbox';visible.checked=context.state.basemapOpacity>0;
      label.append(visible,document.createTextNode(` Background · ${basemap?.title??context.state.map.basemap.title}`));
      const opacity=document.createElement('input');opacity.type='range';opacity.min='0';opacity.max='1';opacity.step='0.05';opacity.value=String(context.state.basemapOpacity);opacity.setAttribute('aria-label','Background opacity');
      const apply=value=>{context.state.basemapOpacity=value;context.state.map.setBasemapOpacity(value);visible.checked=value>0;opacity.value=String(value);};
      visible.onchange=()=>apply(visible.checked?1:0);
      opacity.oninput=()=>apply(Number(opacity.value));
      item.append(label,opacity);
    } else item.textContent=`Background · plain Cesium globe (${basemap?.title ?? "original background"} retained for other engines)`;
    return item;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.append(
    treeIcon("basemap"),
    textElement("span", `Background · ${basemap?.title ?? "Blank canvas"}`)
  );
  if (["retired", "disabled"].includes(basemap?.governance?.lifecycle)
    || basemap?.governance?.observation?.status === "degraded") {
    const policy = textElement("small", basemapGovernanceLabel(basemap.governance));
    policy.className = "gis-basemap-governance-state";
    button.append(policy);
  }
  button.addEventListener("click", () => {
    openBasemapChooser(context);
  });
  item.append(button);
  return item;
}

function basemapControl(context) {
  const {state} = context;
  const wrapper = document.createElement("div");
  wrapper.className = "gis-basemap-control";

  const select = document.createElement("select");
  for (const basemap of allBasemaps(context)) {
    const option = document.createElement("option");
    option.value = basemap.basemapId;
    option.textContent = basemap.title;
    option.selected = basemap.basemapId === (state.currentBasemapId ?? visibleBasemap(context.project));
    select.append(option);
  }
  select.addEventListener("change", () => {
    const choice = allBasemaps(context).find(({basemapId}) => basemapId === select.value);
    if (choice) void selectBasemapChoice(context, choice);
  });

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.value = `${state.basemapOpacity}`;
  opacity.addEventListener("input", () => {
    state.basemapOpacity = Number(opacity.value);
    setBasemapOpacity(state);
  });

  wrapper.append(textElement("span", "Basemap"), select, opacity);
  return wrapper;
}

function layerRow({context, layer, dataset}) {
  const {state} = context;
  const row = document.createElement("li");
  row.className = "gis-layer-row";
  row.dataset.layerId = layer.layerId;
  row.dataset.persistence = isTemporaryLayer(layer) ? "temporary" : "project";
  row.classList.toggle("active", layer.layerId === state.activeLayerId);

  const top = document.createElement("div");
  top.className = "gis-layer-row-top";

  const visible = document.createElement("input");
  visible.type = "checkbox";
  visible.checked = layer.visible;
  visible.setAttribute("aria-label", `Show ${layer.title}`);
  visible.title = `Show or hide ${layer.title}. Selecting the name does not change visibility.`;
  visible.addEventListener("change", () => {
    setLayerVisible(context, layer, visible.checked);
    context.render();
  });

  const swatch = document.createElement("span");
  swatch.className = "gis-style-swatch-slot";
  const styleButton = iconButton(`Style ${layer.title}`, "", () => openLayerSymbology(context, layer));
  styleButton.className = "gis-swatch gis-style-swatch";
  styleButton.title = `Change symbols, colors and sizes for ${layer.title}`;
  styleButton.style.background = layerColor(layer);
  if (["Point", "MultiPoint"].includes(layer.geometryType)) styleButton.append(pointSymbolPreview(layer.style, ""));
  swatch.append(styleButton);

  const title = document.createElement("button");
  title.type = "button";
  title.textContent = layer.title;
  const metadata = [
    temporaryWorkExpiryLabel(layer) ?? layer.sourceType,
    layer.geometryType,
    dataset?.featureCount ? `${dataset.featureCount} features` : null,
    liveFeatureLayerStatus(layer)
  ].filter(Boolean).join(" / ");
  title.setAttribute("aria-label", `Select layer ${layer.title}`);
  title.title = `Select ${layer.title}; ${metadata}; use layer actions to style or inspect it`;
  title.setAttribute("aria-pressed", String(layer.layerId === state.activeLayerId));
  title.addEventListener("click", () => {
    state.activeLayerId = layer.layerId;
    context.render();
  });

  const moveState = projectLayerMoveState(context, layer);
  const orderControls = document.createElement("div");
  orderControls.className = "gis-layer-order-controls";
  orderControls.setAttribute("aria-label", `Layer order for ${layer.title}`);
  const moveUp = iconButton(`Move ${layer.title} up`, "↑", () => moveLayer(context, layer, -1));
  const moveDown = iconButton(`Move ${layer.title} down`, "↓", () => moveLayer(context, layer, 1));
  moveUp.disabled = !moveState.canMoveUp;
  moveDown.disabled = !moveState.canMoveDown;
  orderControls.append(moveUp, moveDown);

  const tools = document.createElement("div");
  tools.className = "gis-layer-tools";
  const remove = iconButton("Remove layer from this project", "Remove", () => removeLayer(context, layer));
  const toolsMoveUp = iconButton("Move up", "Up", () => moveLayer(context, layer, -1));
  const toolsMoveDown = iconButton("Move down", "Down", () => moveLayer(context, layer, 1));
  toolsMoveUp.disabled = !moveState.canMoveUp;
  toolsMoveDown.disabled = !moveState.canMoveDown;
  remove.classList.add("danger");
  tools.append(
    iconButton("Style layer", "Style", () => {
      state.activeLayerId = layer.layerId;
      state.activePanel = "style";
      state.rightOpen = true;
      context.render();
    }),
    iconButton("Open attribute table", "Table", () => {
      state.activeLayerId = layer.layerId;
      state.activePanel = "attributes";
      state.rightOpen = true;
      context.render();
    }),
    toolsMoveUp,
    toolsMoveDown,
    iconButton("Zoom to layer", "Zoom", () => fitLayer(state.map, layer, context.dataByLayerId))
  );
  if (layer.geometryType === "Point") tools.append(iconButton("Point clustering display settings", "Clustering", () => {
    state.activeLayerId = layer.layerId;state.activePanel = "style";state.rightOpen = true;context.render();
    context.shell.querySelector(".gis-point-clustering")?.scrollIntoView?.({block: "nearest"});
  }));
  if (layer.sourceType === "external-feature-reference") {
    const refresh = iconButton("Refresh visible features from the current map view", "Refresh view", () => {
      void loadLiveExternalFeatureLayer(context, layer, {force: true, announce: true});
    });
    refresh.disabled = layer.liveFeatureState === "loading" || context.layerArchiveModes.has(layer.layerId);
    tools.append(refresh);
  }
  const managedDisplay = layer.sourceType === "governed-dataset" && layer.datasetVersionId;
  if (layer.sourceType === "external-feature-reference" || managedDisplay) {
    if (context.layerArchiveAccess && layer.datasetId) {
      if (!context.layerArchiveControls.has(layer.layerId)) {
        const clearData = () => {
          context.dataByLayerId.delete(layer.layerId);
          context.state.map?.getSource?.(sourceId(layer))?.setData?.({type: "FeatureCollection", features: []});
          layer.liveFeaturePage = null; layer.liveFeatureState = null;
        };
        context.layerArchiveControls.set(layer.layerId, LayerArchiveControl({layer, access: context.layerArchiveAccess,
          returnLabel: managedDisplay && (isPreservedDatasetLayer(context, layer)
            || !context.datasets.some(dataset => dataset.datasetId === layer.datasetId)) ? "Pause tiled display" : null,
          onStart: () => {
            context.state.archiveTileSessions.get(layer.layerId)?.dispose();
            context.state.archiveTileSessions.delete(layer.layerId);
            removeMapLayer(context.state, layer.layerId);
            cancelLiveFeatureLayer(context, layer); clearData();
            setStatus(context, `Loading the selected archived copy of ${layer.title}…`);
            context.layerArchiveModes.set(layer.layerId, "loading");
            context.loadingDatasetLayerIds.add(layer.layerId); context.render();
          },
          onLoaded: (geojson, record) => {
            if (context.disposed || !context.layers.includes(layer)) return;
            if (managedDisplay) {layer.managedDisplayId = record.id; validateManagedDisplayReference(layer);}
            context.loadingDatasetLayerIds.delete(layer.layerId);
            context.layerArchiveModes.set(layer.layerId, "ready");
            if (geojson.kind === "reviewed-archive-tiles") {
              context.state.archiveTileSessions.set(layer.layerId, geojson);
              if (context.state.map?.isStyleLoaded?.()) addMapLayer(context.state, layer, null, context.datasets);
              syncLayerOrder(context);
              setStatus(context, managedDisplay
                ? `${layer.title}: viewing reviewed tiles of the saved dataset. Visible tiles load on demand.`
                : `${layer.title}: viewing reviewed archive tiles. Visible tiles load on demand; Return to live uses the provider.`);
              context.render(); return;
            }
            context.dataByLayerId.set(layer.layerId, geojson);
            const source = context.state.map?.getSource?.(sourceId(layer));
            if (source?.setData) source.setData(geojson);
            else if (context.state.map?.isStyleLoaded?.()) addMapLayer(context.state, layer, geojson, context.datasets);
            syncLayerOrder(context);
            setStatus(context, `${layer.title}: viewing an archived copy with ${geojson.features.length.toLocaleString()} verified features. Return to live to use the provider.`);
            context.render();
          },
          onError: () => {
            removeMapLayer(context.state, layer.layerId);
            context.state.archiveTileSessions.get(layer.layerId)?.dispose();
            context.state.archiveTileSessions.delete(layer.layerId);
            clearData(); context.loadingDatasetLayerIds.delete(layer.layerId); context.layerArchiveModes.set(layer.layerId, "error"); setStatus(context, `${layer.title}: archive loading stopped. Review the display selection or return to ${managedDisplay ? "saved data" : "live"}.`); context.render();
          },
          onReturn: () => {
            const preserved = managedDisplay && isPreservedDatasetLayer(context, layer);
            const tiledOnly = managedDisplay && (preserved || !context.datasets.some(dataset => dataset.datasetId === layer.datasetId));
            if (managedDisplay && !tiledOnly) delete layer.managedDisplayId;
            removeMapLayer(context.state, layer.layerId);
            context.state.archiveTileSessions.get(layer.layerId)?.dispose();
            context.state.archiveTileSessions.delete(layer.layerId);
            clearData(); context.loadingDatasetLayerIds.delete(layer.layerId); context.layerArchiveModes.delete(layer.layerId);
            if (tiledOnly) {
              const message = `${layer.title}: tiled display paused. ${preserved ? "The original is preserved without a raw map preview. " : "Dataset preview availability has not been established. "}Choose a reviewed tiled display and acknowledge download costs to resume.`;
              setStatus(context, message); context.render();
              return {retainDisplayId: layer.managedDisplayId, message};
            }
            if (context.state.map?.isStyleLoaded?.()) addMapLayer(context.state, layer, null, context.datasets);
            setStatus(context, `${layer.title}: ${managedDisplay ? "saved data" : "live connection"} selected.`);
            if (managedDisplay) void loadPersistedDatasetLayers(context);
            else void loadLiveExternalFeatureLayer(context, layer, {force: true, announce: true});
            context.render();
          }
        }));
      }
      tools.append(context.layerArchiveControls.get(layer.layerId));
    }
  }
  tools.append(remove);
  if(context.rendererAdapter.id === "cesium") tools.replaceChildren(
    toolsMoveUp,toolsMoveDown,
    iconButton("Zoom to layer","Zoom",()=>fitLayer(state.map,layer,context.dataByLayerId)),
    textElement("small","Switch to MapLibre to change styling, sources or geometry."));

  const more = document.createElement("details");
  more.className = "gis-layer-more";
  more.open = context.layerToolsOpen.has(layer.layerId);
  more.addEventListener("toggle", () => {
    if (!more.isConnected) return;
    if (more.open) context.layerToolsOpen.add(layer.layerId);
    else context.layerToolsOpen.delete(layer.layerId);
  });
  const moreSummary = textElement("summary", "•••");
  moreSummary.title = `Layer actions for ${layer.title}`;
  moreSummary.setAttribute("aria-label", `Layer actions for ${layer.title}`);
  moreSummary.addEventListener("click", () => {
    if (more.open) return;
    context.layerToolsOpen.clear();
    for (const other of context.shell.querySelectorAll(".gis-layer-more[open]")) {
      if (other !== more) other.open = false;
    }
  });
  tools.addEventListener("click", event => {
    if (!event.target.closest("button")) return;
    context.layerToolsOpen.delete(layer.layerId);
    more.open = false;
  }, {capture: true});
  more.append(moreSummary);

  context.layerInfoOpen ??= new Set();
  const info = LayerInfo({layer, metadata, open: context.layerInfoOpen.has(layer.layerId),
    onToggle: open => open ? context.layerInfoOpen.add(layer.layerId) : context.layerInfoOpen.delete(layer.layerId)});
  top.append(visible, swatch, title, orderControls, info.button, more);

  const archiveMode = context.layerArchiveModes.get(layer.layerId);
  const meta = textElement("small", archiveMode ? `Archived copy · ${archiveMode}` : metadata);
  meta.className = "gis-layer-popover-meta";
  meta.title = meta.textContent;

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.value = `${layer.opacity ?? 1}`;
  opacity.disabled=context.rendererAdapter.id === "cesium";
  if(opacity.disabled)opacity.title="Switch to MapLibre to adjust opacity.";
  opacity.addEventListener("input", () => {
    layer.opacity = Number(opacity.value);
    setLayerOpacity(state, layer.layerId, layer.opacity);
  });

  const opacityField = document.createElement("label");
  opacityField.className = "gis-layer-opacity";
  opacityField.append(textElement("span", "Opacity"), opacity);
  const popover = document.createElement("div");
  popover.className = "gis-layer-popover";
  popover.append(meta, tools, opacityField);
  more.append(popover);
  const legend = rendererLegend(layer, context.dataByLayerId.get(layer.layerId), state.resolvedLayerStyles?.get(layer.layerId));
  if (legend) {
    const disclosure = document.createElement("details");
    disclosure.className = "gis-layer-tree-legend";
    disclosure.append(textElement("summary", "Legend"), legend);
    popover.append(disclosure);
  }
  row.append(top, info.content);
  if (state.rendererLayerIssues?.has(layer.layerId)) {
    const notice = textElement("small", `${state.rendererLayerIssues.get(layer.layerId)} Switch to MapLibre to display this Layer.`);
    notice.className = "gis-layer-renderer-notice";
    row.append(notice);
  }
  return row;
}

function searchPanel(context) {
  const {dataByLayerId, state} = context;
  const section = document.createElement("details");
  section.className = "gis-search";
  section.open = state.placeSearchOpen === true || Boolean((state.placeSearch ?? "").trim());
  section.addEventListener("toggle", () => state.placeSearchOpen = section.open);
  section.append(textElement("summary", "Search layer features"));
  const body = document.createElement("div");
  body.className = "gis-search-body";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search places and attributes...";
  input.value = state.placeSearch ?? "";
  input.addEventListener("input", () => {
    state.placeSearch = input.value;
    context.render();
  });
  body.append(input);

  const hits = [];
  const needle = (state.placeSearch ?? "").trim().toLowerCase();
  if (needle.length >= 2) {
    for (const layer of context.layers) {
      const geojson = dataByLayerId.get(layer.layerId);
      for (const [index, feature] of (geojson?.features ?? []).entries()) {
        const haystack = Object.values(feature.properties ?? {}).join(" ").toLowerCase();
        if (haystack.includes(needle)) hits.push({layer, feature, index});
        if (hits.length >= 6) break;
      }
      if (hits.length >= 6) break;
    }
  }

  for (const hit of hits) {
    const button = actionButton(featureTitle(hit.feature, hit.layer), () => {
      state.activeLayerId = hit.layer.layerId;
      state.selectedFeatureIndex = hit.index;
      zoomToFeature(context, hit.layer, hit.feature);
      setStatus(context, `Found ${featureTitle(hit.feature, hit.layer)}.`);
    });
    body.append(button);
  }

  section.append(body);
  return section;
}

function analysisInputLayers(context) {
  const completeTypes = new Set(["geojson-object", "geojson-archive", "governed-dataset", "arcgis-feature-layer-snapshot"]);
  return context.layers.filter(layer => completeTypes.has(layer.sourceType)
    && !layer.managedDisplayId && !context.layerArchiveModes.has(layer.layerId)
    && !context.loadingDatasetLayerIds.has(layer.layerId)
    && !context.failedDatasetLayerIds.has(layer.layerId)
    && context.dataByLayerId.get(layer.layerId)?.type === "FeatureCollection").map(layer => ({
      id: layer.layerId, title: layer.title, geojson: context.dataByLayerId.get(layer.layerId),
      inputPin: {layerId: layer.layerId, datasetId: layer.datasetId ?? null,
        datasetVersionId: layer.datasetVersionId ?? null, sourceVersion: layer.sourceVersion ?? null,
        featureGeneration: layer.featureGeneration ?? null,
        checksumSha256: layer.sourceConfiguration?.checksumSha256 ?? null}
    }));
}

function toggleAnalysisConsole(context) {
  if (context.disposed) return;
  if (context.analysisConsole && !context.analysisConsole.element.hidden) {context.analysisConsole.close();return;}
  if (context.state.mapOnly) setMapOnly(context, false);
  if (!context.analysisConsole) {
    const local = createLocalAnalysisRuntime();
    context.analysisConsole = AnalysisConsole({getLayers: () => analysisInputLayers(context),
      runNative: context.analysisRuntime?.runNative ?? local.runNative,
      getNativeCapabilities: context.analysisRuntime?.getNativeCapabilities ?? local.getNativeCapabilities,
      runManaged: context.analysisRuntime?.runManaged,
      getManagedCapabilities: context.analysisRuntime?.getManagedCapabilities,
      dark: context.state.colorMode === "dark",
      onClose: () => {context.mapColumn.classList.remove("gis-analysis-console-open");context.state.map?.resize?.();},
      onResult: ({geojson, execution, language, inputPins}) => {
        if (context.disposed) throw Error("This map has closed.");
        const result = {...geojson, "opengeo:analysis": {operation: "script", language,
          execution, inputs: inputPins, persisted: false, crs: "CRS:84"}};
        addProcessingOutputLayer(context, {title: "Analysis", layerId: null, datasetId: null},
          "script", result, `${language === "javascript" ? "JavaScript" : language === "python" ? "Python" : "Bash"} analysis result`);
      }
    });
    context.mapColumn.append(context.analysisConsole.element);
  }
  context.mapColumn.classList.add("gis-analysis-console-open");
  context.analysisConsole.open();context.state.activeMenu = null;context.render();
  requestAnimationFrame(() => context.state.map?.resize?.());
}

function setMapOnly(context, enabled) {
  if (enabled) context.analysisConsole?.close();
  context.state.mapOnly = enabled;
  context.state.activeMenu = null;
  context.render();
  const selector = '.gis-map-only-command';
  queueMicrotask(() => {
    const menu = context.shell?.querySelector(selector);
    if (menu?.getClientRects().length) menu.focus();
    else context.shell?.querySelector('.gis-mobile-toolbar [data-primary-command="more"]')?.focus();
  });
}

function renderMapChrome(chrome, context) {
  const {state} = context;
  if (context.cameraControls?.isInteracting()) return;
  if (state.queryResult && state.queryDraft?.datasetId !== activeLayer(context)?.datasetId) {
    state.queryResult = null;
    state.querySelectedFeatureId = null;
    state.selectedFeatureIndex = null;
    syncQueryResultLayer(context, []);
  }
  chrome.replaceChildren();
  // An active flight keeps its HUD and focused controls even when map tools
  // are collapsed or the workspace is showing only the map.
  if (state.flightSession) chrome.append(flightHudOverlay(context));
  if (state.mapOnly) return;
  if (!state.mapControlsOpen) {
    if (state.mapAuthoring) chrome.append(mapAuthoringGuide(context));
    if (state.temporaryEdit) chrome.append(temporaryEditGuide(context));
    if (state.queryDrawing) chrome.append(queryDrawingGuide(context));
    if (state.measureMode) chrome.append(measurementGuide(context));
    return;
  }
  const mapCanvas = state.map?.getCanvas?.();
  if (mapCanvas) mapCanvas.style.cursor = state.mapAuthoring || state.queryDrawing || state.measureMode || state.temporaryEdit ? "crosshair" : "";

  const right = document.createElement("div");
  right.className = "gis-map-control-stack";
  right.dataset.expanded = "true";
  const heading = document.createElement("div");
  heading.className = "gis-controller-heading";
  const close = iconButton("Hide map controls", "×", () => {
    state.mapControlsOpen = false;
    context.render();
    const menu = context.shell.querySelector('.gis-controls-command');
    if (menu?.getClientRects().length) menu.focus();
    else context.shell.querySelector('.gis-mobile-toolbar [data-primary-command="more"]')?.focus();
  });
  close.classList.add("gis-controls-close");
  heading.append(textElement("span", "Map controls"), close);
  right.append(heading);
  const camera = CameraControls(() => state.map);
  context.cameraControls = camera;
  context.updateCameraControls = camera.update;
  const modeButton = (key, title, label, action) => {
    const button = iconButton(title, label, action);
    button.dataset.mapMode = key;
    button.dataset.mapSecondary = "true";
    button.setAttribute("aria-pressed", String(Boolean(state[key])));
    return button;
  };
  right.append(
    camera.element,
    iconButton("Zoom in", "+", () => state.map?.zoomIn()),
    iconButton("Zoom out", "-", () => state.map?.zoomOut()),
    modeButton("globe", state.globe ? "Mercator projection" : "Globe projection", "Globe", () => toggleProjection(context)),
    modeButton("terrainEnabled",
      state.terrainEnabled ? "Disable 3D terrain" : state.terrainFallback ? "Retry 3D terrain" : "Enable 3D terrain",
      "Terrain",
      () => toggleTerrain(context)
    ),
    modeButton("openScene3dEnabled",
      state.openScene3dEnabled ? "Disable open 3D scene" : "Enable open 3D scene",
      "Buildings",
      () => toggleOpenScene3d(context)
    ),
    iconButton("Change basemap", "Basemap", () => openBasemapChooser(context)),
    modeButton("graticule", state.graticule ? "Hide graticule" : "Show graticule", "Grid", () => {
      state.graticule = !state.graticule;
      setStatus(context, state.graticule ? "Graticule enabled." : "Graticule hidden.");
      context.render();
    }),
    modeButton("rightOpen", state.rightOpen ? "Hide inspector" : "Show inspector", "Panel", () => {
      state.rightOpen = !state.rightOpen;
      context.render();
    })
  );

  const terrain = currentTerrainActivation(state);
  const buildings = currentOpenScene3dActivation(state);
  const viewHelp = document.createElement("details");
  viewHelp.className = "gis-map-view-help";
  viewHelp.append(textElement("summary", "Map view options"));
  viewHelp.append(textElement("p", "Globe changes the projection. Terrain adds elevation; Buildings adds buildings and woodland. Neither replaces your basemap. Grid shows latitude and longitude."));
  viewHelp.append(textElement("p", `Source checks — terrain: ${OPEN_TERRAIN_SOURCE.observedAt.slice(0, 10)}; buildings: ${OPEN_3D_SCENE_SOURCE.observedAt.slice(0, 10)}.`));
  viewHelp.append(textElement("p", "Terrain and buildings load directly from public providers without an API key. These live backgrounds are not archived project data; availability and coverage depend on the provider."));
  if ([terrain.status, buildings.status].includes("source-review-due")) {
    viewHelp.append(textElement("p", "A recorded source check is due for review. Interactive viewing remains available."));
  }
  for (const [key, enabled, allowed, reason] of [
    ["terrainEnabled", state.terrainEnabled, terrain.allowed, terrainGovernanceMessage(terrain)],
    ["openScene3dEnabled", state.openScene3dEnabled, buildings.allowed, openScene3dGovernanceMessage(buildings.status)]
  ]) {
    const control = right.querySelector(`[data-map-mode="${key}"]`);
    const retryable = (key === "terrainEnabled" ? terrain.status : buildings.status) === "source-outage";
    const unavailable = !enabled && ((!allowed && !retryable) || state.spatialBody.id !== "earth" || !state.globe);
    control.disabled = unavailable;
    if (unavailable) {
      const explanation = state.spatialBody.id !== "earth" ? "Available for Earth maps only." : !allowed ? reason : "Turn on Globe first.";
      control.title = `${control.textContent}: ${explanation}`;
      viewHelp.append(textElement("p", `${control.textContent}: ${explanation}`));
    }
  }
  if (!terrain.allowed || !buildings.allowed) viewHelp.querySelector("summary").textContent = "3D availability";
  right.append(viewHelp);

  const plugins = activePluginOverlay(context);
  chrome.append(right);
  const basemapAlert = basemapRuntimeAlert(context);
  if (basemapAlert) chrome.append(basemapAlert);
  if (state.mapAuthoring) chrome.append(mapAuthoringGuide(context));
  if (state.temporaryEdit) chrome.append(temporaryEditGuide(context));
  if (state.queryDrawing) chrome.append(queryDrawingGuide(context));
  if (state.measureMode) chrome.append(measurementGuide(context));
  if (plugins) chrome.append(plugins);
}

function projectionDisclosure(context) {
  const {state} = context;
  const disclosure = document.createElement("span");
  disclosure.className = "gis-projection-disclosure";
  disclosure.role = "status";
  disclosure.ariaLive = "polite";
  disclosure.append(document.createTextNode(
    state.globe
      ? state.terrainEnabled
        ? "Globe · atmosphere · open terrain on · verified local source receipt · "
        : state.terrainFallback
          ? `Globe · atmosphere · terrain unavailable · ${terrainGovernanceLabel(state.terrainFallbackReason)}`
          : "Globe · atmosphere · 3D terrain off"
      : "Mercator · accessible 2D fallback"
  ));
  if (state.globe && state.terrainEnabled) {
    const attribution = document.createElement("a");
    attribution.href = OPEN_TERRAIN_SOURCE.attributionUrl;
    attribution.target = "_blank";
    attribution.rel = "noreferrer noopener";
    attribution.textContent = "© Mapterhorn";
    disclosure.append(attribution);
  }
  if (state.globe && state.openScene3dEnabled) {
    disclosure.append(document.createTextNode(" · open buildings + woodland canopy · "));
    for (const [index, link] of OPEN_3D_SCENE_SOURCE.attributionLinks.entries()) {
      if (index > 0) disclosure.append(document.createTextNode(" · "));
      const attribution = document.createElement("a");
      attribution.href = link.url;
      attribution.target = "_blank";
      attribution.rel = "noreferrer noopener";
      attribution.textContent = link.label;
      disclosure.append(attribution);
    }
    disclosure.append(document.createTextNode(" · individual trees unavailable"));
  } else if (state.globe && state.openScene3dFallback) {
    disclosure.append(document.createTextNode(
      ` · open 3D scene unavailable · ${openScene3dGovernanceLabel(state.openScene3dFallbackReason)}`
    ));
  }
  return disclosure;
}

function mapAuthoringGuide(context) {
  const {state} = context;
  const draft = state.mapAuthoring;
  const guide = document.createElement("section");
  guide.className = "gis-map-authoring-guide";
  guide.dataset.authoringKind = draft.kind;
  guide.role = "status";
  guide.ariaLive = "polite";
  const label = draft.kind === "LineString" ? "Draw path" : draft.kind === "image-overlay" ? "Place image overlay" : `Draw ${draft.kind.toLowerCase()}`;
  guide.append(
    textElement("strong", label),
    textElement("span", mapAuthoringInstruction(draft))
  );
  const actions = document.createElement("div");
  actions.className = "gis-map-authoring-actions";
  const undo = actionButton("Undo vertex", () => undoMapAuthoringPoint(context));
  undo.disabled = !draft.coordinates.length;
  if (draft.kind !== "Point") {
    const finishLabel = draft.kind === "LineString"
      ? "Finish path"
      : draft.kind === "Polygon"
        ? "Finish polygon"
        : "Use extent";
    const finish = actionButton(finishLabel, () => finishMapAuthoring(context));
    finish.disabled = !mapAuthoringCanFinish(draft);
    actions.append(finish, undo);
  }
  actions.append(actionButton("Cancel drawing", () => cancelMapAuthoring(context)));
  guide.append(actions);
  return guide;
}

function queryDrawingGuide(context) {
  const drawing = context.state.queryDrawing;
  const guide = document.createElement("section");
  guide.className = "gis-map-authoring-guide gis-query-drawing-guide";
  guide.dataset.queryGeometry = drawing.kind;
  guide.role = "status";
  guide.ariaLive = "polite";
  const drawingLabel = ({
    LineString: "query line",
    MultiPoint: "multiple-point query",
    Box: "box query"
  })[drawing.kind] ?? `${drawing.kind.toLowerCase()} query`;
  guide.append(
    textElement("strong", `Draw ${drawingLabel}`),
    textElement("span", queryDrawingInstruction(drawing))
  );
  const actions = document.createElement("div");
  actions.className = "gis-map-authoring-actions";
  const finish = actionButton("Finish selection", () => finishQueryDrawing(context));
  finish.disabled = !queryDrawingCanFinish(drawing);
  const undo = actionButton("Undo vertex", () => undoQueryDrawingPoint(context));
  undo.disabled = !drawing.coordinates.length;
  if (drawing.kind !== "Point") actions.append(finish, undo);
  actions.append(actionButton("Cancel", () => cancelQueryDrawing(context)));
  guide.append(actions);
  return guide;
}

function measurementGuide(context) {
  const {state} = context;
  const editing = state.editingMeasurementId !== null;
  const kind = measurementKindDefinition(state.measurementKind);
  const guide = document.createElement("section");
  guide.className = "gis-map-authoring-guide gis-measurement-guide";
  guide.dataset.authoringKind = `${kind.id}-measurement`;
  guide.role = "status";
  guide.ariaLive = "polite";
  const facts = draftMeasurementFacts(state);
  guide.append(
    textElement("strong", editing ? `Edit ${kind.label.toLowerCase()}` : `Measure ${kind.label.toLowerCase()}`),
    textElement(
      "span",
      facts ?? `${state.measurePoints.length} of ${kind.minimumLabel} · click the map to continue`
    )
  );
  const actions = document.createElement("div");
  actions.className = "gis-map-authoring-actions";
  const finish = actionButton(editing ? "Update measurement" : "Save measurement", () => finishMeasurement(context));
  finish.disabled = state.measurePoints.length < kind.minimumPoints;
  const undo = actionButton("Undo vertex", () => undoMeasurementPoint(context));
  undo.disabled = !state.measurePoints.length;
  actions.append(finish, undo, actionButton("Cancel", () => stopMeasurement(context)));
  guide.append(actions);
  return guide;
}

function activePluginOverlay(context) {
  const {state} = context;
  const enabled = [...state.pluginState].filter(id => id !== "time");
  if (!enabled.length) return null;
  const overlay = document.createElement("div");
  overlay.className = "gis-plugin-overlay";
  overlay.append(textElement("strong", "Active plugins"));
  for (const id of enabled) {
    const plugin = PLUGINS.find(([pluginId]) => pluginId === id);
    if (plugin) overlay.append(textElement("span", plugin[1]));
  }
  return overlay;
}

function renderRightPanel(panel, context) {
  const {state} = context;
  panel.replaceChildren();

  const header = document.createElement("div");
  header.className = "gis-panel-header";
  header.append(textElement("h2", panelTitle(state.activePanel)));
  header.append(iconButton("Collapse inspector", "Hide", () => {
    state.rightOpen = false;
    context.render();
  }));

  const switcher = context.rendererAdapter.id === "cesium" ? null : inspectorSwitcher(context);
  panel.append(header);
  if (switcher) panel.append(switcher);
  panel.append(panelBody(context));
}

function panelTitle(panel) {
  return ({
    style: "Layer Properties",
    attributes: "Attribute Table",
    basemap: "Basemap Studio",
    add: "Add data",
    processing: "Processing Toolbox",
    query: "Query",
    identify: "Identify Results",
    measure: "Measurements & Elevation",
    temporary: "Temporary Work",
    history: "Historical Imagery",
    tour: "Camera Tour",
    flight: "Flight Simulator",
    controls: "Map Controls",
    catalog: "Data catalog",
    sql: "SQL Workspace",
    renderer: "Rendering engine",
    settings: "Settings",
    help: "Help"
  })[panel] ?? "Style";
}

function inspectorSwitcher(context) {
  const {state} = context;
  if (!["style", "attributes"].includes(state.activePanel)) return null;
  const layer = activeLayer(context);
  const tabs = document.createElement("div");
  tabs.className = "gis-inspector-tabs";
  tabs.append(
    inspectorTab("Style", state.activePanel === "style", () => {
      state.activePanel = "style";
      context.render();
    }),
    inspectorTab("Table", state.activePanel === "attributes", () => {
      state.activePanel = "attributes";
      context.render();
    }),
    actionButton("Zoom", () => fitLayer(state.map, layer, context.dataByLayerId)),
    actionButton("Remove", () => removeLayer(context, layer))
  );
  tabs.lastElementChild?.classList.add("danger");
  return tabs;
}

function inspectorTab(label, active, action) {
  const button = actionButton(label, action);
  button.classList.toggle("active", active);
  return button;
}

function panelBody(context) {
  if (context.state.activePanel === "renderer") {
    context.rendererPanel ??= RendererPanel({
      session: context.mapboxSession,
      current: () => context.rendererAdapter.id,
      preferred: () => context.rendererPreference ?? context.project?.extensions?.opengeoRenderer?.id ?? "maplibre",
      report: (id="mapbox") => id === "cesium" ? cesiumWorkbenchContent(context)
        : mapboxCompatibility({layers:context.layers, state:context.state, style:context.state.map?.getStyle?.()}),
      status: () => ({...context.rendererSwitchStatus, paused:Boolean(context.rendererSuspended)}),
      onSwitch: id => switchRenderingEngine(context, id),
      onCancel: () => context.cancelRendererSwitch?.()
    });
    context.rendererPanel.update();
    return context.rendererPanel;
  }
  if(context.rendererAdapter.id === "cesium") return cesiumDetailsPanel(context);
  if (context.state.activePanel === "attributes") return attributesPanel(context);
  if (context.state.activePanel === "basemap") return basemapPanel(context);
  if (context.state.activePanel === "add") return addDataPanel(context);
  if (context.state.activePanel === "processing") return processingPanel(context);
  if (context.state.activePanel === "query") return queryPanel(context);
  if (context.state.activePanel === "identify") return identifyPanel(context);
  if (context.state.activePanel === "measure") return measurementPanel(context);
  if (context.state.activePanel === "temporary") return temporaryWorkPanel(context);
  if (context.state.activePanel === "history") return historicalImageryPanel(context);
  if (context.state.activePanel === "tour") return cameraTourPanel(context);
  if (context.state.activePanel === "flight") return flightSimulatorPanel(context);
  if (context.state.activePanel === "controls") return controlsPanel(context);
  if (context.state.activePanel === "catalog") return catalogPanel(context);
  if (context.state.activePanel === "sql") return sqlPanel(context);
  if (context.state.activePanel === "settings") return settingsPanel(context);
  if (context.state.activePanel === "help") return helpPanel(context);
  return stylePanel(context);
}

function stylePanel(context) {
  const {state} = context;
  const layer = activeLayer(context);
  const panel = panelShell();
  if (!layer) {
    panel.append(textElement("p", "Select a layer to edit its style."));
    return panel;
  }
  const libraryLink = textElement("a", context.demoSurface ? "Styles library in Studio ↗" : "Styles library ↗");
  libraryLink.className = "gis-style-library-link";
  libraryLink.href = context.demoSurface
    ? new URL(directoryHref({view: "styles"}), MANAGED_STUDIO_URL).href
    : directoryHref({view: "styles", adapterKind: fixtureAdapterKind(context.persistenceMode)});
  // Keep the map and unsaved edits available while inspecting reusable Styles.
  libraryLink.target = "_blank"; libraryLink.rel = "noopener";
  panel.append(libraryLink);

  if (layer.sourceType === "cog-raster") {
    panel.append(layerNameEditor(context, layer),
      textElement("p", layer.sourceConfiguration?.license ? `Distribution terms: ${layer.sourceConfiguration.license}` : "Distribution terms were not supplied."),
      textElement("p", "The map reads a bounded image window from the original raster. Pan or zoom, then refresh to read another window."),
      cogDisplayEditor(context, layer),
      opacityEditor(context, layer));
    if (layer.styleReference) panel.append(textElement("p", "The saved Style reference is preserved; this raster preview does not apply vector Styles."));
    return panel;
  }

  if (layer.geometryType === "Point" || layer.pointClustering) panel.append(pointClusteringEditor(context, layer));
  const pointInlineSymbology = !layer.styleReference && isPointSymbolLayer(layer);
  if (pointInlineSymbology) panel.append(symbologyEditor(context, layer, context.dataByLayerId.get(layer.layerId), "circleColor"));

  if(layer.sourceType==="governed-dataset" && layer.datasetVersionId
    && ["admin","owner","editor"].includes(context.role)
    && context.styleAdapter?.listDatasetVersions && context.styleAdapter?.getCatalogDataset
    && context.loadDatasetVersionPreview) {
    context.versionPickers ??= new WeakMap();
    if(!context.versionPickers.has(layer)) {
      const parts=()=> {
        const ids=new Set(state.layerHandles.get(layer.layerId)?.layerIds??[]);
        return (state.map?.getStyle()?.layers??[]).filter(part=>ids.has(part.id));
      };
      context.versionPickers.set(layer,LayerVersionPicker({adapter:context.styleAdapter,layer,renderedParts:parts,
        onApply:async(version,compatible)=>{
          const identity=persistedLayerSourceIdentity(layer);
          const map=state.map;
          if(context.disposed || !context.layers.includes(layer) || !map?.isStyleLoaded() || context.layerArchiveModes.has(layer.layerId))
            throw Error("Return to the live Project map before changing its version.");
          const beforePresentation=JSON.stringify([layer.style,layer.styleReference,layer.labels,parts()]);
          const preview=await context.loadDatasetVersionPreview(layer.datasetId,version.id,version.geometryType);
          if(preview.datasetVersionId!==version.id || preview.mayBeTruncated)throw Error("The complete selected version could not load.");
          if(!isCurrentPersistedLayer(context,layer,identity) || state.map!==map || !map.isStyleLoaded()
            || beforePresentation!==JSON.stringify([layer.style,layer.styleReference,layer.labels,parts()]) || !compatible())
            throw Error("The Layer changed while loading. Review the version again.");
          const previous={datasetVersionId:layer.datasetVersionId,sourceVersion:layer.sourceVersion};
          const data=context.dataByLayerId.get(layer.layerId);
          const filters=parts().filter(p=>p.filter).map(p=>[p.id,p.filter]);
          const install=()=>{addMapLayer(state,layer,context.dataByLayerId.get(layer.layerId),context.datasets);
            for(const [id,filter] of filters)if(map.getLayer(id))map.setFilter(id,filter);syncLayerOrder(context);};
          removeMapLayer(state,layer.layerId);
          try {
            layer.datasetVersionId=version.id;layer.sourceVersion=version.versionNumber;
            context.dataByLayerId.set(layer.layerId,preview.geojson);install();
          } catch(error) {
            removeMapLayer(state,layer.layerId);Object.assign(layer,previous);
            context.dataByLayerId.set(layer.layerId,data);install();throw error;
          }
          setStatus(context,"Selected data version applied. Save the Project to retain this pin.");
          context.render();
        }}));
    }
    panel.append(context.versionPickers.get(layer));
  }

  if (layer.sourceType === "governed-dataset" && context.styleAdapter
    && ["admin", "owner", "editor"].includes(context.role)) {
    // Keep on-demand results and pending selections across unrelated Layer/map
    // refreshes. Each working Layer owns its picker for this workbench lifetime.
    context.stylePickers ??= new WeakMap();
    if (!context.stylePickers.has(layer)) context.stylePickers.set(layer, LayerStylePicker({adapter: context.styleAdapter, layer, onApply: (reference, resolved) => {
      if (!context.layers.includes(layer)) throw Error("Layer removed");
      context.styleRequests?.delete(layer.layerId);
      const previousReference = layer.styleReference;
      const previousResolved = state.resolvedLayerStyles.get(layer.layerId);
      removeMapLayer(state, layer.layerId);
      try {
        layer.styleReference = structuredClone(reference);
        state.resolvedLayerStyles.set(layer.layerId, resolved);
        state.layerStyleErrors.delete(layer.layerId);
        if (state.map?.isStyleLoaded()) {
          addMapLayer(state, layer, context.dataByLayerId.get(layer.layerId), context.datasets);
          syncLayerOrder(context);
        }
      } catch (error) {
        // Remove any partially installed passes before restoring the prior presentation.
        if (state.map) for (let i = 0; i < resolved.parts.length; i++) {
          const id = `${layer.layerId}-style-${i}`;
          if (state.map.getLayer(id)) state.map.removeLayer(id);
        }
        state.layerHandles.delete(layer.layerId);
        if (previousReference) layer.styleReference = previousReference;
        else delete layer.styleReference;
        if (previousResolved) state.resolvedLayerStyles.set(layer.layerId, previousResolved);
        else state.resolvedLayerStyles.delete(layer.layerId);
        if (state.map?.isStyleLoaded()) {
          addMapLayer(state, layer, context.dataByLayerId.get(layer.layerId), context.datasets);
          syncLayerOrder(context);
        }
        throw error;
      }
      setStatus(context, "Pinned Style applied to this composition. Save the Project to retain it.");
      context.render();
    }}));
    panel.append(context.stylePickers.get(layer));
  }

  const filterData=context.dataByLayerId.get(layer.layerId);
  if(filterData && ["admin","owner","editor"].includes(context.role))panel.append(MapFilterEditor({layer,fields:propertyFields(filterData),
    onApply:filter=>setLayerFilter(context,layer,filter,filter?"updated":"cleared")}));

  if (layer.styleReference) {
    const ref = layer.styleReference;
    panel.append(textElement("h3", "Referenced Style"), textElement("p", `Style ${ref.styleId} · version ${ref.versionNumber}`),
      textElement("p", state.layerStyleErrors.get(layer.layerId) ?? (state.resolvedLayerStyles.has(layer.layerId)
        ? "The exact saved Style is active. Inline style controls do not alter this binding."
        : "Resolving the selected Style version…")),
      actionButton("Reload selected Style", () => void loadBoundLayerStyle(context, layer)));
    const legend = rendererLegend(layer, context.dataByLayerId.get(layer.layerId), state.resolvedLayerStyles.get(layer.layerId));
    if (legend) panel.append(legend);
    if (["admin", "owner", "editor"].includes(context.role)) panel.append(actionButton("Use previous inline styling", () => {
      context.styleRequests?.delete(layer.layerId);
      removeMapLayer(state, layer.layerId);
      delete layer.styleReference;
      state.resolvedLayerStyles.delete(layer.layerId);
      state.layerStyleErrors.delete(layer.layerId);
      if (state.map?.isStyleLoaded()) {
        addMapLayer(state, layer, context.dataByLayerId.get(layer.layerId), context.datasets);
        syncLayerOrder(context);
      }
      setStatus(context, "Style reference removed from this composition. Previous inline styling restored; save the Project to retain the change.");
      context.render();
    }));
    if (["admin", "owner", "editor"].includes(context.role)) panel.append(opacityEditor(context, layer));
    return panel;
  }

  const geojson = context.dataByLayerId.get(layer.layerId);
  const fields = propertyFields(geojson);
  const colorKey = layer.geometryType?.includes("Point") ? "circleColor" : layer.geometryType?.includes("Polygon") ? "fill" : "stroke";

  if (!pointInlineSymbology) panel.append(symbologyEditor(context, layer, geojson, colorKey));
  panel.append(
    layerNameEditor(context, layer, geojson),
    labelEditor(context, layer, fields),
    layerActionEditor(context, layer, geojson)
  );

  if (!canEditInlineStyle(context, layer)) {
    panel.classList.add("gis-style-readonly");
    panel.prepend(textElement("p", "View-only Project. An editor can change its symbology."));
    for (const control of panel.querySelectorAll("button,input,select,textarea")) control.disabled = true;
    for (const type of ["input", "change", "click"]) panel.addEventListener(type, event => {
      if (event.target.closest("a")) return;
      if (!canEditInlineStyle(context, layer)) {event.preventDefault(); event.stopImmediatePropagation();}
    }, true);
  }

  return panel;
}

function layerNameEditor(context, layer, geojson) {
  const dataset = context.datasets.find((candidate) => candidate.datasetId === layer.datasetId);
  const section = editorSection("Layer identity", "Names should read clearly in the layer stack, popups, labels, and exported project records.");
  section.append(
    textField("Layer name", layer.title, (value) => {
      layer.title = value || "Untitled layer";
      setStatus(context, `Layer renamed to ${layer.title}.`);
      context.render();
    }),
    textField("Layer note", layer.description ?? dataset?.description ?? "", (value) => {
      layer.description = value;
      setStatus(context, "Layer note updated.");
    }, {placeholder: "Short purpose, source, or review note"}),
    compactKeyValues({
      "Source": layer.sourceType,
      "Geometry": layer.geometryType ?? "unknown",
      "Features": geojson?.features?.length ?? dataset?.featureCount ?? "not loaded"
    })
  );
  return section;
}

function symbologyEditor(context, layer, geojson, colorKey) {
  const fields = propertyFields(geojson);
  const numericFields = safeNumericPropertyFields(geojson);
  const section = editorSection("Symbology", "Use a single symbol for simple context layers, or classify features by a meaningful attribute.");
  if (isPointSymbolLayer(layer)) section.append(pointSymbolEditor(context, layer, geojson));
  const rendererOptions = [
    ["single", "Single symbol"],
    ...(hasStatusField(geojson) ? [["status", "Status categories"]] : []),
    ...(fields.length ? [["category", "Categorized field"]] : []),
    ...(numericFields.length ? [["graduated", "Graduated numeric field"]] : [])
  ];
  const renderer = layer.style.renderer ?? (hasStatusField(geojson) ? "status" : "single");

  section.append(selectField("Renderer", renderer, rendererOptions, (value) => {
    layer.style.renderer = value;
    if (value === "category" && !layer.style.categoryField) layer.style.categoryField = fields[0];
    if (value === "graduated") {
      layer.style.graduated = validGraduatedStyle(layer.style.graduated, numericFields[0]);
    }
    repaintLayer(context, layer);
    context.render();
  }));

  if ((layer.style.renderer ?? renderer) === "category") {
    section.append(selectField("Category field", layer.style.categoryField ?? fields[0] ?? "", fields.map((field) => [field, field]), (field) => {
      layer.style.categoryField = field;
      repaintLayer(context, layer);
      context.render();
    }));
  }

  if ((layer.style.renderer ?? renderer) === "graduated") {
    const graduated = validGraduatedStyle(layer.style.graduated, numericFields[0]);
    layer.style.graduated = graduated;
    section.append(selectField(
      "Numeric field",
      graduated.field,
      numericFields.map((field) => [field, field]),
      (field) => {
        layer.style.graduated = {...graduated, field};
        repaintLayer(context, layer);
        context.render();
      }
    ));
  }

  if ((layer.style.renderer ?? renderer) === "graduated") {
    section.append(colorInput(
      "No-data color",
      layer.style.graduated.noDataColor,
      (value) => {
        layer.style.graduated = {...layer.style.graduated, noDataColor: value};
        repaintLayer(context, layer);
        context.render();
      }
    ));
  } else {
    section.append(colorInput("Primary color", layer.style?.[colorKey] ?? layerColor(layer), (value) => {
      applyPrimaryColor(layer, value);
      repaintLayer(context, layer);
      context.render();
    }));
  }

  section.append(palettePicker(context, layer, geojson, colorKey));

  if (layer.geometryType?.includes("Polygon")) {
    section.append(colorInput("Outline color", layer.style?.stroke ?? darker(layer.style?.fill ?? layerColor(layer), 0.24), (value) => {
      layer.style.stroke = value;
      repaintLayer(context, layer);
    }));
  }

  if (layer.geometryType?.includes("Point")) {
    section.append(rangeInput("Point radius", {
      min: 2,
      max: 24,
      step: 1,
      value: layer.style?.circleRadius ?? 6,
      onInput: (value) => {
        layer.style.circleRadius = value;
        repaintLayer(context, layer);
      }
    }));
  } else {
    section.append(rangeInput("Stroke width", {
      min: 1,
      max: 14,
      step: 1,
      value: layer.style?.strokeWidth ?? 3,
      onInput: (value) => {
        layer.style.strokeWidth = value;
        repaintLayer(context, layer);
      }
    }));
  }

  section.append(opacityEditor(context, layer));
  if (isPointSymbolLayer(layer)) section.append(pointSymbolBatchEditor(context, layer));
  const legend = rendererLegend(layer, geojson, context.state.resolvedLayerStyles?.get(layer.layerId));
  if (legend) section.append(legend);
  return section;
}

function openLayerSymbology(context, layer) {
  context.state.activeLayerId = layer.layerId;
  context.state.activePanel = "style";
  context.state.rightOpen = true;
  context.render();
}

function isPointSymbolLayer(layer) {
  return ["Point", "MultiPoint"].includes(layer?.geometryType) && layer.sourceType !== "kml-places";
}

function canEditInlineStyle(context, layer) {
  return !context.disposed && context.layers.includes(layer) && !layer.styleReference
    && (context.publicDemo || context.landingMode || context.role === "local"
      || ["admin", "owner", "editor"].includes(context.role));
}

function pointSymbolPreview(style, label) {
  const image = document.createElement("img"); image.width = 40; image.height = 40; image.alt = label;
  const preview = {pointSymbol: style?.pointSymbol ?? "circle", circleColor: style?.circleColor};
  void ensurePointSymbolAssets(preview).then(() => {
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pointSymbolPreviewSvg(preview))}`;
  }).catch(() => {image.alt = `${label || "Symbol"} preview unavailable`;});
  return image;
}

function loadInlinePointSymbolAssets(context, layer) {
  if (context.disposed || context.pendingPointSymbolLayers.has(layer.layerId)) return;
  const request = {layer, signature: JSON.stringify(layer.style)};
  context.pendingPointSymbolLayers.set(layer.layerId, request);
  setStatus(context, "Loading point symbols…");
  void ensurePointSymbolAssets(layer.style).then(() => {
    if (context.disposed || !context.layers.includes(layer)) return;
    context.pendingPointSymbolLayers.delete(layer.layerId);
    installCachedDatasetLayers(context);
    setStatus(context, "Point symbols ready.");
  }).catch(() => {
    if (!context.disposed && context.layers.includes(layer) && JSON.stringify(layer.style) === request.signature) {
      context.state.rendererLayerIssues ??= new Map();
      context.state.rendererLayerIssues.set(layer.layerId, "Point symbols could not load. Reload to try again; the Layer is preserved.");
      setStatus(context, "Point symbols could not load. Reload to try again.");
    }
  }).finally(() => {
    if (context.pendingPointSymbolLayers.get(layer.layerId) === request) context.pendingPointSymbolLayers.delete(layer.layerId);
    if (!context.disposed) {context.render();signalPublicationMapReadiness(context);}
  });
}

async function openPointSymbolLibrary(context, layer, category = null) {
  if (!canEditInlineStyle(context, layer)) return;
  context.pointSymbolDialog?.dispose?.();
  const dialog = document.createElement("dialog");
  dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Symbol library");dialog.dataset.colorMode = context.state.colorMode;
  let gallery;
  const close = () => {gallery?.dispose?.();dialog.close?.();dialog.remove();if (context.pointSymbolDialog === dialog) context.pointSymbolDialog = null;};
  dialog.dispose = close;dialog.oncancel = event => {event.preventDefault();close();};
  dialog.append(textElement("h2", category === null ? "Choose a point symbol" : `Symbol for ${category}`), actionButton("Close", close));
  const progress = document.createElement("progress");progress.setAttribute("aria-label", "Loading symbol library");dialog.append(progress);
  context.pointSymbolDialog = dialog;document.body.append(dialog);
  if (dialog.showModal) dialog.showModal();else dialog.open = true;
  try {
    const [{SymbologyGallery}, {symbologyCatalog, symbologyPreview}] = await Promise.all([
      import("./SymbologyGallery.js"), import("../lib/symbologyCatalog.js")]);
    if (context.disposed || context.pointSymbolDialog !== dialog) return;
    gallery = SymbologyGallery({entries: symbologyCatalog().filter(entry => entry.kind === "point"), preview: symbologyPreview,
      selectedId: `point:${category === null ? layer.style.pointSymbol ?? "circle" : layer.style.categorySymbols?.[category] ?? layer.style.pointSymbol ?? "circle"}`,
      onChoose: async entry => {
        await ensurePointSymbolAssets(entry.recipe.style);
        if (context.disposed || !context.layers.includes(layer) || !canEditInlineStyle(context, layer)) return false;
        const radius = layer.style.circleRadius ?? 6;
        layer.style = normalizePointSymbolStyle({...layer.style, circleRadius: Math.min(24,Math.max(2,Number.isFinite(radius)?radius:6)),
          ...(category === null ? {pointSymbol: entry.recipe.style.pointSymbol}
            : {categorySymbols: {...layer.style.categorySymbols,[category]:entry.recipe.style.pointSymbol}})});
        if (context.state.layerHandles.has(layer.layerId)) repaintLayer(context,layer);else installCachedDatasetLayers(context);
        setStatus(context, `${entry.title} selected. Save the Project to keep it.`);context.render();close();
        return true;
      }});
    progress.replaceWith(gallery);
  } catch {progress.replaceWith(textElement("p", "The symbol library could not load. Close and reopen it to try again."));}
}

function pointSymbolEditor(context, layer, geojson) {
  const root = document.createElement("div"), grid = document.createElement("div");
  grid.className = "gis-point-symbol-grid"; grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Point symbols");
  root.append(textElement("h4", "Point symbol"), grid);
  const selected = layer.style.pointSymbol ?? "circle";
  for (const symbol of POINT_SYMBOLS.filter((symbol,index) => index < 6 || symbol.id === selected)) {
    const button = actionButton(symbol.label, () => {
      if (!canEditInlineStyle(context, layer)) return;
      try {
        const radius = layer.style.circleRadius ?? 6;
        layer.style = normalizePointSymbolStyle({...layer.style, pointSymbol: symbol.id,
          circleRadius: Math.min(24, Math.max(2, Number.isFinite(radius) ? radius : 6))});
      } catch {
        setStatus(context, "This Layer uses a category field outside the built-in symbol limits. Choose a supported field before adding a symbol."); return;
      }
      repaintLayer(context, layer); setStatus(context, `${symbol.label} symbol selected. Save the Project to keep it.`); context.render();
    });
    button.className = "gis-point-symbol-choice"; button.setAttribute("aria-label", `${symbol.label} point symbol`);
    button.setAttribute("aria-pressed", String(symbol.id === selected)); button.disabled = !canEditInlineStyle(context, layer);
    button.prepend(pointSymbolPreview({...layer.style, pointSymbol: symbol.id}, "")); grid.append(button);
  }
  const browse = actionButton("Browse symbol library…", () => {void openPointSymbolLibrary(context,layer);});
  browse.className = "gis-point-symbol-library";browse.disabled = !canEditInlineStyle(context,layer);root.append(browse);
  if (layer.style.renderer === "category" && layer.style.categoryField) {
    const categories = document.createElement("div"); categories.className = "gis-point-category-symbols";
    categories.append(textElement("h4", `Symbols by ${layer.style.categoryField}`));
    for (const value of topFieldValues(geojson, layer.style.categoryField, 48)
      .filter(value => value.length <= 128 && !["__proto__", "prototype", "constructor"].includes(value) && !/[\u0000-\u001f\u007f]/.test(value))) {
      const control = selectField(`Symbol for ${value}`, layer.style.categorySymbols?.[value] ?? selected,
        POINT_SYMBOLS.filter((item,index) => index < 6 || item.id === (layer.style.categorySymbols?.[value] ?? selected)).map(({id, label}) => [id, label]), symbol => {
          if (!canEditInlineStyle(context, layer)) return;
          layer.style = normalizePointSymbolStyle({...layer.style, categorySymbols: {...layer.style.categorySymbols, [value]: symbol}});
          repaintLayer(context, layer); setStatus(context, `Symbol for ${value} updated. Save the Project to keep it.`); context.render();
        });
      control.querySelector("select").disabled = !canEditInlineStyle(context, layer); categories.append(control);
      const browseCategory=actionButton(`Browse symbols for ${value}…`,()=>{void openPointSymbolLibrary(context,layer,value);});
      browseCategory.disabled=!canEditInlineStyle(context,layer);categories.append(browseCategory);
    }
    categories.append(textElement("p", "Choose a symbol for each displayed category. Other values use the default point symbol; colors retain the selected palette."));
    root.append(categories);
  }
  return root;
}

function pointClusteringEditor(context, layer) {
  const section = editorSection("Point clustering", "Group nearby points on screen as you zoom. Each Layer groups independently; source records and symbols stay saved. This is a display preference, not a ground-distance analysis.");
  section.classList.add("gis-point-clustering");
  const current = pointClusteringOptions(layer), editable = ["admin", "owner", "editor"].includes(context.role);
  const issueFor = candidate => pointClusteringIssue(candidate, context.dataByLayerId.get(candidate.layerId), {archive: context.state.archiveTileSessions?.has(candidate.layerId), renderer: context.rendererAdapter.id});
  const issue = issueFor(layer);
  const enabled = document.createElement("input");enabled.type = "checkbox";enabled.checked = current.enabled;
  enabled.setAttribute("aria-label", "Cluster points as you zoom");enabled.disabled = !editable || Boolean(issue) && !current.enabled;
  const label = document.createElement("label");label.append(enabled, " Cluster points as you zoom");section.append(label);
  const radius = document.createElement("input"), maxZoom = document.createElement("input");
  for (const [input, title, value, min, max] of [[radius, "Grouping radius (screen pixels)", current.radius, 16, 100], [maxZoom, "Last clustered zoom level", current.maxZoom, 0, 22]]) {
    input.type = "number";input.min = String(min);input.max = String(max);input.step = "1";input.value = String(value);input.setAttribute("aria-label", title);input.disabled = !editable;
    section.append(fieldWrap(title, input));
  }
  const preference = () => validatePointClustering({enabled: enabled.checked, radius: Number(radius.value), maxZoom: Number(maxZoom.value)});
  const applyTo = targets => {
    if (!editable) return;
    try {
      const value = preference();let count = 0;
      for (const target of targets) {
        if (value.enabled && issueFor(target)) continue;
        target.pointClustering = {...value};
        removeMapLayer(context.state, target.layerId);
        if (context.state.map?.isStyleLoaded()) addMapLayer(context.state, target, context.dataByLayerId.get(target.layerId), context.datasets);
        syncLayerOrder(context);count++;
      }
      setStatus(context, `Clustering ${value.enabled ? "enabled" : "disabled"} for ${count} point ${count === 1 ? "Layer" : "Layers"}. Save the Project to keep this view; Capture map frame and Save layout keeps a separate print view.`);context.render();
    } catch (error) {feedback.textContent = error.message;}
  };
  enabled.addEventListener("change", () => applyTo([layer]));
  const apply = actionButton("Apply clustering settings", () => applyTo([layer]));apply.disabled = !editable;
  const feedback = textElement("p", issue ?? "Counts show matching loaded points. Labels from 100 upward use lower-bound abbreviations such as 100+ and 1k+; click a group for its exact count and zoom in.");feedback.setAttribute("role", "status");
  section.append(apply, feedback, textElement("p", "Print Studio captures this display. Interactive HTML export and immutable server images require clustering off; the saved preference remains available."));
  const batch = document.createElement("details");batch.append(textElement("summary", "Apply clustering to selected point Layers"));
  context.pointClusteringSelection ??= new Set([layer.layerId]);const selected = context.pointClusteringSelection;
  for (const target of context.layers.filter(candidate => candidate.geometryType === "Point")) {
    const targetIssue = issueFor(target), row = document.createElement("label"), check = document.createElement("input");check.type = "checkbox";
    check.setAttribute("aria-label", `Apply clustering to ${target.title}`);check.checked = selected.has(target.layerId);check.disabled = !editable;
    check.addEventListener("change", () => {if (check.checked) selected.add(target.layerId);else selected.delete(target.layerId);});
    row.className = "gis-point-style-target";row.append(check, textElement("span", `${target.title}${targetIssue ? ` · ${targetIssue}` : ""}`));batch.append(row);
  }
  const batchApply = actionButton("Apply clustering to selected Layers", () => applyTo(context.layers.filter(target => target.geometryType === "Point" && selected.has(target.layerId))));batchApply.disabled = !editable;
  batch.append(batchApply);section.append(batch);return section;
}

function pointSymbolBatchEditor(context, layer) {
  const section = document.createElement("details"); section.className = "gis-point-style-batch";
  section.append(textElement("summary", "Apply to several point Layers"),
    textElement("p", "Apply this default symbol, color and size as a single-symbol style. Category rules stay saved for later use. Visibility checkboxes in the Layer list are separate."));
  context.pointSymbolBatchSelection ??= new Set([layer.layerId]);
  const selected = context.pointSymbolBatchSelection;
  const choices = document.createElement("div"), feedback = textElement("p", "");
  feedback.className = "gis-point-style-feedback"; feedback.setAttribute("role", "status");
  const eligible = candidate => {
    if (!isPointSymbolLayer(candidate) || !canEditInlineStyle(context, candidate)) return false;
    try {normalizePointSymbolStyle({...candidate.style, renderer: "single", pointSymbol: "circle", circleRadius: 6}); return true;}
    catch {return false;}
  };
  const update = () => {
    const count = context.layers.filter(candidate => selected.has(candidate.layerId) && eligible(candidate)).length;
    feedback.textContent = `${count} compatible point ${count === 1 ? "Layer" : "Layers"} selected.`;
    apply.disabled = !count || !canEditInlineStyle(context, layer);
  };
  for (const candidate of context.layers) {
    const label = document.createElement("label"); label.className = "gis-point-style-target";
    const check = document.createElement("input"); check.type = "checkbox";
    check.setAttribute("aria-label", `Apply point style to ${candidate.title}`);
    check.disabled = !eligible(candidate); check.checked = selected.has(candidate.layerId) && !check.disabled;
    const reason = candidate.styleReference ? "saved Style pinned" : !isPointSymbolLayer(candidate) ? `${candidate.geometryType ?? "unsupported geometry"}`
      : !canEditInlineStyle(context, candidate) ? "view-only" : !eligible(candidate) ? "symbol configuration outside supported limits" : null;
    label.append(check, textElement("span", `${candidate.title}${reason ? ` · skipped: ${reason}` : ""}`));
    check.addEventListener("change", () => {
      if (!eligible(candidate) || !canEditInlineStyle(context, layer)) return;
      if (check.checked) selected.add(candidate.layerId); else selected.delete(candidate.layerId); update();
    });
    choices.append(label);
  }
  const apply = actionButton("Apply single-symbol style to selected Layers", () => {
    if (!canEditInlineStyle(context, layer)) return;
    const source = normalizePointSymbolStyle({pointSymbol: layer.style.pointSymbol ?? "circle", circleColor: layer.style.circleColor,
      circleRadius: Math.min(24, Math.max(2, Number.isFinite(layer.style.circleRadius) ? layer.style.circleRadius : 6))});
    const targets = context.layers.filter(candidate => selected.has(candidate.layerId));
    let count = 0; const skipped = [];
    for (const candidate of targets) {
      if (!eligible(candidate)) {skipped.push(candidate.title); continue;}
      candidate.style = normalizePointSymbolStyle({...candidate.style, renderer: "single", pointSymbol: source.pointSymbol,
        circleColor: source.circleColor ?? layerColor(layer), circleRadius: source.circleRadius ?? 6});
      repaintLayer(context, candidate); count++;
    }
    setStatus(context, `Single-symbol style applied to ${count} point ${count === 1 ? "Layer" : "Layers"}.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""} Save the Project to keep these changes.`);
    context.render();
  });
  section.append(choices, feedback, apply); update(); return section;
}

function opacityEditor(context, layer) {
  const section = editorSection("Layer opacity", "Save blending with this Project’s Layer presentation.");
  section.append(rangeInput("Opacity", {
    min: 0,
    max: 1,
    step: 0.05,
    value: layer.opacity ?? 1,
    onInput: (value) => {
      layer.opacity = value;
      setLayerOpacity(context.state, layer.layerId, value);
    }
  }));

  const blending = document.createElement("select");
  blending.setAttribute("aria-label", "Opacity blending");
  for (const [value, title] of [["feature", "Per feature"], ["composite", "Composite fills and lines"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = title;
    option.disabled = value === "composite" && (context.rendererAdapter.id !== "maplibre" || !supportsCompositeOpacity(layer)); blending.append(option);
  }
  blending.value = layer.opacityMode ?? "feature";
  blending.onchange = () => {layer.opacityMode = blending.value; validateOpacityMode(layer); repaintLayer(context, layer); context.render();};
  const blendingLabel = document.createElement("label"); blendingLabel.append(textElement("span", "Opacity blending"), blending);
  section.append(blendingLabel, textElement("p", layer.opacityMode === "composite"
    ? "Opacity composites each fill and line pass separately. Labels keep their own appearance."
    : "Opacity applies to each feature; overlapping features can appear darker. Composite blending is available for supported line and polygon data Layers."));
  return section;
}

function labelEditor(context, layer, fields) {
  const section = editorSection("Labels and feature names", "Choose whether labels stay with their Layer or draw above data layers. Existing maps keep labels with their Layer.");
  const labels = layer.labels ??= {};
  const fonts = context.state.mapFontSession;
  const fontStatus = textElement("p", mapFontStatusText(context, layer));
  fontStatus.className = "gis-map-font-status";
  fontStatus.dataset.fontLayerId = layer.layerId;
  fontStatus.setAttribute("role", "status");
  const adopt = actionButton("Use Open Sans v1 for this map’s enabled labels", () => {
    for (const candidate of context.layers) {
      if (candidate === layer || candidate.labels?.enabled) {
        candidate.labels ??= {};
        candidate.labels.fontRef = {...PINNED_MAP_FONT};
      }
    }
    syncPinnedMapFonts(context);
    for (const candidate of context.layers) if (candidate.labels?.fontRef) syncLabels(context, candidate);
    setStatus(context, "Pinned Open Sans v1 for this layer and the map’s enabled labels. Save the map to record this new presentation; older saved revisions are unchanged.");
    context.render();
  });
  adopt.disabled = !fonts.available || !(context.publicDemo || context.landingMode || context.persistenceMode === "local" || canPersist(context))
    || (isRegisteredMapFont(labels.fontRef) && context.layers.every(candidate => !candidate.labels?.enabled || isRegisteredMapFont(candidate.labels.fontRef)));
  section.append(fontStatus, adopt, textElement("small", fonts.available
    ? "Selecting a font changes this map’s presentation. Save, then select that saved revision under Resources. Image publishing with this font is not enabled on every site yet."
    : "Pinned font assets are not packaged in this view. Existing saved font identities remain unchanged."));
  if (fonts.phase === "failed") section.append(actionButton("Retry pinned font read", () => {
    void fonts.prepare({retry: true}).then(() => { if (!context.disposed) context.render(); })
      .catch(() => { if (!context.disposed) context.render(); });
    context.render();
  }));
  section.append(checkField("Show labels on map", labels.enabled === true, (checked) => {
    labels.enabled = checked;
    syncLabels(context, layer);
    context.render();
  }));
  section.append(selectField("Label drawing order", labels.drawOrder ?? "with-layer",
    [["with-layer", "With this Layer"], ["above-data", "Above data layers"]], (value) => {
      labels.drawOrder=value;syncLayerOrder(context);context.render();
    }));
  section.append(selectField("Name field", labels.field ?? fields[0] ?? "", fields.map((field) => [field, field]), (field) => {
    labels.field = field;
    syncLabels(context, layer);
    context.render();
  }));
  section.append(
    textField("Prefix", labels.prefix ?? "", (value) => {
      labels.prefix = value;
      syncLabels(context, layer);
    }, {placeholder: "Optional text before each name"}),
    textField("Suffix", labels.suffix ?? "", (value) => {
      labels.suffix = value;
      syncLabels(context, layer);
    }, {placeholder: "Optional text after each name"})
  );
  section.append(colorInput("Text color", labels.color ?? "#111827", (value) => {
    labels.color = value;
    syncLabels(context, layer);
  }));
  section.append(colorInput("Halo color", labels.haloColor ?? "#ffffff", (value) => {
    labels.haloColor = value;
    syncLabels(context, layer);
  }));
  section.append(rangeInput("Text size", {
    min: 8,
    max: 28,
    step: 1,
    value: labels.size ?? 12,
    onInput: (value) => {
      labels.size = value;
      syncLabels(context, layer);
    }
  }));
  section.append(rangeInput("Halo width", {
    min: 0,
    max: 6,
    step: 0.25,
    value: labels.haloWidth ?? 1.2,
    onInput: (value) => {
      labels.haloWidth = value;
      syncLabels(context, layer);
    }
  }));
  section.append(checkField("Allow label overlap", labels.allowOverlap === true, (checked) => {
    labels.allowOverlap = checked;
    syncLabels(context, layer);
  }));
  return section;
}

function mapFontStatusText(context, layer) {
  const fonts = context.state.mapFontSession;
  if (!layer.labels?.fontRef) return "Font not recorded. Existing labels keep their current appearance until you choose a pinned font.";
  if (!isRegisteredMapFont(layer.labels.fontRef)) return "This saved font is unavailable here. Its identity is preserved; no substitute is used.";
  if (!fonts.available) return "The saved font files are unavailable in this view. No substitute is used.";
  const error = fonts.coverageError(layer, context.dataByLayerId.get(layer.layerId));
  if (error?.startsWith("map_font_coverage_missing:")) return `This font does not contain character ${error.split(":")[1]}. Choose supported label text; no substitute is used.`;
  if (fonts.phase === "failed") return "The pinned font files could not be verified. Retry loading them; no substitute is used.";
  if (fonts.phase !== "ready") return "Open Sans v1 is recorded. Its font files will be verified before labels appear.";
  if (!fonts.supportsRenderer(context.rendererAdapter.id)) return "The saved font cannot be delivered to this renderer. Switch to MapLibre; no substitute is used.";
  if (error) return "Open Sans v1 is recorded. Label text is not available yet; no substitute is used.";
  const glyphRoot = context.state.map?.getStyle?.()?.glyphs;
  if (!glyphRoot || glyphRoot.startsWith("opengeo-font://")) {
    if (context.layers.some(candidate => candidate.visible !== false && candidate.labels?.enabled && candidate.labels?.field && !isRegisteredMapFont(candidate.labels.fontRef))) {
      return "Choose a pinned font for all visible enabled labels on Blank canvas before these labels can appear. Unspecified legacy fonts are unchanged.";
    }
  }
  return "Open Sans v1 · verified glyphs with reviewed Latin, Greek and Cyrillic coverage. Characters outside that coverage are not replaced.";
}

function layerActionEditor(context, layer, geojson) {
  const section = editorSection("Layer actions", "These commands affect the current browser project. Saving persists the layer stack target shown in Settings.");
  const buttons = document.createElement("div");
  buttons.className = "gis-action-grid";
  buttons.append(
    actionButton("Zoom to layer", () => fitLayer(context.state.map, layer, context.dataByLayerId)),
    actionButton("Duplicate", () => duplicateActiveLayer(context)),
    actionButton("Remove layer", () => removeLayer(context, layer))
  );
  buttons.lastElementChild?.classList.add("danger");
  section.append(buttons, spatialInterchangeExportControls(context, layer, geojson));
  return section;
}

function spatialInterchangeExportControls(context, layer, geojson) {
  const controls = document.createElement("div");
  controls.className = "gis-inline-actions";
  const format = document.createElement("select");
  format.setAttribute("aria-label", "Layer interchange export format");
  format.append(
    selectOption({value: "geojson", title: "GeoJSON", selected: true}),
    selectOption({value: "wkt", title: "WKT (geometry only)"}),
    selectOption({value: "wkb", title: "EWKB (geometry only)"})
  );
  let conversionReport = null;
  const reportDownload = actionButton("Download conversion report", () => {
    if (conversionReport) downloadBlob(`${slug(layer.title)}-conversion.json`, JSON.stringify(conversionReport, null, 2), "application/json");
  });
  reportDownload.hidden = true;
  const download = actionButton("Download layer", async () => {
    download.disabled = true;
    try {
      const exported = await archiveLayerExport(serializeSpatialInterchange(geojson, {
        format: format.value,
        dataProjection: "EPSG:4326",
        wkbEncoding: "binary"
      }), geojson, layer);
      conversionReport = structuredClone({...exported.report, sourceConversion: layer.interchange ?? null});
      reportDownload.hidden = false;
      downloadBlob(
        `${slug(layer.title)}${exported.extension}`,
        exported.content,
        exported.mediaType
      );
      const loss = exported.report.losses.length
        ? ` ${exported.report.losses.join(" ")}`
        : " Feature identifiers, properties, and geometry were preserved.";
      const provenance = exported.includesArchiveProvenance ? " ZIP includes capture provenance and checksums." : "";
      setStatus(context, `${layer.title} exported as ${format.value.toUpperCase()}.${loss}${provenance}`);
    } catch (error) {
      setStatus(context, `Layer export stopped safely (${error?.code ?? "interchange_write_failed"}).`);
    } finally {
      download.disabled = false;
    }
  });
  if (geojson?.opengeo?.sourceMode === "reviewed-archive") {
    controls.append(textElement("small", "Archived copy: download includes data and capture provenance in a ZIP file."));
  }
  controls.append(format, download, reportDownload);
  return controls;
}

function attributesPanel(context) {
  const {state} = context;
  const layer = activeLayer(context);
  const panel = panelShell();
  if (!layer) {
    panel.append(textElement("p", "Select a layer to inspect attributes."));
    return panel;
  }

  const geojson = context.dataByLayerId.get(layer.layerId);
  if (!geojson) {
    panel.append(textElement("p", context.state.archiveTileSessions.has(layer.layerId)
      ? "This archived view loads tiles for the visible map. It does not load a complete attribute table or provide a full-dataset export. Original records and geometry remain in the preserved capture."
      : "This layer has no local attribute table in the prototype."));
    return panel;
  }

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Filter rows";
  input.value = state.filterText;
  input.addEventListener("input", () => {
    state.filterText = input.value;
    context.render();
  });
  const filter = fieldWrap("Filter rows", input);

  const rows = featureRows(geojson, state.filterText);
  panel.append(filter, attributeSummary(rows, geojson.features.length), attributeTable(rows, context, layer));
  const area = selectedBoundaryQuerySection(context, layer, geojson);
  if (area) panel.append(area);
  return panel;
}

function selectedBoundaryQuerySection(context, layer, geojson) {
  const {state} = context;
  const index = state.selectedFeatureIndex;
  const feature = Number.isInteger(index) ? geojson.features[index] : null;
  if (!["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)) return null;
  const section = editorSection("Selected area", `Use ${featureTitle(feature, layer)} as the boundary for a saved vector layer query.`);
  section.classList.add("gis-selected-area-query");
  let geometry = null;
  try { geometry = queryGeometryFromBoundaryFeature(feature); } catch { /* Refuse without simplifying the original boundary. */ }
  const targets = context.layers.filter(candidate => candidate.sourceType === "governed-dataset" && candidate.datasetId);
  if (!geometry) section.append(textElement("p", "This boundary exceeds the query limits or has invalid geometry. Use a valid longitude/latitude polygon with at most 2,048 coordinate positions and 64 KiB. The original boundary has not been changed."));
  if (!targets.length || typeof context.queryDatasetFeatures !== "function") {
    section.append(textElement("p", "Add a saved vector layer to query in this area. Map imagery does not support feature queries or polygon data clipping."));
    return section;
  }
  let targetId = targets.find(candidate => candidate.layerId === state.areaQueryTargetLayerId)?.layerId
    ?? targets.find(candidate => candidate.layerId !== layer.layerId)?.layerId ?? targets[0].layerId;
  let relation = "within";
  section.append(
    selectField("Query layer", targetId, targets.map(candidate => [candidate.layerId, candidate.title]), value => {targetId = value; state.areaQueryTargetLayerId = value;}),
    selectField("Area relation", relation, [["within", "Entirely within"], ["intersects", "Intersects area"]], value => {relation = value;})
  );
  const query = actionButton("Query in this area", () => {
    const target = context.layers.find(candidate => candidate.layerId === targetId && candidate.sourceType === "governed-dataset" && candidate.datasetId);
    if (!geometry || !target || context.disposed || activeLayer(context)?.layerId !== layer.layerId
      || state.selectedFeatureIndex !== index || context.dataByLayerId.get(layer.layerId)?.features[index] !== feature) return;
    prepareBoundaryQuery(context, target, geometry, relation);
  });
  query.disabled = !geometry || state.queryRunning;
  section.append(query, textElement("small", "Uses the selected polygon, including holes and islands. This prepares a query; it does not clip or change source data."));
  return section;
}

function prepareBoundaryQuery(context, target, geometry, relation, source = null) {
  const {state} = context;
  const steps = state.queryDraft?.datasetId === target.datasetId ? [...state.queryDraft.steps] : [];
  const step = {kind: "spatial", relation, geometry: structuredClone(geometry), buffer_meters: 0};
  const previous = steps.findIndex(candidate => candidate.kind === "spatial");
  if (previous >= 0) steps.splice(previous, 1, step);
  else if (steps.length < FEATURE_QUERY_LIMITS.maximumSteps) steps.push(step);
  else {
    setStatus(context, "Remove a query condition before adding this area. Existing conditions have been kept.");
    return false;
  }
  const draft = featureQueryDraft(state, target, propertyFields(context.dataByLayerId.get(target.layerId)));
  draft.steps = steps; draft.offset = 0;
  // Boundary identity is local authoring context, separate from the strict
  // geometry/query wire format and its canonical server receipt.
  draft.savedBoundary = source ? {...source, step} : null;
  invalidateFeatureQueryResult(context);
  state.activeLayerId = target.layerId;
  state.activePanel = "query"; state.rightOpen = true;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  setStatus(context, `Boundary added to the ${target.title} query. Review the conditions, then choose Run query.`);
  context.render();
  return true;
}

function identifyPanel(context) {
  const {state} = context;
  const report = state.identifyReport ? {...state.identifyReport,
    rasters: sampleVisibleCogLayers(context, state.identifyReport.location)} : null;
  const panel = panelShell();
  panel.classList.add("gis-identify-panel");
  panel.dataset.identifyState = state.identifyRunning
    ? "running"
    : report
      ? "ready"
      : "idle";

  const candidates = visibleQueryableLayers(context.layers);
  const rasters = visibleCogLayers(context);
  if (!rasters.length && (!candidates.length || typeof context.queryDatasetFeatures !== "function")) {
    panel.append(
      textElement("p", "Identify checks every visible governed layer at the clicked location."),
      textElement("small", "Add a governed dataset layer to use permission-scoped drill-down identify. Local and external display layers continue to use their ordinary feature popup.")
    );
    return panel;
  }

  const live = textElement(
    "p",
    state.identifyRunning
      ? "Checking visible layers…"
      : report
        ? workbenchIdentifySummary(report)
        : "Click the map to inspect visible layers."
  );
  live.className = "gis-query-feedback";
  live.role = "status";
  live.ariaLive = "polite";
  panel.append(live);

  if (!report) return panel;
  panel.append(textElement(
    "small",
    `${report.location[0].toFixed(5)}, ${report.location[1].toFixed(5)} · ${report.layers.length
      ? report.layers.some(outcome => outcome.result?.source === "displayed-preview")
        ? `displayed features use a ${GOVERNED_IDENTIFY_LIMITS.renderedPixelTolerance} pixel click tolerance`
        : `${report.bufferMeters} meter selection tolerance`
      : "raster cells from the loaded grid"}`
  ));
  const groups = document.createElement("div");
  groups.className = "gis-identify-groups";
  for (const outcome of report.rasters ?? []) {
    const group = document.createElement("section");group.className = "gis-identify-layer";group.dataset.identifyLayer = outcome.layerId;
    group.append(textElement("h3", outcome.title), CogIdentifyResult(outcome.sample));groups.append(group);
  }
  for (const outcome of report.layers) {
    const group = document.createElement("section");
    group.className = "gis-identify-layer";
    group.dataset.identifyLayer = outcome.layerId;
    group.append(textElement("h3", outcome.title));
    if (outcome.status !== "ready") {
      group.append(textElement("p", identifyUnavailableMessage(outcome.errorCode)));
      groups.append(group);
      continue;
    }
    if (!outcome.result.features.length) {
      group.append(textElement("p", outcome.result.source === "displayed-preview"
        ? "No displayed features at this location." : "No features at this location."));
      groups.append(group);
      continue;
    }
    const layer = context.layers.find(({layerId}) => layerId === outcome.layerId);
    group.append(textElement(
      "p",
      outcome.result.source === "displayed-preview"
        ? `${outcome.result.numberReturned} displayed features · saved data version ${layer?.sourceVersion ?? "selected"}. Hidden or unloaded features are not searched.`
        : `${outcome.result.numberReturned} of ${outcome.result.numberMatched} matches · generation ${outcome.result.generation}`
    ));
    const results = document.createElement("div");
    results.className = "gis-identify-features";
    outcome.result.features.forEach((feature) => {
      const targetLayer = layer ?? {title: outcome.title, labels: {}};
      const label = featureTitle(feature, targetLayer);
      const button = labeledActionButton(
        label,
        `Open ${label} from ${outcome.title}`,
        () => {
          state.activeLayerId = outcome.layerId;
          state.selectedFeatureIndex = loadedFeatureIndex(
            context.dataByLayerId.get(outcome.layerId)?.features,
            feature.id
          );
          zoomToFeature(context, targetLayer, feature);
          setStatus(context, `${label} selected from ${outcome.title}.`);
          context.render();
        }
      );
      results.append(button);
      const attributes = document.createElement("dl"); attributes.className = "gis-popup";
      for (const [key, value] of Object.entries(feature.properties ?? {}).slice(0, 10)) {
        attributes.append(textElement("dt", String(key).slice(0, 160)),
          textElement("dd", (typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).slice(0, 2000)));
      }
      results.append(attributes);
    });
    group.append(results);
    groups.append(group);
  }
  panel.append(groups);
  return panel;
}

function visibleCogLayers(context) {
  return context.layers.filter(layer => layer.sourceType === "cog-raster" && layer.visible !== false
    && context.state.layerHandles?.get(layer.layerId)?.cog);
}

function sampleVisibleCogLayers(context, location) {
  return visibleCogLayers(context).map(layer => ({layerId: layer.layerId, title: layer.title,
    sample: context.state.layerHandles.get(layer.layerId).cog.identify(location[0], location[1])}));
}

function workbenchIdentifySummary(report) {
  return [report.layers.length ? identifyReportSummary(report) : null,
    report.rasters?.length ? `Raster values · ${report.rasters.length} visible ${report.rasters.length === 1 ? "layer" : "layers"}.` : null]
    .filter(Boolean).join(" ");
}

function cancelDrillDownIdentify(context) {
  const {state} = context;
  state.identifyRequestRevision++;
  state.identifyAbortController?.abort();
  state.identifyAbortController = null; state.identifyPendingLocation = null;
  state.identifyRunning = false; state.identifyReport = null;
}

async function runDrillDownIdentify(context, lngLat, point) {
  const {state} = context;
  const candidates = visibleQueryableLayers(context.layers);
  const hasVectorQuery = candidates.length && typeof context.queryDatasetFeatures === "function";
  if (context.disposed || context.queryLocationScopeInvalid || !hasVectorQuery && !visibleCogLayers(context).length) return;
  const wrapped = lngLat?.wrap?.() ?? lngLat;
  const location = {lng: Number(wrapped?.lng), lat: Number(wrapped?.lat), point};
  if (state.identifyRunning) {
    state.identifyPendingLocation = location;
    state.identifyAbortController?.abort();
    return;
  }
  const revision = state.identifyRequestRevision + 1;
  const controller = new AbortController();
  state.identifyRequestRevision = revision;
  state.identifyAbortController = controller;
  state.identifyPendingLocation = null;
  state.identifyRunning = true;
  state.identifyReport = null;
  state.activePanel = "identify";
  state.rightOpen = true;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  setStatus(context, "Inspecting visible layers…");
  context.render();
  const renderedFeaturesForLayer = captureManagedPreviewIdentify(context, point);
  try {
    const report = hasVectorQuery ? await identifyVisibleGovernedLayers({
      layers: context.layers,
      longitude: location.lng,
      latitude: location.lat,
      queryDatasetFeatures: context.queryDatasetFeatures,
      renderedFeaturesForLayer,
      signal: controller.signal
    }) : {location: [location.lng, location.lat], bufferMeters: 0, omittedLayerCount: 0, layers: []};
    if (revision !== state.identifyRequestRevision
      || controller.signal.aborted
      || state.identifyPendingLocation) return;
    report.rasters = sampleVisibleCogLayers(context, report.location);
    state.identifyReport = report;
    for (const outcome of report.layers) {
      if (outcome.status !== "ready" || outcome.result.source === "displayed-preview") continue;
      for (const layer of context.layers) {
        if (layer.datasetId === outcome.datasetId) layer.featureGeneration = outcome.result.generation;
      }
    }
    setStatus(context, workbenchIdentifySummary(report));
  } catch (error) {
    if (revision !== state.identifyRequestRevision || controller.signal.aborted) return;
    setStatus(context, `Identify unavailable (${error?.code ?? "invalid_identify_request"}).`);
  } finally {
    if (revision === state.identifyRequestRevision) {
      state.identifyRunning = false;
      state.identifyAbortController = null;
      const pendingLocation = state.identifyPendingLocation;
      state.identifyPendingLocation = null;
      if (pendingLocation) {
        void runDrillDownIdentify(context, pendingLocation, pendingLocation.point);
      } else {
        context.render();
      }
    }
  }
}

function queryPanel(context) {
  const {state} = context;
  const layer = activeLayer(context);
  const panel = panelShell();
  panel.classList.add("gis-query-panel");
  panel.dataset.queryState = state.queryRunning ? "running" : state.queryError ? "error" : state.queryResult ? "ready" : "draft";
  if (!layer) {
    panel.append(textElement("p", "Add or select a layer before building a query."));
    return panel;
  }
  if (layer.sourceType !== "governed-dataset" || !layer.datasetId) {
    panel.append(
      textElement("p", "Governed queries run against a saved dataset and its exact feature generation."),
      textElement("small", "Local files can still use the quick filter in the attribute table.")
    );
    return panel;
  }
  if (typeof context.queryDatasetFeatures !== "function") {
    panel.append(textElement("p", "The governed query API is unavailable in this deployment."));
    return panel;
  }

  const geojson = context.dataByLayerId.get(layer.layerId);
  const schemaFields = Array.isArray(layer.featureFields) ? layer.featureFields : [];
  const fields = [...new Set([
    ...schemaFields.map(({name}) => name),
    ...propertyFields(geojson)
  ])].sort((left, right) => left.localeCompare(right));
  const fieldTypes = new Map(schemaFields.map(({name, type}) => [name, type]));
  for (const field of fields) if (!fieldTypes.has(field)) fieldTypes.set(field, inferredFieldType(geojson, field));
  const draft = featureQueryDraft(state, layer, fields, fieldTypes);
  panel.dataset.querySteps = String(draft.steps.length);
  panel.append(
    editorSection(
      "Governed query",
      `Queries use the current authorized ${layer.title} feature generation. Up to ${FEATURE_QUERY_LIMITS.maximumSteps} conditions are combined with AND.`
    )
  );
  const builder = document.createElement("div");
  builder.className = "gis-query-builder";
  draft.steps.forEach((step, index) => builder.append(queryStepEditor(context, draft, step, index, fields, fieldTypes)));
  if (!draft.steps.length) builder.append(textElement("p", "Add an attribute condition or draw a spatial selection."));
  panel.lastElementChild.append(builder);

  const add = document.createElement("div");
  add.className = "gis-query-actions";
  const addCondition = actionButton("+ Attribute condition", () => {
    if (draft.steps.length >= FEATURE_QUERY_LIMITS.maximumSteps || !fields.length) return;
    draft.steps.push(defaultAttributeQueryStep(fields[0], fieldTypes.get(fields[0])));
    invalidateFeatureQueryResult(context, {render: true});
  });
  addCondition.disabled = draft.steps.length >= FEATURE_QUERY_LIMITS.maximumSteps || !fields.length;
  add.append(
    addCondition,
    actionButton("Select by point", () => beginQueryDrawing(context, "Point")),
    actionButton("Select multiple points", () => beginQueryDrawing(context, "MultiPoint")),
    actionButton("Select by line", () => beginQueryDrawing(context, "LineString")),
    actionButton("Select by polygon", () => beginQueryDrawing(context, "Polygon")),
    actionButton("Select by box", () => beginQueryDrawing(context, "Box")),
    actionButton("Select visible area", () => useVisibleQueryArea(context))
  );
  panel.append(add);
  const savedArea = savedLocationQuerySection(context, layer, draft);
  if (savedArea) panel.append(savedArea);
  const copiedSelection = copiedQuerySelectionSection(context, layer, draft);
  if (copiedSelection) panel.append(copiedSelection);

  const run = actionButton(state.queryRunning ? "Running…" : "Run query", () => void runFeatureQuery(context));
  run.disabled = state.queryRunning || state.queryLocationState?.busy || !queryDraftReady(draft);
  const clear = actionButton("Clear", () => clearFeatureQuery(context));
  clear.dataset.queryClear = "true";
  const actions = document.createElement("div");
  actions.className = "gis-query-actions gis-query-run-actions";
  actions.append(run, clear);
  panel.append(actions);
  panel.append(savedQueryReceiptSection(context, layer));

  if (state.queryError) {
    const error = textElement("p", `Query unavailable (${state.queryError}).`);
    error.className = "gis-query-feedback error";
    panel.append(error);
  }
  if (state.queryResult) panel.append(queryResults(context, layer));
  panel.append(textElement(
    "small",
    `Limits: ${FEATURE_QUERY_LIMITS.maximumResults} results · ${FEATURE_QUERY_LIMITS.maximumBufferMeters / 1000} km buffer · ${FEATURE_QUERY_LIMITS.timeoutSeconds} second database timeout · ${FEATURE_QUERY_LIMITS.maximumCsvBytes / 1024} KiB CSV.`
  ));
  if (state.queryRunning) {
    for (const control of panel.querySelectorAll("button, input, select, textarea")) {
      control.disabled = control !== clear;
    }
  }
  return panel;
}

function cancelQueryLocationRequest(context) {
  const area = context.state.queryLocationState;
  if (area) area.requestRevision++;
  context.state.queryLocationState = null;
}

function savedLocationQuerySection(context, layer, draft) {
  if (typeof context.listQueryLocations !== "function" || typeof context.getQueryLocation !== "function"
    || context.queryLocationScopeInvalid) return null;
  const {state} = context;
  let area = state.queryLocationState;
  if (!area || area.layer !== layer || area.draft !== draft) {
    cancelQueryLocationRequest(context);
    area = state.queryLocationState = {layer, draft, records: [], offset: 0, loaded: false,
      more: false, selectedId: "", relation: "within", busy: false, requestRevision: 0,
      message: "Load saved Geographic tags, choose an area, then prepare its exact polygon query."};
  }
  const section = editorSection("Saved Geographic area", "Uses saved polygons, including holes and islands. Source data stays unchanged.");
  section.classList.add("gis-query-geographic-area");
  const current = revision => !context.disposed && context.shell.isConnected && !context.queryLocationScopeInvalid
    && state.queryLocationState === area && area.requestRevision === revision
    && activeLayer(context) === layer && state.queryDraft === draft && !state.queryRunning;
  const load = actionButton(!area.loaded ? "Load Geographic tags" : area.more ? "Load more Geographic tags" : "Reload Geographic tags", async () => {
    if (area.busy || state.queryRunning || !current(area.requestRevision)) return;
    const revision = ++area.requestRevision, offset = area.more ? area.offset : 0;
    area.busy = true; area.message = "Loading accessible Geographic tags…"; context.render();
    try {
      const records = await context.listQueryLocations({limit: 50, offset});
      if (!current(revision)) return;
      if (!Array.isArray(records) || records.length > 50 || records.some(record => typeof record.id !== "string"
        || typeof record.title !== "string" || !Number.isSafeInteger(record.revision) || record.revision < 1)) throw Error("Invalid Geographic tags");
      const previous = offset ? area.records : [];
      const known = new Set(previous.map(record => record.id));
      area.records = [...previous, ...records.filter(record => !known.has(record.id))];
      area.offset = offset + records.length;
      area.more = records.length === 50 && area.offset < 10000;
      area.loaded = true;
      if (!area.records.some(record => record.id === area.selectedId)) area.selectedId = "";
      area.message = area.records.length ? "Choose a saved Geographic tag. Preparing the area does not run a query."
        : "No accessible Geographic tags found.";
    } catch {
      if (current(revision)) area.message = "Geographic tags could not load. Check access and reload; query conditions are unchanged.";
    } finally {
      if (current(revision)) {area.busy = false; context.render();}
    }
  });
  load.disabled = area.busy;
  const choice = selectInput("Geographic tag", area.selectedId, [["", "Choose a Geographic tag"],
    ...area.records.map(record => [record.id, `${record.title} · revision ${record.revision}`])]);
  choice.input.disabled = area.busy || !area.records.length;
  choice.input.addEventListener("change", () => {
    if (!current(area.requestRevision) || area.busy) return;
    area.selectedId = choice.input.value; context.render();
  });
  const relation = selectInput("Area relation", area.relation, [["within", "Entirely within"], ["intersects", "Intersects area"]]);
  relation.input.disabled = area.busy;
  relation.input.addEventListener("change", () => {area.relation = relation.input.value;});
  const prepare = actionButton("Prepare area query", async () => {
    const selected = area.records.find(record => record.id === area.selectedId);
    if (!selected || area.busy || state.queryRunning || !current(area.requestRevision)) return;
    const revision = ++area.requestRevision, selectedRelation = area.relation;
    area.busy = true; area.message = "Loading this saved boundary revision…"; context.render();
    try {
      const record = await context.getQueryLocation(selected.id, selected.revision);
      if (!current(revision)) return;
      if (record.id !== selected.id || record.revision !== selected.revision) throw Error("The saved Geographic tag revision changed");
      const geometry = queryGeometryFromBoundaryFeature({type: "Feature", geometry: record.document?.geometry});
      area.busy = false;
      if (prepareBoundaryQuery(context, layer, geometry, selectedRelation,
        {id: record.id, revision: record.revision, title: record.document.title})) {
        area.message = `${record.document.title} · saved revision ${record.revision}. Review the conditions, then choose Run query.`;
      } else area.message = "Remove a query condition before adding this area. Existing conditions have been kept.";
    } catch (error) {
      if (current(revision)) area.message = error instanceof TypeError
        ? "This saved boundary is not a valid Polygon or MultiPolygon within 2,048 positions and 64 KiB. The original boundary and query conditions are unchanged."
        : "Saved Geographic tag unavailable. Check access and reload; query conditions are unchanged.";
    } finally {
      if (current(revision)) {area.busy = false; context.render();}
    }
  });
  prepare.disabled = area.busy || !area.selectedId || draft.steps.length >= FEATURE_QUERY_LIMITS.maximumSteps
    && !draft.steps.some(step => step.kind === "spatial");
  const actions = document.createElement("div"); actions.className = "gis-query-actions"; actions.append(load, prepare);
  const message = textElement("p", area.message); message.role = "status"; message.className = "gis-query-feedback";
  section.append(choice.wrapper, relation.wrapper, actions, message);
  return section;
}

function featureQueryDraft(state, layer, fields, fieldTypes = new Map()) {
  if (state.queryDraft?.datasetId === layer.datasetId) return state.queryDraft;
  state.queryResult = null;
  state.queryError = null;
  state.querySelectedFeatureId = null;
  state.selectedFeatureIndex = null;
  state.queryDraft = {
    datasetId: layer.datasetId,
    expectedGeneration: Number.isSafeInteger(layer.featureGeneration) ? layer.featureGeneration : null,
    limit: FEATURE_QUERY_LIMITS.maximumResults,
    offset: 0,
    steps: fields.length ? [defaultAttributeQueryStep(fields[0], fieldTypes.get(fields[0]))] : []
  };
  return state.queryDraft;
}

function defaultAttributeQueryStep(field, valueType = "string") {
  return {
    kind: "attribute",
    field,
    operator: valueType === "string" ? "contains" : "equals",
    value: valueType === "boolean" ? false : valueType === "string" ? "" : 0,
    case_sensitive: false,
    valueType
  };
}

function queryStepEditor(context, draft, step, index, fields, fieldTypes) {
  const item = document.createElement("fieldset");
  item.className = "gis-query-step";
  item.dataset.queryStep = String(index + 1);
  const legend = document.createElement("legend");
  legend.textContent = step.kind === "attribute"
    ? `Condition ${index + 1} · attribute`
    : `Condition ${index + 1} · ${queryGeometryLabel(step.geometry)} selection`;
  item.append(legend);
  if (draft.savedBoundary && !draft.steps.includes(draft.savedBoundary.step)) draft.savedBoundary = null;
  if (draft.savedBoundary?.step === step) {
    const source = draft.savedBoundary;
    const note = textElement("small", `${source.title} · saved Geographic tag revision ${source.revision}`);
    note.dataset.geographicTagId = source.id;
    note.dataset.geographicTagRevision = String(source.revision);
    item.append(note);
  }
  if (step.kind === "attribute") {
    step.valueType ??= fieldTypes.get(step.field) ?? "string";
    const field = selectInput("Field", step.field, fields.map((name) => [name, name]));
    field.input.addEventListener("change", () => {
      step.field = field.input.value;
      step.valueType = fieldTypes.get(step.field) ?? "string";
      step.operator = step.valueType === "string" ? "contains" : "equals";
      step.value = step.valueType === "boolean" ? false : step.valueType === "string" ? "" : 0;
      invalidateFeatureQueryResult(context, {render: true});
    });
    const operator = selectInput(
      "Operator",
      step.operator,
      queryOperatorOptions(step.valueType)
    );
    operator.input.addEventListener("change", () => {
      step.operator = operator.input.value;
      if (step.operator === "is_null") step.value = null;
      else if (step.value === null) step.value = "";
      invalidateFeatureQueryResult(context, {render: true});
    });
    item.append(field.wrapper, operator.wrapper);
    if (step.operator !== "is_null") {
      const value = step.valueType === "boolean"
        ? selectInput("Value", String(step.value), [["true", "true"], ["false", "false"]])
        : textInput("Value", String(step.value ?? ""));
      if (["integer", "number"].includes(step.valueType)) {
        value.input.type = "number";
        value.input.step = step.valueType === "integer" ? "1" : "any";
      } else value.input.maxLength = 200;
      value.input.addEventListener(value.input.tagName === "SELECT" ? "change" : "input", () => {
        step.value = queryInputValue(value.input.value, step.valueType);
        invalidateFeatureQueryResult(context);
      });
      item.append(value.wrapper);
      if (step.valueType === "string") item.append(checkField("Case-sensitive text", step.case_sensitive, (checked) => {
        step.case_sensitive = checked;
        invalidateFeatureQueryResult(context);
      }));
    }
  } else {
    const relation = selectInput("Spatial relationship", step.relation, [
      ["intersects", "intersects selection"],
      ["within", "is within selection"]
    ]);
    relation.input.addEventListener("change", () => {
      step.relation = relation.input.value;
      invalidateFeatureQueryResult(context);
    });
    const buffer = document.createElement("input");
    buffer.type = "number";
    buffer.min = "0";
    buffer.max = String(FEATURE_QUERY_LIMITS.maximumBufferMeters);
    buffer.step = "1";
    buffer.value = String(step.buffer_meters ?? 0);
    buffer.addEventListener("input", () => {
      step.buffer_meters = Number(buffer.value);
      invalidateFeatureQueryResult(context);
    });
    const modifyKind = queryGeometryDrawingKind(step.geometry);
    const modify = actionButton("Modify selection", () => {
      if (modifyKind) beginQueryDrawing(context, modifyKind, index);
    });
    modify.disabled = !modifyKind;
    item.append(relation.wrapper, fieldWrap("Buffer (meters)", buffer), modify);
    if (!modifyKind) item.append(textElement("small", "This selection has multiple parts or holes. To replace it, remove this condition and use Select by polygon or box."));
  }
  const remove = actionButton("Remove condition", () => {
    if (draft.savedBoundary?.step === step) draft.savedBoundary = null;
    draft.steps.splice(index, 1);
    invalidateFeatureQueryResult(context, {render: true});
  });
  remove.classList.add("danger");
  item.append(remove);
  return item;
}

function queryGeometryLabel(geometry) {
  return ({
    MultiPoint: "multiple points",
    LineString: "line",
    Polygon: "polygon or box",
    MultiPolygon: "multipolygon",
    GeometryCollection: "copied result"
  })[geometry?.type] ?? "point";
}

function queryGeometryDrawingKind(geometry) {
  if (["Point", "MultiPoint", "LineString"].includes(geometry?.type)
    || (geometry?.type === "Polygon" && geometry.coordinates?.length === 1)) {
    return geometry.type;
  }
  return null;
}

function copiedQuerySelectionSection(context, layer, draft) {
  const clipboard = context.state.querySelectionClipboard;
  if (!clipboard) return null;
  const section = editorSection(
    "Copied result selection",
    `${clipboard.featureIds.length} bounded ${clipboard.featureIds.length === 1 ? "feature" : "features"} from ${clipboard.sourceLayerTitle} generation ${clipboard.sourceGeneration}. Add the exact geometries to ${layer.title}, then set a buffer if needed.`
  );
  section.classList.add("gis-query-selection-clipboard");
  section.dataset.sourceQueryHash = clipboard.sourceQuerySha256;
  const actions = document.createElement("div");
  actions.className = "gis-query-actions";
  const add = actionButton("Add result selection", () => {
    const spatialStep = {
      kind: "spatial",
      relation: "intersects",
      geometry: structuredClone(clipboard.geometry),
      buffer_meters: 0
    };
    const existing = draft.steps.findIndex(({kind}) => kind === "spatial");
    if (existing >= 0) draft.steps.splice(existing, 1, spatialStep);
    else if (draft.steps.length < FEATURE_QUERY_LIMITS.maximumSteps) draft.steps.push(spatialStep);
    else {
      context.state.queryError = "maximum_query_steps_reached";
      context.render();
      return;
    }
    invalidateFeatureQueryResult(context);
    setStatus(context, `Copied ${clipboard.featureIds.length} result geometries into the ${layer.title} query. Set a buffer and run the query.`);
    context.render();
  });
  add.disabled = draft.steps.length >= FEATURE_QUERY_LIMITS.maximumSteps
    && !draft.steps.some(({kind}) => kind === "spatial");
  actions.append(
    add,
    actionButton("Clear copied selection", () => {
      context.state.querySelectionClipboard = null;
      setStatus(context, "Copied result selection cleared.");
      context.render();
    })
  );
  section.append(actions);
  return section;
}

function savedQueryReceiptSection(context, layer) {
  const {state} = context;
  const section = editorSection(
    "Saved query receipts",
    "Open a receipt to restore its exact dataset, collection generation, geometry, chain, buffer, paging, and stable feature-id order. A generation conflict stops replay instead of silently changing its meaning."
  );
  section.classList.add("gis-saved-query-receipts");
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".json,application/json";
  file.disabled = state.savedQueryReceiptBusy;
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (selected) void importSavedQueryReceipt(context, selected);
  });
  section.append(fieldWrap(
    state.savedQueryReceiptBusy ? "Opening query receipt…" : "Open saved query receipt",
    file
  ));
  if (state.savedQueryReceiptError) {
    const error = textElement("p", `Saved query receipt unavailable (${state.savedQueryReceiptError}).`);
    error.className = "gis-query-feedback error";
    error.role = "alert";
    section.append(error);
  }

  const receipts = state.savedQueryReceipts.filter(({dataset_id: datasetId}) => datasetId === layer.datasetId);
  if (!receipts.length) {
    section.append(textElement("small", "No saved receipt for this governed dataset is open in this map session."));
    return section;
  }
  const list = document.createElement("div");
  list.className = "gis-saved-query-list";
  for (const receipt of receipts) {
    const item = document.createElement("article");
    item.className = "gis-saved-query-item";
    item.dataset.queryHash = receipt.query_sha256;
    item.append(
      textElement("strong", receipt.layer_title),
      textElement("small", `Generation ${receipt.collection_generation} · ${receipt.query.steps.length} conditions · ${receipt.query_sha256.slice(0, 12)}…`)
    );
    const actions = document.createElement("div");
    actions.className = "gis-query-actions";
    const replay = actionButton("Replay exact query", () => replaySavedQueryReceipt(context, receipt));
    replay.disabled = state.queryRunning;
    actions.append(
      replay,
      actionButton("Edit a copy", () => editSavedQueryReceipt(context, receipt)),
      actionButton("Close receipt", () => {
        state.savedQueryReceipts = state.savedQueryReceipts.filter((candidate) => (
          candidate.dataset_id !== receipt.dataset_id || candidate.query_sha256 !== receipt.query_sha256
        ));
        context.render();
      })
    );
    item.append(actions);
    list.append(item);
  }
  section.append(list);
  return section;
}

async function importSavedQueryReceipt(context, file) {
  const {state} = context;
  if (state.savedQueryReceiptBusy) return;
  state.savedQueryReceiptBusy = true;
  state.savedQueryReceiptError = null;
  context.render();
  try {
    if (Number.isFinite(file.size) && file.size > 131_072) {
      throw Object.assign(new Error("saved query receipt is too large"), {code: "receipt_too_large"});
    }
    const sourceText = await file.text();
    if (new TextEncoder().encode(sourceText).byteLength > 131_072) {
      throw Object.assign(new Error("saved query receipt is too large"), {code: "receipt_too_large"});
    }
    const receipt = await parseSavedFeatureQueryReceipt(JSON.parse(sourceText));
    const target = context.layers.find(({datasetId, sourceType}) => (
      datasetId === receipt.dataset_id && sourceType === "governed-dataset"
    ));
    if (!target) {
      throw Object.assign(new Error("saved query dataset is not attached"), {code: "query_dataset_not_attached"});
    }
    rememberSavedQueryReceipt(state, receipt);
    state.activeLayerId = target.layerId;
    loadSavedQueryDraft(state, receipt);
    state.queryResult = null;
    state.querySelectedFeatureId = null;
    state.selectedFeatureIndex = null;
    syncQueryResultLayer(context, []);
    setStatus(context, `Saved query receipt opened for ${target.title} at exact generation ${receipt.collection_generation}.`);
  } catch (error) {
    state.savedQueryReceiptError = error?.code ?? (
      error instanceof SyntaxError ? "invalid_json" : "invalid_saved_query_receipt"
    );
    setStatus(context, `Saved query receipt rejected safely (${state.savedQueryReceiptError}).`);
  } finally {
    state.savedQueryReceiptBusy = false;
    context.render();
    requestAnimationFrame(() => context.shell.querySelector(".gis-query-step input, .gis-query-step select")?.focus());
  }
}

async function saveCurrentQueryReceipt(context, layer, result) {
  try {
    const receipt = await createSavedFeatureQueryReceipt({
      datasetId: layer.datasetId,
      layerTitle: layer.title,
      result
    });
    rememberSavedQueryReceipt(context.state, receipt);
    downloadBlob(
      `${slug(layer.title)}-query-receipt.json`,
      JSON.stringify(receipt, null, 2),
      "application/json"
    );
    setStatus(context, `Exact query receipt saved for ${layer.title} generation ${receipt.collection_generation}.`);
    context.render();
  } catch (error) {
    context.state.savedQueryReceiptError = error?.code ?? "invalid_saved_query_receipt";
    setStatus(context, `Query receipt could not be saved (${context.state.savedQueryReceiptError}).`);
    context.render();
  }
}

function rememberSavedQueryReceipt(state, receipt) {
  state.savedQueryReceiptError = null;
  state.savedQueryReceipts = [
    receipt,
    ...state.savedQueryReceipts.filter((candidate) => (
      candidate.dataset_id !== receipt.dataset_id || candidate.query_sha256 !== receipt.query_sha256
    ))
  ].slice(0, 12);
}

function loadSavedQueryDraft(state, receipt) {
  state.queryDraft = {
    datasetId: receipt.dataset_id,
    expectedGeneration: receipt.query.expected_generation,
    limit: receipt.query.limit,
    offset: receipt.query.offset,
    steps: structuredClone(receipt.query.steps)
  };
  state.queryError = null;
  state.queryDrawing = null;
}

function editSavedQueryReceipt(context, receipt) {
  const target = context.layers.find(({datasetId, sourceType}) => (
    datasetId === receipt.dataset_id && sourceType === "governed-dataset"
  ));
  if (!target) return;
  context.state.activeLayerId = target.layerId;
  loadSavedQueryDraft(context.state, receipt);
  context.state.queryDraft.expectedGeneration = null;
  context.state.queryResult = null;
  context.state.querySelectedFeatureId = null;
  context.state.selectedFeatureIndex = null;
  syncQueryResultLayer(context, []);
  setStatus(context, `Editable copy opened from the saved generation ${receipt.collection_generation} query. Its next successful run will bind the current collection generation.`);
  context.render();
  requestAnimationFrame(() => context.shell.querySelector(".gis-query-step input, .gis-query-step select")?.focus());
}

function replaySavedQueryReceipt(context, receipt) {
  const target = context.layers.find(({datasetId, sourceType}) => (
    datasetId === receipt.dataset_id && sourceType === "governed-dataset"
  ));
  if (!target || context.state.queryRunning) return;
  context.state.activeLayerId = target.layerId;
  loadSavedQueryDraft(context.state, receipt);
  context.state.queryResult = null;
  context.state.querySelectedFeatureId = null;
  context.state.selectedFeatureIndex = null;
  syncQueryResultLayer(context, []);
  void runFeatureQuery(context, receipt);
}

function queryResults(context, layer) {
  const {state} = context;
  const result = state.queryResult;
  const section = editorSection(
    "Linked map and table results",
    `${result.numberReturned} of ${result.numberMatched} matching features at generation ${result.generation}.`
  );
  section.classList.add("gis-query-results");
  section.dataset.queryHash = result.querySha256;
  const actions = document.createElement("div");
  actions.className = "gis-query-actions";
  let resultSelectionGeometry = null;
  try {
    resultSelectionGeometry = queryGeometryFromFeatures(result.features);
  } catch {
    resultSelectionGeometry = null;
  }
  const copySelection = actionButton("Copy results as selection", () => {
    if (!resultSelectionGeometry) return;
    state.querySelectionClipboard = {
      geometry: structuredClone(resultSelectionGeometry),
      sourceDatasetId: layer.datasetId,
      sourceLayerTitle: layer.title,
      sourceGeneration: result.generation,
      sourceQuerySha256: result.querySha256,
      featureIds: result.features.map(({id}) => String(id))
    };
    setStatus(context, `${result.features.length} result geometries copied as a bounded selection. Choose a governed target layer and add the selection to its query.`);
    context.render();
  });
  copySelection.disabled = !resultSelectionGeometry;
  copySelection.title = resultSelectionGeometry
    ? "Copy the exact returned geometries for a later governed spatial query"
    : "Returned features do not contain usable bounded geometries";
  actions.append(
    actionButton("Fit results", () => fitGeojson(context.state.map, {type: "FeatureCollection", features: result.features})),
    actionButton("Download CSV", () => {
      try {
        const csv = serializeFeatureQueryCsv(result);
        downloadBlob(`${slug(layer.title)}-query.csv`, csv, "text/csv;charset=utf-8");
        setStatus(context, `${result.numberReturned} governed query rows exported to bounded CSV.`);
      } catch (error) {
        setStatus(context, `CSV export unavailable (${error.message}).`);
      }
    }),
    actionButton("Save query receipt", () => void saveCurrentQueryReceipt(context, layer, result)),
    copySelection
  );
  const receipt = textElement(
    "small",
    `Reproducible query receipt · SHA-256 ${result.querySha256} · deterministic feature-id order.`
  );
  receipt.className = "gis-query-receipt";
  section.append(receipt, actions, queryResultTable(context, layer, result.features));
  return section;
}

function queryResultTable(context, layer, features) {
  const rows = features.map((feature, index) => ({index, feature, values: feature.properties ?? {}}));
  const table = attributeTable(rows, context, layer, {
    onSelect: ({feature, index}) => {
      context.state.querySelectedFeatureId = feature?.id ?? null;
      context.state.selectedFeatureIndex = index;
      syncQueryResultLayer(context, features);
    }
  });
  table.classList.add("gis-query-result-table");
  return table;
}

async function runFeatureQuery(context, savedReceipt = null) {
  const {state} = context;
  const layer = activeLayer(context);
  const replayQuery = savedReceipt?.query ?? null;
  const draft = replayQuery ? null : state.queryDraft;
  if (!layer?.datasetId
    || (savedReceipt && savedReceipt.dataset_id !== layer.datasetId)
    || !(replayQuery?.steps?.length ?? draft?.steps?.length)
    || state.queryRunning) return;
  const revision = state.queryRequestRevision + 1;
  const controller = new AbortController();
  const requestedLayerId = layer.layerId;
  const requestedDatasetId = layer.datasetId;
  state.queryRequestRevision = revision;
  state.queryAbortController = controller;
  state.queryRunning = true;
  state.queryError = null;
  context.render();
  try {
    const draftGeneration = draft && Object.hasOwn(draft, "expectedGeneration")
      ? draft.expectedGeneration
      : layer.featureGeneration ?? null;
    const result = await context.queryDatasetFeatures(layer.datasetId, {
      steps: replayQuery?.steps ?? draft.steps,
      expectedGeneration: replayQuery?.expected_generation ?? draftGeneration,
      limit: replayQuery?.limit ?? draft.limit ?? FEATURE_QUERY_LIMITS.maximumResults,
      offset: replayQuery?.offset ?? draft.offset ?? 0
    }, {signal: controller.signal});
    if (revision !== state.queryRequestRevision
      || controller.signal.aborted
      || activeLayer(context)?.layerId !== requestedLayerId
      || activeLayer(context)?.datasetId !== requestedDatasetId) return;
    state.queryResult = result;
    state.querySelectedFeatureId = null;
    state.selectedFeatureIndex = null;
    layer.featureGeneration = result.generation;
    if (state.queryDraft?.datasetId === layer.datasetId) state.queryDraft.expectedGeneration = result.generation;
    syncQueryResultLayer(context, result.features);
    setStatus(context, savedReceipt
      ? `Saved query replay returned ${result.numberReturned} of ${result.numberMatched} governed features at generation ${result.generation}.`
      : `Query returned ${result.numberReturned} of ${result.numberMatched} governed features.`);
  } catch (error) {
    if (revision !== state.queryRequestRevision || controller.signal.aborted || error?.name === "AbortError") return;
    state.queryResult = null;
    state.queryError = error?.code ?? "unexpected_error";
    state.querySelectedFeatureId = null;
    state.selectedFeatureIndex = null;
    syncQueryResultLayer(context, []);
    setStatus(context, savedReceipt
      ? `Saved query replay stopped safely (${state.queryError}); its exact generation and parameters were retained.`
      : `Query unavailable (${state.queryError}).`);
  } finally {
    if (revision === state.queryRequestRevision) {
      state.queryRunning = false;
      state.queryAbortController = null;
      context.render();
    }
  }
}

function clearFeatureQuery(context) {
  cancelQueryLocationRequest(context);
  cancelFeatureQueryRequest(context.state);
  context.state.queryDraft = null;
  context.state.queryResult = null;
  context.state.queryError = null;
  context.state.querySelectedFeatureId = null;
  context.state.selectedFeatureIndex = null;
  context.state.queryDrawing = null;
  syncQueryGeometryLayer(context.state);
  syncQueryResultLayer(context, []);
  context.render();
}

function invalidateFeatureQueryResult(context, {render = false} = {}) {
  const {state} = context;
  state.queryResult = null;
  state.queryError = null;
  state.querySelectedFeatureId = null;
  state.selectedFeatureIndex = null;
  syncQueryResultLayer(context, []);
  if (render) {
    context.render();
    return;
  }
  const panel = context.shell.querySelector(".gis-query-panel");
  panel?.querySelector(".gis-query-results")?.remove();
  panel?.querySelector(".gis-query-feedback.error")?.remove();
  if (panel) panel.dataset.queryState = "draft";
}

function cancelFeatureQueryRequest(state) {
  state.queryRequestRevision += 1;
  state.queryAbortController?.abort();
  state.queryAbortController = null;
  state.queryRunning = false;
}

function queryInputValue(value, type) {
  if (type === "boolean") return value === "true";
  if (["integer", "number"].includes(type)) return value === "" ? null : Number(value);
  return value;
}

function queryOperatorOptions(valueType) {
  if (valueType === "string") {
    return [
      ["contains", "contains"],
      ["starts_with", "starts with"],
      ["equals", "equals"],
      ["not_equals", "does not equal"],
      ["is_null", "is empty"]
    ];
  }
  if (valueType === "boolean") {
    return [
      ["equals", "equals"],
      ["not_equals", "does not equal"],
      ["is_null", "is empty"]
    ];
  }
  return [
    ["equals", "equals"],
    ["not_equals", "does not equal"],
    ["greater_than", "greater than"],
    ["greater_than_or_equal", "greater than or equal"],
    ["less_than", "less than"],
    ["less_than_or_equal", "less than or equal"],
    ["is_null", "is empty"]
  ];
}

function queryDraftReady(draft) {
  return draft.steps.length >= 1 && draft.steps.every((step) => {
    if (step.kind === "spatial") {
      return Number.isFinite(step.buffer_meters)
        && step.buffer_meters >= 0
        && step.buffer_meters <= FEATURE_QUERY_LIMITS.maximumBufferMeters;
    }
    return step.operator === "is_null" || (
      step.value !== null
      && step.value !== ""
      && (typeof step.value !== "number" || Number.isFinite(step.value))
    );
  });
}

function inferredFieldType(geojson, field) {
  const value = (geojson?.features ?? [])
    .map((feature) => feature.properties?.[field])
    .find((candidate) => candidate !== null && candidate !== undefined);
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "string";
}

function basemapPanel(context) {
  const panel = panelShell();
  const basemap = activeBasemap(context);
  const summary = editorSection(
    "Map background",
    "Basemap choices now open in one focused dialog over the map. Layer styling remains in this inspector."
  );
  summary.append(
    compactKeyValues({
      "Current": basemap?.title ?? "Blank canvas",
      "Body": context.state.spatialBody.title,
      "Opacity": `${Math.round(context.state.basemapOpacity * 100)}%`,
      "Catalog status": basemap?.governance
        ? `${basemapGovernanceLabel(basemap.governance)} · ${basemap.governance.observation.observedAt}`
        : "Project-managed source"
    }),
    actionButton("Change basemap", () => openBasemapChooser(context))
  );
  panel.append(summary);
  return panel;
}

function basemapPreview(basemap) {
  const preview = document.createElement("span");
  preview.className = "gis-basemap-preview";
  preview.dataset.basemap = basemap.preview ?? basemap.basemapId ?? basemap.catalogId;
  preview.setAttribute("aria-hidden", "true");
  return preview;
}

function regionalBasemapSourceStudio(context) {
  const draft = context.state.regionalBasemapDraft;
  const section = editorSection(
    "Regional XYZ basemap",
    "Register an anonymous HTTPS tile source as a project dataset. OpenGeo Studio records its exact revision, license, WGS84 coverage, and coordinate behavior before it can become a map background. Registration performs syntax checks only."
  );
  const title = textInput("Name", draft.title);
  const url = textInput("XYZ tile URL", draft.url);
  const attribution = textInput("Attribution", draft.attribution);
  const license = textInput("License or terms reference", draft.license);
  const coverage = textInput("Coverage · west, south, east, north", draft.coverage);
  const scheme = selectInput("Tile row order", draft.scheme, [["xyz", "XYZ"], ["tms", "TMS"]]);
  const coordinates = selectInput(
    "Coordinate behavior",
    draft.coordinateBehavior,
    [
      ["wgs84_web_mercator", "WGS84 / Web Mercator aligned"],
      ["gcj02_offset", "GCJ-02 offset · record only"]
    ]
  );
  for (const [field, control] of [
    ["title", title],
    ["url", url],
    ["attribution", attribution],
    ["license", license],
    ["coverage", coverage]
  ]) {
    control.input.addEventListener("input", () => {
      draft[field] = control.input.value;
    });
  }
  scheme.input.addEventListener("change", () => {
    draft.scheme = scheme.input.value;
  });
  coordinates.input.addEventListener("change", () => {
    draft.coordinateBehavior = coordinates.input.value;
  });
  const add = actionButton("Register and use basemap", () => {
    void registerRegionalBasemapSource(context, {
      title: title.input.value,
      url: url.input.value,
      attribution: attribution.input.value,
      license: license.input.value,
      coverage: coverage.input.value,
      scheme: scheme.input.value,
      coordinateBehavior: coordinates.input.value
    });
  });
  section.append(
    title.wrapper,
    url.wrapper,
    attribution.wrapper,
    license.wrapper,
    coverage.wrapper,
    scheme.wrapper,
    coordinates.wrapper,
    add
  );
  return section;
}

async function registerRegionalBasemapSource(context, input) {
  if (context.state.spatialBody.id !== "earth") {
    setStatus(context, `Regional Earth sources cannot be attached to a ${context.state.spatialBody.title} project.`);
    return;
  }
  if (typeof context.registerSource !== "function") {
    setStatus(context, "A persistent editable project is required to register a regional basemap.");
    return;
  }
  const coverageBounds = input.coverage
    .split(",")
    .map((value) => Number(value.trim()));
  if (
    coverageBounds.length !== 4
    || coverageBounds.some((value) => !Number.isFinite(value))
    || coverageBounds[0] < -180
    || coverageBounds[2] > 180
    || coverageBounds[1] < -90
    || coverageBounds[3] > 90
    || coverageBounds[0] >= coverageBounds[2]
    || coverageBounds[1] >= coverageBounds[3]
  ) {
    setStatus(context, "Regional basemap coverage must be ordered WGS84 bounds: west, south, east, north.");
    return;
  }
  setStatus(context, "Registering governed regional XYZ basemap…");
  try {
    const source = await context.registerSource({
      name: input.title.trim() || "Regional imagery",
      description: "Project-governed regional basemap source",
      classification: "internal",
      tags: ["xyz", "external-source", "basemap", "regional"],
      source: {
        type: "xyz",
        url: input.url.trim(),
        minZoom: 0,
        maxZoom: 22,
        tileSize: 256,
        scheme: input.scheme,
        attribution: input.attribution.trim(),
        presentationRole: "regional_basemap",
        license: input.license.trim(),
        coverageBounds,
        coordinateBehavior: input.coordinateBehavior
      }
    });
    context.sources.push(source);
    const regional = buildBasemapCatalog(
      allBasemaps(context),
      context.basemapConnectionBindings,
      context.state.selectedBasemapConnectionBindingId,
      [source],
      context.state.currentBasemapId
    ).find(({groupId}) => groupId === "regional");
    const choice = regional?.choices?.find((candidate) => (
      candidate.datasetId === source.datasetId
      && candidate.sourceVersion === source.versionNumber
    ));
    if (choice?.availability === "available") {
      await selectBasemapChoice(context, choice);
      if (context.state.currentBasemapId === choice.basemapId) {
        context.state.basemapCatalogMessage = `${choice.title} registered as governed revision ${source.versionNumber} and selected after its browser-session availability check.`;
        setStatus(context, `${choice.title} regional basemap selected. Save the map to persist this exact source revision.`);
      }
    } else {
      context.state.basemapCatalogMessage = `${source.name} was recorded, but its coordinate behavior requires an approved transform before display.`;
      setStatus(context, context.state.basemapCatalogMessage);
    }
    context.render();
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Regional basemap registration failed (${error?.code ?? "invalid_source"}).${request}`);
  }
}

function customStyleBasemap(context) {
  const section = editorSection("Add a custom basemap", "Paste a public HTTPS MapLibre style or XYZ raster template. URLs with embedded credentials or query strings are rejected. Configure browser-key providers through Connections so projects save only a reusable binding.");
  section.classList.add("gis-basemap-custom-source");
  const kind = selectInput("Source type", "maplibre-style", [
    ["maplibre-style", "MapLibre style JSON"],
    ["raster", "XYZ raster tiles"]
  ]);
  const title = textInput("Name", "Custom basemap");
  const url = textInput("Public HTTPS URL", "https://example.org/styles/basemap.json");
  const attribution = textInput("Attribution", "Source and data contributors");
  kind.input.addEventListener("change", () => {
    url.input.value = kind.input.value === "raster"
      ? "https://tiles.example.org/{z}/{x}/{y}.png"
      : "https://example.org/styles/basemap.json";
  });
  const add = actionButton("Use custom basemap", () => {
    try {
      const basemapId = `custom-${crypto.randomUUID()}`;
      const basemap = customBasemapDefinition({
        basemapId,
        sourceType: kind.input.value,
        title: title.input.value,
        url: url.input.value,
        attribution: attribution.input.value
      });
      void selectBasemapChoice(context, basemap);
    } catch {
      setStatus(context, "Custom basemap rejected. Use a public, query-free HTTPS style URL or an XYZ URL with {z}, {x}, and {y}; include attribution. Key-based providers require a reusable OpenGeo Studio connection.");
      context.render();
    }
  });
  section.append(kind.wrapper, title.wrapper, url.wrapper, attribution.wrapper, add);
  return section;
}

function pmtilesBasemapStudio(context) {
  const section = editorSection("PMTiles source", "Register a public, query-free HTTPS archive as a governed source revision, then render it locally through MapLibre's pmtiles:// protocol.");
  section.append(compactKeyValues({
    "Protocol": context.state.pmtilesReady ? "registered" : "not registered",
    "Access": "Anonymous public HTTPS",
    "Style workflow": "OSM Liberty / Maputnik style JSON"
  }));
  const title = textInput("Layer title", "PMTiles vector layer");
  const url = textInput("PMTiles HTTPS URL", "https://data.example.org/basemaps/workspace-basemap.pmtiles");
  const sourceLayer = textInput("Source layer", "transportation");
  const geometry = selectInput("Geometry", "LineString", [["Point", "Point"], ["LineString", "LineString"], ["Polygon", "Polygon"]]);
  const add = externalSourceRegistrationButton(context, "pmtiles", "Register PMTiles source", () => {
    void registerExternalSource(context, {
      name: title.input.value || "PMTiles vector layer",
      source: {
        type: "pmtiles",
        url: url.input.value,
        tileType: "vector",
        sourceLayer: sourceLayer.input.value,
        geometryType: geometry.input.value,
        minZoom: 0,
        maxZoom: 24,
        attribution: null
      }
    }, {offerProtectedCopy: true});
  });
  section.append(title.wrapper, url.wrapper, sourceLayer.wrapper, geometry.wrapper, add);
  return section;
}

function addDataPanel(context) {
  const {state} = context;
  const panel = panelShell();
  const source = addSource(state.activeAddSource);
  panel.append(addSourceSelector(context));
  panel.append(textElement("h3", source?.[1] ?? "Add data"));
  panel.append(textElement("p", source?.[2] ?? "Register a data source."));
  if (context.publicDemo) panel.append(actionButton("Browse Layer catalog", () => {state.activePanel = "catalog"; state.rightOpen = true; context.render();}));
  panel.append(projectDatasetChoices(context));

  const fileLabel = document.createElement("label");
  fileLabel.className = "gis-file-drop";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = context.publicDemo
    ? ".geojson,.json,.csv,.tsv,.txt,.wkt,.wkb,.ewkb,.kml,.kmz,.gpx,.nmea,.nme,.wpt,.plt,application/gpx+xml,application/geo+json,application/json,text/csv,text/plain,application/octet-stream,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
    : `${MANAGED_FILE_ACCEPT},.tsv,.txt,.wkt,.wkb,.ewkb,.kml,.kmz,.gpx,.nmea,.nme,.wpt,.plt,application/gpx+xml,text/plain,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz`;
  file.addEventListener("change", async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const reviewBrowserLayer = browserLayerReviewForProject(context);
    try {
      if (/\.(gpx|nmea|nme|wpt|plt|rte|pnt|evt)$/i.test(selected.name)) {await openGpsLayer(context, selected);return;}
      if (/\.(csv|tsv|txt)$/i.test(selected.name) && (context.publicDemo || state.activeAddSource === "csv")) {await openDelimitedLayer(context, selected);return;}
      if (/\.(kml|kmz)$/i.test(selected.name)) {
        const parsed = await parseKmlFile(selected);
        if (context.publicDemo) {
          reviewBrowserLayer({layer: kmlPlacesLayer(parsed.document.name, `kml_${crypto.randomUUID()}`), geojson: parsed.geojson, source: {filename: selected.name, format: parsed.source.format, bytes: selected.size, description: parsed.document.description, document: parsed.document, report: parsed.report}, onAdd: async layer => {await importKmlPlaces(context, selected, parsed, layer); fitLayer(context.state.map, layer, context.dataByLayerId);}});
        } else await importKmlPlaces(context, selected, parsed);
        return;
      }
      if (/\.(wkt|wkb|ewkb)$/i.test(selected.name)
        && !context.publicDemo
        && context.persistenceMode === "api") {
        if (typeof context.importLocalFile !== "function") {
          throw Object.assign(new Error("Managed ingestion is unavailable."), {code: "managed_upload_unavailable"});
        }
        const parsed = await prepareManagedSpatialFile(selected);
        const convertedFile = parsed.file;
        context.shell.dataset.importState = "running";
        const completion = await context.importLocalFile(convertedFile, (stage, message) => {
          context.shell.dataset.importState = stage;
          setStatus(context, message);
        }, {
          description: `Browser-normalized from ${selected.name} with OpenLayers 10.10.0; original ${parsed.source.format.toUpperCase()} properties are unavailable because the source is geometry-only.`,
          tags: ["opened-locally", `converted-${parsed.source.format}`, "openlayers-10.10.0"]
        });
        context.shell.dataset.importState = "queued";
        setStatus(context, `${completion.dataset.name} was normalized from ${selected.name} to governed CRS84 GeoJSON and queued at version ${completion.versionNumber}.`);
        return;
      }
      if (!context.publicDemo && context.persistenceMode === "api") {
        if (typeof context.importLocalFile !== "function") {
          throw Object.assign(new Error("Managed ingestion is unavailable."), {code: "managed_upload_unavailable"});
        }
        context.shell.dataset.importState = "running";
        const completion = await context.importLocalFile(selected, (stage, message) => {
          context.shell.dataset.importState = stage;
          setStatus(context, message);
        });
        context.shell.dataset.importState = "queued";
        setStatus(context, `${completion.dataset.name} is now a governed dataset queued at version ${completion.versionNumber}; the local file was not added as an untracked scratch layer.`);
        return;
      }
      const {layer, geojson} = await layerFromFile(selected);
      if (context.publicDemo) {
        reviewBrowserLayer({layer, geojson, source: {filename: selected.name, bytes: selected.size, format: layer.sourceType}, onAdd: async (reviewed, data) => {context.addLayer(reviewed, data); rememberBrowserLayer(context, {layer: reviewed, geojson: data}); fitLayer(context.state.map, reviewed, context.dataByLayerId); setStatus(context, `Added ${reviewed.title}. Source metadata is retained in this browser draft.`);}});
        return;
      }
      context.addLayer(layer, geojson);
      setStatus(context, context.publicDemo
        ? `Added ${layer.title} from ${selected.name} in browser memory only.`
        : `Added ${layer.title} from ${selected.name} to the explicit memory-only fixture.`);
    } catch (error) {
      context.shell.dataset.importState = "error";
      const request = error?.requestId ? ` Request ${error.requestId}.` : "";
      setStatus(context, `Governed file import failed safely (${error?.code ?? "invalid_file"}).${request}`);
    }
  });
  fileLabel.append(
    file,
    textElement("strong", "Choose local file"),
    textElement("span", context.publicDemo || context.persistenceMode === "fixture"
      ? "GeoJSON, WKT, WKB/EWKB, delimited coordinates, GPX, NMEA, OziExplorer WPT/PLT, KML, or KMZ · browser project"
      : "WKT/WKB normalize to governed GeoJSON; KML/KMZ attach to the map; other files hash, upload, verify, and queue")
  );
  panel.append(fileLabel);

  if (state.activeAddSource === "xyz") panel.append(xyzForm(context));
  else if (state.activeAddSource === "wms") panel.append(wmsForm(context));
  else if (state.activeAddSource === "mapserver") panel.append(mapServerForm(context));
  else if (state.activeAddSource === "imageserver") panel.append(imageServerForm(context));
  else if (state.activeAddSource === "arcgis") panel.append(discoverableFeatureForm(context, "arcgis"));
  else if (state.activeAddSource === "wfs") panel.append(discoverableFeatureForm(context, "wfs"));
  else if (state.activeAddSource === "pmtiles") panel.append(pmtilesLayerForm(context));
  else panel.append(awsRegistrationForm(context, source));

  return panel;
}

function addSourceSelector(context) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Source type");
  for (const {section, sources} of ADD_DATA_SOURCES) {
    const group = document.createElement("optgroup");
    group.label = section;
    for (const [id, title] of sources) {
      group.append(selectOption({
        value: id,
        title,
        selected: id === context.state.activeAddSource
      }));
    }
    select.append(group);
  }
  select.addEventListener("change", () => openAddSource(context, select.value));
  return fieldWrap("Source type", select);
}

function openTemporaryWorkPanel(context) {
  const {state} = context;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  state.activePanel = "temporary";
  state.rightOpen = true;
  setStatus(context, "Temporary work opened. These annotations are isolated from authoritative project layers and expire after 24 hours.");
  context.render();
}

function temporaryWorkPanel(context) {
  const panel = panelShell();
  const temporaryLayers = context.layers.filter(isTemporaryLayer);
  const introduction = document.createElement("section");
  introduction.className = "gis-callout gis-temporary-work-notice";
  introduction.append(
    textElement("strong", "Browser-only scratch work"),
    textElement(
      "span",
      `Draw or inspect up to ${TEMPORARY_WORK_LIMITS.maximumLayers} temporary layers. Work is isolated to this project and browser, expires after 24 hours, and is never included in Save or Save as.`
    )
  );
  panel.append(introduction);

  if (context.publicDemo) {
    const copies = editorSection("Edit sample data", "Make an independent browser copy. The original sample stays unchanged. Copies are limited to 1 MiB, 1,000 features and 10,000 coordinates.");
    for (const layer of context.layers.filter(layer => !isTemporaryLayer(layer))) {
      const data = context.dataByLayerId.get(layer.layerId);
      if (!data?.features?.length) continue;
      const copy = actionButton(`Edit a copy · ${layer.title}`, () => {
        try {
          if (context.layers.filter(isTemporaryLayer).length >= TEMPORARY_WORK_LIMITS.maximumLayers) throw new Error("Remove a temporary layer first.");
          const entry = createTemporaryUpload({
            fileName: `${layer.title} — editable copy.geojson`, format: "geojson", geojson: data,
            byteLength: new TextEncoder().encode(JSON.stringify(data)).byteLength
          });
          context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});
          persistTemporaryWork(context);
          setStatus(context, "Editable browser copy added. The original sample is unchanged.");
        } catch (error) {
          setStatus(context, `Copy not created: ${error.code ?? error.message}. Large samples can still be styled without copying.`);
        }
        context.render();
      });
      copy.disabled = temporaryLayers.length >= TEMPORARY_WORK_LIMITS.maximumLayers;
      copies.append(copy);
    }
    panel.append(copies);
  }

  const draw = editorSection(
    "Draw annotations",
    "Use the same map interaction as the primary Point, Path, and Polygon tools while keeping the result explicitly non-authoritative."
  );
  const drawActions = document.createElement("div");
  drawActions.className = "gis-temporary-actions";
  for (const [label, kind] of [["Draw temporary point", "Point"], ["Draw temporary path", "LineString"], ["Draw temporary polygon", "Polygon"]]) {
    const button = actionButton(label, () => beginMapAuthoring(context, kind, {target: "temporary"}));
    button.disabled = temporaryLayers.length >= TEMPORARY_WORK_LIMITS.maximumLayers;
    drawActions.append(button);
  }
  draw.append(drawActions);
  panel.append(draw);

  const uploadSection = editorSection(
    "Open temporary data",
    `GeoJSON or KML only · ${Math.floor(TEMPORARY_WORK_LIMITS.maximumUploadBytes / 1024)} KiB maximum · active XML and unsupported geometry are rejected.`
  );
  const fileLabel = document.createElement("label");
  fileLabel.className = "gis-file-drop";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".geojson,.json,.kml,application/geo+json,application/json,application/vnd.google-earth.kml+xml";
  file.disabled = temporaryLayers.length >= TEMPORARY_WORK_LIMITS.maximumLayers;
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (selected) void importTemporaryFile(context, selected);
  });
  fileLabel.append(
    file,
    textElement("strong", "Choose temporary GeoJSON or KML"),
    textElement("span", "The source stays in browser storage until expiry or removal. It does not become a dataset or project source.")
  );
  uploadSection.append(fileLabel);
  panel.append(uploadSection);

  const current = editorSection(
    `Current temporary work (${temporaryLayers.length}/${TEMPORARY_WORK_LIMITS.maximumLayers})`,
    "Promoting a layer creates a separate governed-ingest request. It never changes the temporary layer into an authoritative feature layer in place."
  );
  if (!temporaryLayers.length) current.append(textElement("p", "No temporary annotations or uploads are open."));
  for (const layer of temporaryLayers) {
    const item = document.createElement("article");
    item.className = "gis-temporary-work-item";
    item.dataset.temporaryLayerId = layer.layerId;
    const details = document.createElement("div");
    details.append(
      textElement("strong", layer.title),
      textElement("small", `${temporaryWorkExpiryLabel(layer)} · ${layer.temporaryWork.format}`)
    );
    const actions = document.createElement("div");
    let editableFeatureIndexes = [];
    try {
      editableFeatureIndexes = editableTemporaryFeatureIndexes(context.dataByLayerId.get(layer.layerId));
    } catch {
      // A rejected temporary payload remains removable but never enters the editor.
    }
    const edit = actionButton(
      context.state.temporaryEdit?.layerId === layer.layerId ? "Continue editing" : "Edit geometry",
      () => beginTemporaryEdit(context, layer, editableFeatureIndexes[0])
    );
    edit.disabled = !editableFeatureIndexes.length;
    edit.title = editableFeatureIndexes.length
      ? `${editableFeatureIndexes.length} simple ${editableFeatureIndexes.length === 1 ? "feature is" : "features are"} editable`
      : "Only simple Point, LineString, and single-ring Polygon features can be edited";
    const promote = actionButton(
      context.persistenceMode === "api" && !context.publicDemo ? "Review promotion" : "Promotion requires Studio",
      () => stageTemporaryPromotion(context, layer)
    );
    promote.disabled = context.persistenceMode !== "api" || context.publicDemo || typeof context.importLocalFile !== "function";
    const remove = actionButton("Remove", () => removeLayer(context, layer));
    remove.classList.add("danger");
    actions.append(edit, promote, remove);
    if (layer.metadata?.source?.format === "gpx") actions.append(actionButton("Download original GPX", async () => {
      try {const {downloadOriginalGpx} = await import("../lib/gpxImport.js");await downloadOriginalGpx(layer.metadata.source);}
      catch (error) {setStatus(context, error.message);}
    }));
    if (layer.metadata?.source?.format === "nmea") actions.append(actionButton("Download original NMEA", async () => {
      try {const {downloadOriginalNmea} = await import("../lib/nmeaImport.js");await downloadOriginalNmea(layer.metadata.source);}
      catch (error) {setStatus(context, error.message);}
    }));
    if (layer.metadata?.source?.format === "ozi") actions.append(actionButton("Download original OziExplorer file", async () => {
      try {const {downloadOriginalOzi} = await import("../lib/oziImport.js");await downloadOriginalOzi(layer.metadata.source);}
      catch (error) {setStatus(context, error.message);}
    }));
    if (layer.metadata?.source?.format === "delimited-text") actions.append(actionButton("Download original delimited file", async () => {
      try {const {downloadOriginalDelimitedFile} = await import("../lib/delimitedTextImport.js");await downloadOriginalDelimitedFile(layer.metadata.source);}
      catch (error) {setStatus(context, error.message);}
    }));
    item.append(details, actions);
    current.append(item);
  }
  const storageActions = document.createElement("div");
  storageActions.className = "gis-temporary-actions";
  const save = actionButton("Save temporary work", () => {
    persistTemporaryWork(context);
    setStatus(context, "Temporary work saved in this browser under a project-specific key. It remains excluded from the authoritative map.");
    context.render();
  });
  save.disabled = !temporaryLayers.length;
  const clear = actionButton("Clear temporary work", () => clearTemporaryLayers(context));
  clear.disabled = !temporaryLayers.length;
  clear.classList.add("danger");
  storageActions.append(save, clear);
  current.append(storageActions);
  panel.append(current);

  if (context.state.temporaryEdit) panel.append(temporaryGeometryEditor(context));

  const promotionLayer = temporaryLayers.find(({layerId}) => layerId === context.state.temporaryPromotionLayerId);
  if (promotionLayer) panel.append(temporaryPromotionReview(context, promotionLayer));
  if (context.state.temporaryWorkMessage) panel.append(textElement("p", context.state.temporaryWorkMessage));
  return panel;
}

function beginTemporaryEdit(context, layer, featureIndex = null) {
  if (!isTemporaryLayer(layer)) return;
  try {
    const geojson = context.dataByLayerId.get(layer.layerId);
    const editableFeatureIndexes = editableTemporaryFeatureIndexes(geojson);
    const selectedFeatureIndex = editableFeatureIndexes.includes(featureIndex)
      ? featureIndex
      : editableFeatureIndexes[0];
    if (!Number.isInteger(selectedFeatureIndex)) throw Object.assign(
      new Error("temporary_geometry_not_editable"),
      {code: "temporary_geometry_not_editable"}
    );
    cancelMapAuthoring(context, {render: false, announce: false});
    cancelQueryDrawing(context, {render: false, announce: false});
    stateStopMeasurement(context.state);
    context.state.temporaryEdit = {
      layerId: layer.layerId,
      featureIndex: selectedFeatureIndex,
      editableFeatureIndexes,
      selectedVertexIndex: temporaryFeatureVertices(geojson, selectedFeatureIndex).length === 1 ? 0 : null,
      originalGeojson: structuredClone(geojson),
      draftGeojson: structuredClone(geojson)
    };
    context.state.activeLayerId = layer.layerId;
    context.state.activePanel = "temporary";
    context.state.rightOpen = true;
    if (isMobileWorkbenchViewport()) context.state.leftOpen = false;
    syncTemporaryEditLayer(context.state);
    setStatus(context, temporaryEditInstruction(context.state.temporaryEdit));
    context.render();
    focusTemporaryEditor(context, {coordinate: context.state.temporaryEdit.selectedVertexIndex === 0});
  } catch (error) {
    setStatus(context, `Temporary geometry cannot be edited safely (${error?.code ?? "temporary_geometry_not_editable"}).`);
  }
}

function temporaryGeometryEditor(context) {
  const edit = context.state.temporaryEdit;
  const layer = context.layers.find(({layerId}) => layerId === edit?.layerId);
  const section = editorSection(
    "Edit temporary geometry",
    "Select a vertex on the map or from this list, then click its new map location or enter an exact CRS84 longitude and latitude. Changes remain browser-only until you save them here."
  );
  section.classList.add("gis-temporary-geometry-editor");
  section.dataset.temporaryEditor = "active";
  if (!edit || !layer) {
    section.append(textElement("p", "The temporary layer is no longer available."));
    return section;
  }
  const featurePosition = edit.editableFeatureIndexes.indexOf(edit.featureIndex);
  const feature = edit.draftGeojson.features[edit.featureIndex];
  const vertices = temporaryFeatureVertices(edit.draftGeojson, edit.featureIndex);
  section.append(compactKeyValues({
    Layer: layer.title,
    Feature: `${featurePosition + 1} of ${edit.editableFeatureIndexes.length}`,
    Geometry: feature.geometry.type,
    Persistence: "Temporary browser work only"
  }));

  if (edit.editableFeatureIndexes.length > 1) {
    const featureActions = document.createElement("div");
    featureActions.className = "gis-temporary-actions";
    const previous = actionButton("Previous feature", () => selectTemporaryEditFeature(context, -1));
    const next = actionButton("Next feature", () => selectTemporaryEditFeature(context, 1));
    previous.disabled = featurePosition <= 0;
    next.disabled = featurePosition >= edit.editableFeatureIndexes.length - 1;
    featureActions.append(previous, next);
    section.append(featureActions);
  }

  const vertexList = document.createElement("div");
  vertexList.className = "gis-temporary-vertex-list";
  vertexList.setAttribute("aria-label", `Vertices for ${layer.title}`);
  for (const [index, coordinates] of vertices.entries()) {
    const button = actionButton(
      `Vertex ${index + 1}: ${formatTemporaryCoordinate(coordinates)}`,
      () => selectTemporaryEditVertex(context, index)
    );
    button.setAttribute("aria-pressed", String(edit.selectedVertexIndex === index));
    button.classList.toggle("active", edit.selectedVertexIndex === index);
    vertexList.append(button);
  }
  section.append(vertexList);

  const selectedCoordinates = Number.isInteger(edit.selectedVertexIndex)
    ? vertices[edit.selectedVertexIndex]
    : null;
  const coordinateFields = document.createElement("div");
  coordinateFields.className = "gis-temporary-coordinate-fields";
  const longitude = temporaryCoordinateInput("Longitude", selectedCoordinates?.[0], -180, 180);
  longitude.input.dataset.temporaryCoordinate = "longitude";
  const latitude = temporaryCoordinateInput("Latitude", selectedCoordinates?.[1], -90, 90);
  latitude.input.dataset.temporaryCoordinate = "latitude";
  coordinateFields.append(longitude.label, latitude.label);
  const apply = actionButton("Apply coordinate", () => moveTemporaryEditVertex(context, [
    Number(longitude.input.value),
    Number(latitude.input.value)
  ]));
  apply.disabled = !selectedCoordinates;
  coordinateFields.append(apply);
  section.append(coordinateFields);

  const actions = document.createElement("div");
  actions.className = "gis-temporary-actions";
  actions.append(
    actionButton("Save geometry changes", () => commitTemporaryEdit(context)),
    actionButton("Restore original geometry", () => resetTemporaryEdit(context)),
    actionButton("Cancel geometry editing", () => cancelTemporaryEdit(context))
  );
  section.append(actions);
  return section;
}

function temporaryCoordinateInput(labelText, value, minimum, maximum) {
  const label = document.createElement("label");
  label.className = "gis-field";
  label.append(textElement("span", labelText));
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.min = `${minimum}`;
  input.max = `${maximum}`;
  input.value = Number.isFinite(value) ? `${value}` : "";
  input.disabled = !Number.isFinite(value);
  label.append(input);
  return {label, input};
}

function selectTemporaryEditFeature(context, direction) {
  const edit = context.state.temporaryEdit;
  if (!edit) return;
  const current = edit.editableFeatureIndexes.indexOf(edit.featureIndex);
  const next = Math.max(0, Math.min(edit.editableFeatureIndexes.length - 1, current + direction));
  edit.featureIndex = edit.editableFeatureIndexes[next];
  edit.selectedVertexIndex = temporaryFeatureVertices(edit.draftGeojson, edit.featureIndex).length === 1 ? 0 : null;
  syncTemporaryEditLayer(context.state);
  setStatus(context, temporaryEditInstruction(edit));
  context.render();
  focusTemporaryEditor(context, {coordinate: edit.selectedVertexIndex === 0});
}

function selectTemporaryEditVertex(context, vertexIndex) {
  const edit = context.state.temporaryEdit;
  if (!edit) return;
  const vertices = temporaryFeatureVertices(edit.draftGeojson, edit.featureIndex);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertices.length) return;
  edit.selectedVertexIndex = vertexIndex;
  syncTemporaryEditLayer(context.state);
  setStatus(context, temporaryEditInstruction(edit));
  context.render();
  focusTemporaryEditor(context, {coordinate: true});
}

function moveTemporaryEditVertex(context, position) {
  const edit = context.state.temporaryEdit;
  if (!edit || !Number.isInteger(edit.selectedVertexIndex)) return;
  try {
    const movedVertex = edit.selectedVertexIndex;
    edit.draftGeojson = replaceTemporaryFeatureVertex(edit.draftGeojson, {
      featureIndex: edit.featureIndex,
      vertexIndex: movedVertex,
      position
    });
    edit.selectedVertexIndex = null;
    syncTemporaryEditLayer(context.state);
    setStatus(context, `Temporary vertex ${movedVertex + 1} moved in the browser-only draft. Save geometry changes to retain it.`);
    context.render();
    focusTemporaryEditor(context, {vertexIndex: movedVertex});
  } catch (error) {
    setStatus(context, `Temporary vertex move rejected safely (${error?.code ?? "temporary_position_invalid"}).`);
  }
}

function commitTemporaryEdit(context) {
  const edit = context.state.temporaryEdit;
  const layer = context.layers.find(({layerId}) => layerId === edit?.layerId);
  if (!edit || !layer || !isTemporaryLayer(layer)) {
    cancelTemporaryEdit(context, {announce: false});
    return;
  }
  context.dataByLayerId.set(layer.layerId, structuredClone(edit.draftGeojson));
  const source = context.state.map?.getSource?.(sourceId(layer));
  source?.setData?.(edit.draftGeojson);
  context.state.temporaryEdit = null;
  syncTemporaryEditLayer(context.state);
  const stored = persistTemporaryWork(context);
  context.state.temporaryWorkMessage = stored
    ? `${layer.title} geometry updated in project-scoped browser storage. No authoritative dataset or saved map changed.`
    : `${layer.title} geometry changed in memory, but browser storage rejected the update.`;
  setStatus(context, context.state.temporaryWorkMessage);
  context.render();
  focusTemporaryWorkItem(context, layer.layerId);
}

function resetTemporaryEdit(context) {
  const edit = context.state.temporaryEdit;
  if (!edit) return;
  edit.draftGeojson = structuredClone(edit.originalGeojson);
  edit.selectedVertexIndex = temporaryFeatureVertices(edit.draftGeojson, edit.featureIndex).length === 1 ? 0 : null;
  syncTemporaryEditLayer(context.state);
  setStatus(context, "Temporary geometry restored to the state from the start of this edit session.");
  context.render();
  focusTemporaryEditor(context, {coordinate: edit.selectedVertexIndex === 0});
}

function cancelTemporaryEdit(context, {render = true, announce = true} = {}) {
  const layerId = context.state.temporaryEdit?.layerId;
  if (!layerId) return;
  context.state.temporaryEdit = null;
  syncTemporaryEditLayer(context.state);
  if (announce) setStatus(context, "Temporary geometry editing canceled. The stored temporary layer was not changed.");
  if (render) {
    context.render();
    focusTemporaryWorkItem(context, layerId);
  }
}

function focusTemporaryEditor(context, {coordinate = false, vertexIndex = null} = {}) {
  requestAnimationFrame(() => {
    const editor = context.shell.querySelector('[data-temporary-editor="active"]');
    if (!editor) return;
    const target = coordinate
      ? editor.querySelector('input[data-temporary-coordinate="longitude"]:not([disabled])')
      : Number.isInteger(vertexIndex)
        ? editor.querySelectorAll(".gis-temporary-vertex-list .gis-button")[vertexIndex]
        : editor.querySelector(".gis-temporary-vertex-list .gis-button");
    target?.focus?.();
  });
}

function focusTemporaryWorkItem(context, layerId) {
  requestAnimationFrame(() => {
    const item = [...context.shell.querySelectorAll(".gis-temporary-work-item")]
      .find((candidate) => candidate.dataset.temporaryLayerId === layerId);
    item?.querySelector(".gis-button:not([disabled])")?.focus?.();
  });
}

function handleTemporaryEditMapClick(context, event) {
  const edit = context.state.temporaryEdit;
  const map = context.state.map;
  if (!edit || !map) return;
  const vertexLayerId = "opengeo-temporary-edit-vertices";
  const hit = event?.point && map.getLayer?.(vertexLayerId)
    ? map.queryRenderedFeatures?.(event.point, {layers: [vertexLayerId]})?.[0]
    : null;
  const vertexIndex = Number(hit?.properties?.vertexIndex);
  if (Number.isInteger(vertexIndex)) {
    selectTemporaryEditVertex(context, vertexIndex);
    return;
  }
  if (!Number.isInteger(edit.selectedVertexIndex)) {
    setStatus(context, "Select a highlighted vertex on the map or in the temporary-work panel before choosing its new location.");
    return;
  }
  moveTemporaryEditVertex(context, [
    boundedCoordinate(event?.lngLat?.lng, 0),
    boundedCoordinate(event?.lngLat?.lat, 0)
  ]);
}

function temporaryEditGuide(context) {
  const edit = context.state.temporaryEdit;
  const guide = document.createElement("section");
  guide.className = "gis-map-authoring-guide gis-temporary-edit-guide";
  guide.dataset.temporaryEdit = "active";
  guide.role = "status";
  guide.ariaLive = "polite";
  guide.append(
    textElement("strong", "Edit temporary geometry"),
    textElement("span", temporaryEditInstruction(edit))
  );
  const actions = document.createElement("div");
  actions.className = "gis-map-authoring-actions";
  actions.append(
    actionButton("Save geometry changes", () => commitTemporaryEdit(context)),
    actionButton("Restore original geometry", () => resetTemporaryEdit(context)),
    actionButton("Cancel geometry editing", () => cancelTemporaryEdit(context))
  );
  guide.append(actions);
  return guide;
}

function temporaryEditInstruction(edit) {
  if (!edit) return "Temporary editor closed.";
  const featurePosition = edit.editableFeatureIndexes.indexOf(edit.featureIndex) + 1;
  return Number.isInteger(edit.selectedVertexIndex)
    ? `Feature ${featurePosition} · vertex ${edit.selectedVertexIndex + 1} selected · click its new map location or enter exact coordinates.`
    : `Feature ${featurePosition} · select a highlighted vertex on the map or in the temporary-work panel.`;
}

function syncTemporaryEditLayer(state, {styleReady = false} = {}) {
  const map = state.map;
  if (!map || (!styleReady && !map.isStyleLoaded?.())) return;
  const sourceId = "opengeo-temporary-edit-source";
  const layerIds = [
    "opengeo-temporary-edit-fill",
    "opengeo-temporary-edit-line",
    "opengeo-temporary-edit-vertices"
  ];
  for (const layerId of layerIds) if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  const edit = state.temporaryEdit;
  if (!edit) return;
  const feature = edit.draftGeojson.features[edit.featureIndex];
  const vertices = temporaryFeatureVertices(edit.draftGeojson, edit.featureIndex);
  const data = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {editRole: "shape"},
        geometry: structuredClone(feature.geometry)
      },
      ...vertices.map((coordinates, vertexIndex) => ({
        type: "Feature",
        properties: {
          editRole: "vertex",
          vertexIndex,
          selected: edit.selectedVertexIndex === vertexIndex
        },
        geometry: {type: "Point", coordinates}
      }))
    ]
  };
  map.addSource(sourceId, {type: "geojson", data});
  map.addLayer({
    id: layerIds[0],
    type: "fill",
    source: sourceId,
    filter: ["all", ["==", ["get", "editRole"], "shape"], ["==", ["geometry-type"], "Polygon"]],
    paint: {"fill-color": "#f59e0b", "fill-opacity": 0.25}
  });
  map.addLayer({
    id: layerIds[1],
    type: "line",
    source: sourceId,
    filter: ["all", ["==", ["get", "editRole"], "shape"], ["!=", ["geometry-type"], "Point"]],
    paint: {"line-color": "#b45309", "line-width": 4, "line-dasharray": [2, 1]}
  });
  map.addLayer({
    id: layerIds[2],
    type: "circle",
    source: sourceId,
    filter: ["==", ["get", "editRole"], "vertex"],
    paint: {
      "circle-color": ["case", ["==", ["get", "selected"], true], "#f59e0b", "#f8fafc"],
      "circle-radius": ["case", ["==", ["get", "selected"], true], 9, 7],
      "circle-stroke-color": "#92400e",
      "circle-stroke-width": 3
    }
  });
}

function stateStopMeasurement(state) {
  state.measureMode = false;
  state.editingMeasurementId = null;
  state.measurePoints = [];
  syncMeasureLayer(state);
}

function formatTemporaryCoordinate(coordinates) {
  return coordinates.slice(0, 2).map((value) => Number(value).toFixed(6).replace(/\.?0+$/, "")).join(", ");
}

function temporaryPromotionReview(context, layer) {
  const section = editorSection(
    "Governed promotion review",
    "OpenGeo Studio will serialize this bounded copy as GeoJSON, then use the managed upload pipeline to hash, upload, verify, and queue a dataset revision for review. The temporary source remains separate."
  );
  section.classList.add("gis-temporary-promotion-review");
  section.append(compactKeyValues({
    "Temporary layer": layer.title,
    "Source authority": "None",
    "Promotion route": "Managed ingest and review",
    "Direct map mutation": "Prohibited"
  }));
  const actions = document.createElement("div");
  actions.className = "gis-temporary-actions";
  const queue = actionButton(
    context.state.temporaryPromotionBusy ? "Queueing governed ingest…" : "Queue governed ingest for review",
    () => void promoteTemporaryLayer(context, layer)
  );
  queue.disabled = context.state.temporaryPromotionBusy;
  queue.setAttribute("aria-busy", String(context.state.temporaryPromotionBusy));
  actions.append(queue, actionButton("Cancel promotion", () => {
    context.state.temporaryPromotionLayerId = null;
    context.state.temporaryWorkMessage = null;
    context.render();
  }));
  section.append(actions);
  return section;
}

function stageTemporaryPromotion(context, layer) {
  if (!isTemporaryLayer(layer) || context.persistenceMode !== "api" || context.publicDemo || typeof context.importLocalFile !== "function") {
    setStatus(context, "Temporary work can be promoted only in authenticated Studio through the managed ingest and review workflow.");
    return;
  }
  context.state.temporaryPromotionLayerId = layer.layerId;
  context.state.temporaryWorkMessage = "Review the separate managed-ingest request below. No authoritative map or dataset has changed.";
  context.state.activePanel = "temporary";
  context.state.rightOpen = true;
  setStatus(context, "Governed promotion staged for review. Confirming will queue a separate managed-ingest request.");
  context.render();
}

async function promoteTemporaryLayer(context, layer) {
  if (!isTemporaryLayer(layer) || context.state.temporaryPromotionBusy || typeof context.importLocalFile !== "function") return;
  const geojson = context.dataByLayerId.get(layer.layerId);
  if (!geojson) {
    setStatus(context, "Temporary promotion stopped safely because the browser geometry is unavailable.");
    return;
  }
  try {
    context.state.temporaryPromotionBusy = true;
    context.render();
    const serialized = JSON.stringify(geojson);
    const name = `${slug(layer.title) || "temporary-work"}.geojson`;
    const file = new File([serialized], name, {type: "application/geo+json"});
    const completion = await context.importLocalFile(file, (stage, message) => {
      context.shell.dataset.importState = stage;
      setStatus(context, message);
    });
    context.state.temporaryPromotionLayerId = null;
    context.state.temporaryWorkMessage = `${completion.dataset.name} was queued as governed dataset version ${completion.versionNumber}. The temporary layer remains browser-only until you remove it or it expires.`;
    setStatus(context, context.state.temporaryWorkMessage);
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    context.state.temporaryWorkMessage = `Governed promotion failed safely (${error?.code ?? "managed_upload_failed"}).${request}`;
    setStatus(context, context.state.temporaryWorkMessage);
  } finally {
    context.state.temporaryPromotionBusy = false;
    context.render();
  }
}

async function importTemporaryFile(context, file) {
  try {
    const byteLength = Number.isInteger(file.size)
      ? file.size
      : new Uint8Array(await file.arrayBuffer()).byteLength;
    if (byteLength > TEMPORARY_WORK_LIMITS.maximumUploadBytes) {
      throw Object.assign(new Error("temporary_upload_too_large"), {code: "temporary_upload_too_large"});
    }
    let geojson;
    let format;
    if (/\.kml$/i.test(file.name)) {
      const parsed = await parseKmlFile(file);
      geojson = parsed.geojson;
      format = "kml";
    } else if (/\.(geojson|json)$/i.test(file.name)) {
      geojson = JSON.parse(await file.text());
      format = file.name.toLowerCase().endsWith(".json") ? "json" : "geojson";
    } else {
      throw Object.assign(new Error("temporary_upload_format_not_supported"), {code: "temporary_upload_format_not_supported"});
    }
    const entry = createTemporaryUpload({fileName: file.name, format, geojson, byteLength});
    context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});
    persistTemporaryWork(context);
    context.state.temporaryWorkMessage = `${entry.layer.title} opened temporarily. It is isolated from authoritative sources and expires after 24 hours.`;
    setStatus(context, context.state.temporaryWorkMessage);
    context.render();
  } catch (error) {
    context.state.temporaryWorkMessage = `Temporary upload rejected safely (${error?.code ?? "invalid_temporary_file"}).`;
    setStatus(context, context.state.temporaryWorkMessage);
    context.render();
  }
}

function selectedProjectDatasetVersion(context, dataset) {
  const target = context.initialDatasetTarget;
  return target?.datasetId === dataset.datasetId ? target.datasetVersionId
    : dataset.sourceType === "upload" ? dataset.currentVersionId ?? null : null;
}

function isPreservedManagedDataset(dataset) {
  return dataset?.sourceType === "upload" && dataset.currentVersionState === "preserved";
}

function isPreservedDatasetLayer(context, layer) {
  const dataset = context.datasets.find(item => item.datasetId === layer.datasetId);
  return isPreservedManagedDataset(dataset)
    && (!layer.datasetVersionId || layer.datasetVersionId === dataset.currentVersionId);
}

function preservedDatasetDisplayChoices(context, dataset, {versionId, canAdd}) {
  const key = `${dataset.datasetId}:${versionId}:${dataset.currentVersionNumber}`;
  let model = context.preservedDatasetDisplays.get(key);
  if (!model) {
    model = {rows: [], selectedId: "", busy: false, reviewed: false};
    context.preservedDatasetDisplays.set(key, model);
  }
  const panel = document.createElement("div");
  panel.className = "gis-preserved-dataset-displays";
  panel.append(textElement("p", "The original GeoJSON is preserved and has no raw map preview. Choose an admitted tiled display of this exact version. Reviewing metadata does not download tiles."));
  const current = () => !context.disposed && canAdd
    && ["admin", "owner", "editor"].includes(context.role)
    && isPreservedManagedDataset(dataset) && dataset.status === "draft" && dataset.format === "geojson"
    && dataset.currentVersionId === versionId && Number.isSafeInteger(dataset.currentVersionNumber)
    && `${dataset.datasetId}:${versionId}:${dataset.currentVersionNumber}` === key
    && context.datasets.includes(dataset)
    && !hasGovernedDatasetLayer(context.layers, dataset.datasetId, versionId);
  const review = actionButton(model.busy ? "Reviewing tiled displays…" : "Review tiled displays", () => void (async () => {
    if (model.busy || !current() || !context.layerArchiveAccess) return;
    model.busy = true; model.message = null; model.rows = []; model.selectedId = "";
    model.controller = new AbortController(); context.render();
    try {
      await context.layerArchiveAccess.assertScope();
      const layer = layerFromGovernedDataset(dataset, "Point", versionId);
      const result = await context.layerArchiveAccess.list(layer, model.controller.signal);
      model.controller.signal.throwIfAborted();
      if (!current()) throw Error("The dataset version changed. Review Project Data before adding it.");
      if (!matchesReviewedDisplay(result, layer) || !Array.isArray(result.archives) || result.archives.length > 20)
        throw Error("The tiled displays belong to another dataset version. Review Project Data before adding it.");
      model.rows = result.archives.filter(row => row.format === "pmtiles" && typeof row.id === "string"
        && Array.isArray(row.tile_layers) && row.tile_layers.length > 0
        && row.tile_layers.every(part => ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(part.geometry_type)));
      model.reviewed = true;
      if (!model.rows.length) model.message = "No matching admitted tiled display is available. Review and admit a completed conversion in Project Data, then review the displays again.";
    } catch (error) {model.message = error.message;}
    finally {model.busy = false; if (!context.disposed) context.render();}
  })());
  review.disabled = model.busy || !current() || !context.layerArchiveAccess;
  panel.append(review);
  if (model.message) panel.append(textElement("p", model.message));
  if (!model.reviewed || !model.rows.length) return panel;
  const choice = document.createElement("select");
  choice.setAttribute("aria-label", `Admitted tiled display for ${dataset.title}`);
  for (const row of [{id: "", title: "Choose an admitted tiled display"}, ...model.rows]) {
    const option = textElement("option", row.title); option.value = row.id; choice.append(option);
  }
  choice.value = model.selectedId;
  choice.disabled = model.busy || !current();
  choice.addEventListener("change", () => {model.selectedId = choice.value; context.render();});
  const selected = model.rows.find(row => row.id === model.selectedId);
  panel.append(choice);
  if (selected) panel.append(textElement("p", `${formatBytes(selected.download_bytes)} stored output · ${selected.feature_count?.toLocaleString() ?? "Unknown"} reported tile fragments, not source records. Tile downloads require separate consent after Add.`));
  const add = actionButton("Add selected tiled display", () => void (async () => {
    if (!current() || !selected || model.busy) return;
    model.busy = true; context.render();
    try {
      await context.layerArchiveAccess.assertScope();
      if (!current() || !model.rows.includes(selected) || model.selectedId !== selected.id)
        throw Error("The dataset or display selection changed. Review the tiled displays again.");
      const layer = layerFromGovernedDataset(dataset, selected.tile_layers[0].geometry_type, versionId);
      layer.managedDisplayId = selected.id; validateManagedDisplayReference(layer);
      context.addLayer(layer, null);
      setStatus(context, `${dataset.title} added with its reviewed tiled display. Save the Project to retain the selection; acknowledge download costs under Map display before loading tiles.`);
    } catch (error) {model.message = error.message;}
    finally {model.busy = false; if (!context.disposed) context.render();}
  })());
  add.disabled = model.busy || !current() || !selected;
  panel.append(add);
  return panel;
}

function hasGovernedDatasetLayer(layers, datasetId, datasetVersionId = null) {
  // Read legacy IDs unchanged: the persisted source binding, not the ID's
  // spelling, distinguishes an immutable upload from an editable collection.
  return layers.some(layer => layer.datasetId === datasetId && layer.sourceType === "governed-dataset"
    && (layer.datasetVersionId ?? null) === datasetVersionId);
}

function projectDatasetChoices(context) {
  const section = editorSection(
    "Project datasets",
    "Add data already attached to this project. Each map keeps its own layer order, labels, and style."
  );
  const target = context.initialDatasetTarget;
  const targetDataset = target
    ? context.datasets.find(({datasetId}) => datasetId === target.datasetId) ?? null
    : null;
  const targetLayer = target
    ? context.layers.find(({datasetId}) => datasetId === target.datasetId) ?? null
    : null;
  if (target) {
    const notice = document.createElement("aside");
    notice.className = "gis-project-dataset-handoff";
    notice.setAttribute("role", "status");
    if (!targetDataset) {
      notice.dataset.state = "unavailable";
      notice.append(
        textElement("strong", "Dataset is no longer available to this project"),
        textElement("p", "Return to Project Data to choose an authorized dataset.")
      );
    } else if (targetDataset.status === "failed" || targetDataset.currentVersionState === "failed") {
      notice.dataset.state = "failed";
      notice.append(
        textElement("strong", `${targetDataset.title} could not be processed`),
        textElement("p", "Review the processing error in Project Data and upload a corrected file before adding it to a map.")
      );
    } else if (targetDataset.currentVersionId !== target.datasetVersionId) {
      notice.dataset.state = "stale";
      notice.append(
        textElement("strong", `${targetDataset.title} changed before it was added`),
        textElement(
          "p",
          `The requested dataset version is no longer current. Review v${targetDataset.currentVersionNumber ?? "?"} in Project Data before adding it.`
        )
      );
    } else if (!["admin", "owner", "editor"].includes(context.role)) {
      notice.dataset.state = "readonly";
      notice.append(
        textElement("strong", `${targetDataset.title} is view-only`),
        textElement("p", "Project owner or editor access is required to change this map.")
      );
    } else if (targetLayer) {
      notice.dataset.state = "present";
      notice.append(
        textElement("strong", `${targetDataset.title} is already in this map`),
        textElement(
          "p",
          targetLayer.datasetVersionId === target.datasetVersionId
            ? `This layer is pinned to exact dataset v${targetDataset.currentVersionNumber}.`
            : "Review the existing layer before replacing or adding another version."
        )
      );
    } else {
      notice.dataset.state = "ready";
      notice.append(
        textElement("strong", `Ready to add ${targetDataset.title}`),
        textElement(
          "p",
          isPreservedManagedDataset(targetDataset)
            ? `Review admitted tiled displays for exact dataset v${targetDataset.currentVersionNumber}, then choose one below. The map changes only after Add and Save.`
            : `Review exact dataset v${targetDataset.currentVersionNumber}, then confirm below. The map changes only after Add and Save.`
        )
      );
    }
    section.append(notice);
  }
  const available = context.datasets
    .filter(dataset => {
      const versionId = selectedProjectDatasetVersion(context, dataset);
      return !hasGovernedDatasetLayer(context.layers, dataset.datasetId, versionId)
        || (versionId && typeof context.loadDatasetFeatures === "function"
          && !hasGovernedDatasetLayer(context.layers, dataset.datasetId));
    })
    .sort((left, right) => (
      Number(right.datasetId === target?.datasetId) - Number(left.datasetId === target?.datasetId)
      || left.title.localeCompare(right.title)
    ));
  if (!available.length) {
    section.append(textElement(
      "p",
      context.datasets.length
        ? "Every attached dataset is already in this map."
        : "No dataset is attached yet. Open Project records and publishing to upload or reuse governed data."
    ));
    if (!context.datasets.length) {
      const manage = actionButton("Open project datasets", () => revealProjectControl(".project-datasets"));
      manage.classList.add("secondary");
      section.append(manage);
    }
    return section;
  }

  const list = document.createElement("div");
  list.className = "gis-project-dataset-choices";
  for (const dataset of available) {
    const record = document.createElement("article");
    record.className = "gis-project-dataset-choice";
    const isTarget = dataset.datasetId === target?.datasetId;
    if (isTarget) {
      record.dataset.routeTarget = "true";
      record.tabIndex = -1;
    }
    const identity = document.createElement("div");
    identity.append(
      textElement("strong", dataset.title),
      textElement(
        "small",
        [dataset.geometryType, dataset.featureCount === null ? null : `${dataset.featureCount} features`, dataset.classification]
          .filter(Boolean)
          .join(" · ")
      )
    );
    const hasPresentationLayer = context.layers.some(
      ({datasetId}) => datasetId === dataset.datasetId
    );
    const targetVersionMatches = !isTarget || dataset.currentVersionId === target.datasetVersionId;
    const targetCanEdit = !isTarget || ["admin", "owner", "editor"].includes(context.role);
    // Managed uploads have immutable worker previews, not necessarily an
    // initialized editable feature collection. The ordinary chooser must pin
    // the same exact version as a Project Data handoff, without probing /features
    // or substituting a newer/current collection after a preview rejection.
    const selectedVersionId = selectedProjectDatasetVersion(context, dataset);
    const exactAlreadyLoaded = selectedVersionId
      && hasGovernedDatasetLayer(context.layers, dataset.datasetId, selectedVersionId);
    const processingFailed = dataset.status === "failed" || dataset.currentVersionState === "failed";
    if (processingFailed) identity.append(textElement("small", "Review the processing error in Project Data."));
    if (isPreservedManagedDataset(dataset)) {
      record.append(identity, preservedDatasetDisplayChoices(context, dataset, {
        versionId: selectedVersionId,
        canAdd: !processingFailed && targetVersionMatches && targetCanEdit && !exactAlreadyLoaded
      }));
      list.append(record);
      continue;
    }
    const addLabel = processingFailed
      ? "Processing failed"
      : !targetCanEdit
      ? "View only"
      : !targetVersionMatches
      ? "Version changed"
      : exactAlreadyLoaded
        ? "Exact version in map"
      : selectedVersionId
        ? `Add exact v${dataset.currentVersionNumber}`
        : hasPresentationLayer ? "Add authoritative features" : "Add to map";
    const add = actionButton(addLabel, () => {
      void addProjectDatasetToMap(context, dataset, add, {
        expectedVersionId: selectedVersionId
      });
    });
    add.disabled = processingFailed || !targetVersionMatches || !targetCanEdit || Boolean(exactAlreadyLoaded);
    add.setAttribute(
      "aria-label",
      hasPresentationLayer
        ? selectedVersionId ? `Add exact saved version of ${dataset.title}` : `Add authoritative features for ${dataset.title}`
        : `Add ${dataset.title} to map`
    );
    record.append(identity, add);
    if (selectedVersionId && typeof context.loadDatasetFeatures === "function"
      && !hasGovernedDatasetLayer(context.layers, dataset.datasetId)) {
      const live = actionButton("Add authoritative features", () => {
        void addProjectDatasetToMap(context, dataset, live, {liveCollection: true});
      });
      live.classList.add("secondary");
      live.setAttribute("aria-label", `Add authoritative features for ${dataset.title}`);
      live.disabled = processingFailed || !targetCanEdit;
      const disclosure = document.createElement("details");
      disclosure.className = "gis-project-dataset-live-collection";
      const summary = textElement("summary", "Editable feature collection");
      summary.setAttribute("aria-label", `Editable feature collection for ${dataset.title}`);
      disclosure.append(summary, live, textElement("small",
        "Authoritative features use an existing editable collection and its current generation, not the saved upload version. This action does not create a collection."));
      record.append(disclosure);
    }
    list.append(record);
  }
  section.append(list);
  if (targetDataset && !targetLayer && targetDataset.currentVersionId === target?.datasetVersionId
    && ["admin", "owner", "editor"].includes(context.role)) {
    queueMicrotask(() => {
      const record = section.querySelector('[data-route-target="true"]');
      record?.focus({preventScroll: true});
      record?.scrollIntoView?.({block: "nearest"});
    });
  }
  return section;
}

async function addProjectDatasetToMap(
  context,
  dataset,
  button,
  {expectedVersionId = null, liveCollection = false} = {}
) {
  if (isPreservedManagedDataset(dataset)) {
    setStatus(context, `${dataset.title} has no raw map preview. Review and choose an admitted tiled display of its preserved version.`);
    return;
  }
  if (dataset.status === "failed" || dataset.currentVersionState === "failed") {
    setStatus(context, `${dataset.title} could not be processed. Review the error in Project Data before adding it to a map.`);
    return;
  }
  if (expectedVersionId && dataset.currentVersionId !== expectedVersionId) {
    setStatus(context, `${dataset.title} changed before it was added. Review the current version in Project Data.`);
    return;
  }
  const externalSource = liveCollection ? null
    : context.sources.find(({datasetId}) => datasetId === dataset.datasetId);
  const alreadyLoaded = externalSource
    ? context.layers.some(({datasetId, sourceType}) => datasetId === dataset.datasetId && sourceType !== "governed-dataset")
    : hasGovernedDatasetLayer(context.layers, dataset.datasetId, expectedVersionId);
  if (alreadyLoaded) {
    setStatus(context, `${dataset.title} authoritative data is already in this map.`);
    return;
  }
  if (externalSource) {
    context.addLayer(layerFromExternalSource(externalSource), null);
    setStatus(context, `${dataset.title} added from its governed source revision. Save the map to persist its independent presentation.`);
    return;
  }
  const exactPreviewUnavailable = expectedVersionId
    && typeof context.loadDatasetVersionPreview !== "function";
  const currentFeaturesUnavailable = !expectedVersionId
    && typeof context.loadDatasetFeatures !== "function";
  if (exactPreviewUnavailable || currentFeaturesUnavailable) {
    setStatus(context, `${dataset.title} is attached, but its governed feature preview is unavailable in this deployment.`);
    return;
  }
  button.disabled = true;
  setStatus(
    context,
    expectedVersionId
      ? `Loading exact dataset v${dataset.currentVersionNumber} for ${dataset.title}…`
      : liveCollection ? `Loading the existing editable collection for ${dataset.title}…`
        : `Loading a bounded preview of ${dataset.title}…`
  );
  try {
    let geojson;
    let count;
    let geometryType = dataset.geometryType ?? "Point";
    let layer;
    if (expectedVersionId) {
      const preview = await context.loadDatasetVersionPreview(dataset.datasetId, expectedVersionId, dataset.geometryType);
      if (preview.datasetVersionId !== expectedVersionId) {
        setStatus(context, `${dataset.title} returned a different dataset version and was not added.`);
        return;
      }
      if (preview.mayBeTruncated) {
        setStatus(context, `${dataset.title} has more features than its bounded exact-version preview. It was not added as an incomplete layer.`);
        return;
      }
      geojson = preview.geojson;
      count = preview.numberReturned;
      layer = layerFromGovernedDataset(dataset, geometryType, expectedVersionId);
    } else {
      const page = await context.loadDatasetFeatures(dataset.datasetId);
      if (page.numberMatched > page.numberReturned) {
        setStatus(context, `${dataset.title} has ${page.numberMatched} features. This map preview is limited to 100 and will not display an incomplete layer.`);
        return;
      }
      geometryType = page.collection.geometryType ?? geometryType;
      layer = layerFromGovernedDataset(dataset, geometryType);
      layer.featureGeneration = page.collection.generation;
      layer.featureFields = page.collection.fields;
      geojson = {type: "FeatureCollection", features: page.features};
      count = page.numberReturned;
    }
    if (context.disposed) return;
    if (hasGovernedDatasetLayer(context.layers, dataset.datasetId, expectedVersionId)) {
      setStatus(context, `${dataset.title} ${expectedVersionId ? "exact saved version" : "editable collection"} is already in this map.`);
      return;
    }
    context.addLayer(
      layer,
      geojson
    );
    setStatus(context, `${dataset.title} added from ${count} governed features${expectedVersionId ? ` at exact dataset v${dataset.currentVersionNumber}` : ""}. Save the map to persist its independent presentation.`);
  } catch (error) {
    setStatus(context, liveCollection && (error?.status === 404 || error?.code === "feature_collection_not_found")
      ? `${dataset.title} has no available editable feature collection. Use its exact saved version instead; no collection was created.`
      : `The governed feature preview is unavailable (${error?.code ?? "unexpected_error"}).`);
  } finally {
    button.disabled = false;
  }
}

function layerFromGovernedDataset(dataset, geometryType, datasetVersionId = null) {
  const style = geometryType.includes("Point")
    ? {circleColor: "#f97316", circleRadius: 6}
    : geometryType.includes("Polygon")
      ? {fill: "#22c55e", stroke: "#15803d", strokeWidth: 2}
      : {stroke: "#2563eb", strokeWidth: 3};
  return {
    layerId: `dataset_${dataset.datasetId}_${datasetVersionId ? `version_${datasetVersionId}` : "live"}`,
    datasetId: dataset.datasetId,
    title: `${dataset.title} · ${datasetVersionId ? `saved v${dataset.currentVersionNumber}` : "authoritative features"}`,
    sourceType: "governed-dataset",
    sourceVersion: dataset.currentVersionNumber,
    ...(datasetVersionId ? {datasetVersionId} : {}),
    geometryType,
    bbox: dataset.bbox,
    visible: true,
    opacity: 0.9,
    order: 800,
    style,
    labels: {enabled: false, field: null}
  };
}

async function loadPersistedDatasetLayers(context) {
  for (const layer of [...context.layers]) {
    if (context.disposed) return;
    // Opening an all-off map must not read archived or managed data.
    if (layer.visible === false || context.layerArchiveModes.has(layer.layerId) || layer.managedDisplayId) continue;
    if (context.dataByLayerId.has(layer.layerId)
      || context.loadingDatasetLayerIds.has(layer.layerId)) continue;
    const sourceIdentity = persistedLayerSourceIdentity(layer);
    if (layer.sourceType === "external-feature-reference") {
      if (layer.visible !== false && context.state.map?.isStyleLoaded?.()) {
        void loadLiveExternalFeatureLayer(context, layer, {announce: false});
      }
      continue;
    }
    if (layer.sourceType === "geojson-archive") {
      context.loadingDatasetLayerIds.add(layer.layerId);
      context.render();
      try {
        // Sharing is safe only when the complete governed contract matches.
        // A checksum-only key could let a conflicting feature-count, geometry,
        // or rights contract reuse a load that it never validated itself.
        const key = `${layer.sourceUrl}#${JSON.stringify(layer.sourceConfiguration ?? null)}`;
        let load = context.archivedGeojsonLoads.get(key);
        if (!load) {
          load = loadArchivedGeojson({
            url: layer.sourceUrl,
            configuration: layer.sourceConfiguration
          });
          context.archivedGeojsonLoads.set(key, load);
          load.catch(() => context.archivedGeojsonLoads.delete(key));
        }
        const geojson = await load;
        if (!isCurrentPersistedLayer(context, layer, sourceIdentity)) continue;
        context.dataByLayerId.set(layer.layerId, geojson);
        installCachedDatasetLayers(context);
        if (isCurrentPersistedLayer(context, layer, sourceIdentity) && context.state.activeLayerId === layer.layerId) {
          setStatus(context, `${layer.title} verified and loaded from its immutable archive.`);
        }
      } catch (error) {
        if (isCurrentPersistedLayer(context, layer, sourceIdentity) && context.state.activeLayerId === layer.layerId) {
          setStatus(context, `${layer.title} remains in the project, but its archive did not pass verification (${error?.code ?? "archive_unavailable"}).`);
        }
      } finally {
        context.loadingDatasetLayerIds.delete(layer.layerId);
        if (!context.disposed) context.render();
      }
      continue;
    }
    if (layer.sourceType !== "governed-dataset") continue;
    if (isPreservedDatasetLayer(context, layer)) {
      context.failedDatasetLayerIds.add(layer.layerId);
      setStatus(context, `${layer.title} has a preserved original without a raw map preview. Choose an admitted tiled display under Map display.`);
      continue;
    }
    const exactVersion = layer.datasetVersionId ?? null;
    if (exactVersion && typeof context.loadDatasetVersionPreview !== "function") continue;
    if (!exactVersion && typeof context.loadDatasetFeatures !== "function") continue;
    context.loadingDatasetLayerIds.add(layer.layerId);
    context.failedDatasetLayerIds.delete(layer.layerId);
    context.render();
    try {
      let geojson;
      if (exactVersion) {
        const preview = await context.loadDatasetVersionPreview(layer.datasetId, exactVersion, layer.geometryType);
        if (preview.datasetVersionId !== exactVersion || preview.mayBeTruncated) throw Error("Incomplete map data");
        geojson = preview.geojson;
      } else {
        const page = await context.loadDatasetFeatures(layer.datasetId);
        if (page.numberMatched > page.numberReturned) throw Error("Incomplete map data");
        if (!isCurrentPersistedLayer(context, layer, sourceIdentity)) continue;
        layer.featureGeneration = page.collection.generation;
        layer.featureFields = page.collection.fields;
        geojson = {type: "FeatureCollection", features: page.features};
      }
      if (!isCurrentPersistedLayer(context, layer, sourceIdentity)) continue;
      context.dataByLayerId.set(layer.layerId, geojson);
      installCachedDatasetLayers(context);
    } catch {
      if (isCurrentPersistedLayer(context, layer, sourceIdentity)) {
        context.failedDatasetLayerIds.add(layer.layerId);
        setStatus(context, `${layer.title} could not load completely. Turn it off and on to retry, or open its catalog record.`);
      }
    } finally {
      context.loadingDatasetLayerIds.delete(layer.layerId);
      if (!context.disposed) context.render();
    }
  }
}

function installCachedDatasetLayers(context) {
  if (context.disposed || context.installingCachedDatasetLayers) return;
  context.installingCachedDatasetLayers = true;
  try {
    installLoadedMapLayers({
      getMap: () => context.disposed ? null : context.state.map,
      layers: context.layers,
      dataByLayerId: context.dataByLayerId,
      layerHandles: context.state.layerHandles,
      install: (layer, geojson) => addMapLayer(context.state, layer, geojson, context.datasets),
      syncOrder: () => syncLayerOrder(context)
    });
  } finally {
    context.installingCachedDatasetLayers = false;
    signalPublicationMapReadiness(context);
  }
}

function signalPublicationMapReadiness(context) {
  if (!context.onPublicationMapExport || context.disposed) return;
  context.shell.dispatchEvent(new context.shell.ownerDocument.defaultView.Event("publication-map:readiness", {bubbles: true}));
}

function xyzForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "OSM tile layer");
  const url = textInput("Tile URL", "https://tiles.example.org/{z}/{x}/{y}.png");
  form.append(title.wrapper, url.wrapper, externalSourceRegistrationButton(context, "xyz", "Register XYZ source", () => {
    void registerExternalSource(context, {
      name: title.input.value || "XYZ layer",
      source: {
        type: "xyz",
        url: url.input.value,
        minZoom: 0,
        maxZoom: 22,
        tileSize: 256,
        scheme: "xyz",
        attribution: null
      }
    });
  }));
  return form;
}

function mapServerForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "ArcGIS map imagery");
  const url = textInput("MapServer endpoint", "https://maps.example.org/arcgis/rest/services/Map/MapServer");
  const layers = textInput("Layer IDs", "0");
  const attribution = textInput("Attribution", "");
  const register = externalSourceRegistrationButton(context, "mapserver", "Register map imagery", () => {
    const layerIds = layers.input.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    void registerExternalSource(context, {name: title.input.value || "ArcGIS map imagery",
      source: {type: "mapserver", url: url.input.value, layerIds, attribution: attribution.input.value.trim() || null}});
  });
  form.append(title.wrapper, url.wrapper, layers.wrapper, attribution.wrapper,
    textElement("p", "Display selected layers from the live server. This does not download original raster files or switch to an archive if the server fails."), register);
  return form;
}

function imageServerForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "ImageServer imagery");
  const url = textInput("ImageServer endpoint", "https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer");
  const bands = textInput("Display bands (zero-based, optional)", "");
  const records = textInput("Image record IDs (optional)", "");
  const attribution = textInput("Attribution", "");
  const notice = textElement("p", "Use the service URL ending in ImageServer. This registers a live display layer and its metadata link, not an archive. Leave image record IDs blank for the provider default, or choose specific records. Leave bands blank for the provider default, or enter one or three band numbers. Display PNGs are not analytical raster values.");
  const register = externalSourceRegistrationButton(context, "imageserver", "Register ImageServer source", () => {
    const bandIds = bands.input.value.trim() ? bands.input.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [];
    const rasterIds = records.input.value.trim() ? records.input.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [];
    void registerExternalSource(context, {
      name: title.input.value || "ImageServer imagery",
      source: {type: "imageserver", url: url.input.value, bandIds,
        ...(rasterIds.length ? {rasterIds} : {}), attribution: attribution.input.value.trim() || null}
    });
  });
  form.append(title.wrapper, url.wrapper, records.wrapper, bands.wrapper, attribution.wrapper, notice, register);
  return form;
}

function wmsForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "WMS layer");
  const url = textInput("WMS endpoint", "https://maps.example.org/geoserver/wms");
  const layers = textInput("Layer names", "workspace:layer");
  const style = textInput("Style (optional)", "");
  const custody = document.createElement("div");
  custody.className = "gis-callout";
  custody.append(
    textElement("strong", context.publicDemo ? "Live provider reference" : "Live source and protected copy"),
    textElement("span", context.publicDemo ? "Review the supplied connection settings before adding this Layer. Tiles load from the provider; no archive or protected copy is created." : "This form saves the exact live WMS revision. The protected-copy prompt will activate with the isolated copy service so a backup is never reported as queued before a durable request exists.")
  );
  const register = externalSourceRegistrationButton(context, "wms", "Register WMS source", () => {
    const layerNames = layers.input.value.split(",").map((value) => value.trim()).filter(Boolean);
    const styles = style.input.value.trim() ? [style.input.value.trim()] : [];
    void registerExternalSource(context, {
      name: title.input.value || "WMS layer",
      source: {
        type: "wms",
        url: url.input.value,
        version: "1.3.0",
        layers: layerNames,
        styles,
        imageFormat: "image/png",
        transparent: true,
        crs: "EPSG:3857",
        tileSize: 256,
        attribution: null
      }
    }, {offerProtectedCopy: true, returnFocusKey: "register-wms"});
  });
  register.dataset.preservationReturnFocus = "register-wms";
  form.append(title.wrapper, url.wrapper, layers.wrapper, style.wrapper, custody, register);
  return form;
}

function discoverableFeatureForm(context, sourceType) {
  const container = document.createElement("div");
  container.className = "gis-form-grid gis-source-discovery";
  const draft = context.state.sourceDiscoveryDrafts[sourceType];
  const sourceLabel = sourceType === "arcgis" ? "ArcGIS" : "WFS 2.0";
  const endpoint = textInput(`${sourceLabel} service URL`, draft.serviceUrl);
  endpoint.input.addEventListener("input", () => {
    if (draft.serviceUrl !== endpoint.input.value) {
      draft.catalog = null;
      draft.inspection = null;
      draft.selectedRef = null;
      draft.pending = null;
    }
    draft.serviceUrl = endpoint.input.value;
  });
  const introduction = document.createElement("div");
  introduction.className = "gis-callout";
  introduction.append(
    textElement("strong", `Find layers from a ${sourceLabel} service`),
    textElement(
      "span",
      "Enter the service endpoint once. OpenGeo Studio inspects it through the isolated on-demand worker, then lets you choose and review one layer before anything is saved."
    )
  );
  const discover = actionButton(
    context.state.sourceDiscoveryPending ? "Inspecting service…" : "Find available layers",
    () => {
      void runSourceDiscovery(context, sourceType, "catalog", endpoint.input.value, null);
    }
  );
  discover.disabled = context.state.sourceDiscoveryPending
    || discoveryIsActive(draft.pending?.job)
    || typeof context.startSourceDiscovery !== "function";
  discover.setAttribute("aria-busy", context.state.sourceDiscoveryPending ? "true" : "false");
  container.append(introduction, endpoint.wrapper, discover);

  if (typeof context.startSourceDiscovery !== "function") {
    container.append(textElement(
      "p",
      "Automated service inspection is not available in this deployment. You can still enter one already reviewed layer below."
    ));
  }
  if (discoveryIsActive(draft.pending?.job)) {
    const pending = document.createElement("div");
    pending.className = "gis-callout";
    pending.append(
      textElement("strong", "Source inspection is still running"),
      textElement(
        "span",
        "The durable job remains available while request-driven capacity starts. Check the same job instead of creating a duplicate request."
      ),
      actionButton("Check inspection status", () => {
        void resumeSourceDiscovery(context, sourceType);
      })
    );
    container.append(pending);
  }
  if (draft.catalog?.result) container.append(sourceDiscoveryCollectionList(context, sourceType));
  if (draft.inspection?.result) container.append(discoveredSourceRegistration(context, sourceType));

  const manual = document.createElement("details");
  manual.className = "gis-source-manual-registration";
  manual.append(textElement("summary", "Enter an already reviewed layer manually"));
  manual.append(sourceType === "arcgis" ? arcgisFeatureForm(context) : wfsFeatureForm(context));
  container.append(manual);
  return container;
}

function sourceDiscoveryCollectionList(context, sourceType) {
  const draft = context.state.sourceDiscoveryDrafts[sourceType];
  const section = editorSection(
    "Available layers",
    `${draft.catalog.result.collections.length} bounded result${draft.catalog.result.collections.length === 1 ? "" : "s"}. Choose one to inspect fields, geometry, and paging support.`
  );
  const list = document.createElement("div");
  list.className = "gis-project-dataset-choices gis-source-discovery-collections";
  for (const collection of draft.catalog.result.collections) {
    const record = document.createElement("article");
    record.className = "gis-project-dataset-choice";
    const identity = document.createElement("div");
    identity.append(
      textElement("strong", collection.title),
      textElement(
        "small",
        [collection.ref, collection.geometryType, collection.bounds ? "extent reported" : null]
          .filter(Boolean)
          .join(" · ")
      )
    );
    const inspect = actionButton(
      draft.selectedRef === collection.ref && context.state.sourceDiscoveryPending
        ? "Inspecting…"
        : "Inspect layer",
      () => {
        draft.selectedRef = collection.ref;
        draft.inspection = null;
        void runSourceDiscovery(
          context,
          sourceType,
          "collection",
          draft.serviceUrl,
          collection.ref
        );
      }
    );
    inspect.disabled = context.state.sourceDiscoveryPending
      || discoveryIsActive(draft.pending?.job);
    record.append(identity, inspect);
    list.append(record);
  }
  section.append(list);
  return section;
}

function discoveredSourceRegistration(context, sourceType) {
  const draft = context.state.sourceDiscoveryDrafts[sourceType];
  const inspection = draft.inspection.result;
  const definition = inspection.sourceDefinition;
  const collection = inspection.collections[0];
  const section = editorSection(
    `Review ${collection.title}`,
    "Confirm the selected fields, stable identity/order, rights, and attribution. Registration creates a reusable Layer source revision and links retained discovery metadata for users with Layer access. Responses up to 32 KiB are retained exactly by supporting workers; larger or older responses have explicit availability limits. Backup remains a separate choice."
  );
  const title = textInput("Layer title", collection.title);
  const fields = textInput(
    "Fields · comma separated",
    Array.isArray(definition.fields) ? definition.fields.join(",") : ""
  );
  const attribution = textInput("Required attribution", "");
  const rights = textInput("Rights or terms reviewed", "");
  const sortBy = sourceType === "wfs"
    ? textInput("Confirmed stable sort field", definition.sort_by ?? "")
    : null;
  const confirmation = document.createElement("label");
  confirmation.className = "gis-check";
  const confirmed = document.createElement("input");
  confirmed.type = "checkbox";
  confirmation.append(
    confirmed,
    textElement("span", "I reviewed the source terms, attribution, fields, and stable paging identity.")
  );
  const limitations = document.createElement("ul");
  for (const limitation of inspection.limitations) {
    limitations.append(textElement("li", limitation));
  }
  const register = externalSourceRegistrationButton(
    context,
    sourceType,
    `Register ${sourceType === "arcgis" ? "ArcGIS" : "WFS"} layer`,
    () => {
      if (!confirmed.checked || !attribution.input.value.trim() || !rights.input.value.trim()) {
        setStatus(context, "Review and confirm source terms, attribution, fields, and stable paging before registration.");
        return;
      }
      const selectedFields = commaSeparatedFields(fields.input.value);
      const source = sourceType === "arcgis"
        ? {
            type: "arcgis",
            url: definition.url,
            objectIdField: definition.object_id_field,
            fields: selectedFields,
            geometryType: definition.geometry_type,
            pageSize: definition.page_size,
            attribution: attribution.input.value.trim()
          }
        : {
            type: "wfs",
            url: definition.url,
            version: definition.version,
            typeName: definition.type_name,
            geometryName: definition.geometry_name,
            fields: selectedFields,
            sortBy: sortBy.input.value.trim(),
            geometryType: definition.geometry_type,
            pageSize: definition.page_size,
            attribution: attribution.input.value.trim()
          };
      void registerExternalSource(
        context,
        {
          name: title.input.value || collection.title,
          discoveryJobId: draft.inspection.jobId,
          description: rights.input.value.trim(),
          source
        },
        {offerProtectedCopy: true, returnFocusKey: `register-${sourceType}`}
      );
    }
  );
  section.append(
    title.wrapper,
    fields.wrapper,
    ...(sortBy ? [sortBy.wrapper] : []),
    attribution.wrapper,
    rights.wrapper,
    confirmation,
    limitations,
    register
  );
  return section;
}

async function runSourceDiscovery(context, sourceType, kind, serviceUrl, collectionRef) {
  if (typeof context.startSourceDiscovery !== "function"
    || typeof context.getSourceDiscovery !== "function"
    || context.state.sourceDiscoveryPending) return;
  const draft = context.state.sourceDiscoveryDrafts[sourceType];
  draft.serviceUrl = serviceUrl.trim();
  draft.pending = null;
  context.state.sourceDiscoveryPending = true;
  setStatus(context, kind === "catalog" ? "Inspecting available source layers…" : "Inspecting selected layer schema…");
  context.render();
  try {
    let job = await context.startSourceDiscovery({
      sourceType,
      kind,
      serviceUrl: draft.serviceUrl,
      collectionRef,
      idempotencyKey: crypto.randomUUID()
    });
    draft.pending = {job, kind, collectionRef};
    for (let attempt = 0;
      ["queued", "running"].includes(job.state)
        && attempt < context.sourceDiscoveryPollAttempts;
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, context.sourceDiscoveryPollIntervalMs));
      job = await context.getSourceDiscovery(job.jobId);
      draft.pending.job = job;
    }
    if (discoveryIsActive(job)) {
      setStatus(context, "Source inspection is still running. Check the same durable job again in a moment.");
      return;
    }
    if (job.state !== "completed") {
      draft.pending = null;
      throw Object.assign(new Error("source_discovery_incomplete"), {
        code: job.errorCode ?? `source_discovery_${job.state}`
      });
    }
    applySourceDiscoveryResult(context, draft, kind, job);
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Source inspection failed safely (${error?.code ?? "source_discovery_unavailable"}).${request}`);
  } finally {
    context.state.sourceDiscoveryPending = false;
    context.render();
  }
}

async function resumeSourceDiscovery(context, sourceType) {
  const draft = context.state.sourceDiscoveryDrafts[sourceType];
  const pending = draft.pending;
  if (!discoveryIsActive(pending?.job)
    || typeof context.getSourceDiscovery !== "function"
    || context.state.sourceDiscoveryPending) return;
  context.state.sourceDiscoveryPending = true;
  setStatus(context, "Checking source inspection status…");
  context.render();
  try {
    const job = await context.getSourceDiscovery(pending.job.jobId);
    draft.pending.job = job;
    if (discoveryIsActive(job)) {
      setStatus(context, "Source inspection is still running. The same durable job remains available.");
      return;
    }
    if (job.state !== "completed") {
      draft.pending = null;
      throw Object.assign(new Error("source_discovery_incomplete"), {
        code: job.errorCode ?? `source_discovery_${job.state}`
      });
    }
    applySourceDiscoveryResult(context, draft, pending.kind, job);
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Source inspection failed safely (${error?.code ?? "source_discovery_unavailable"}).${request}`);
  } finally {
    context.state.sourceDiscoveryPending = false;
    context.render();
  }
}

function discoveryIsActive(job) {
  return ["queued", "running"].includes(job?.state);
}

function applySourceDiscoveryResult(context, draft, kind, job) {
  draft.pending = null;
  if (kind === "catalog") {
    draft.catalog = job;
    draft.inspection = null;
    draft.selectedRef = null;
    setStatus(context, `${job.result.collections.length} source layer${job.result.collections.length === 1 ? "" : "s"} found. Choose one to inspect.`);
    return;
  }
  draft.inspection = job;
  setStatus(context, `${job.result.collections[0].title} inspected. Review fields, rights, and attribution before registration.`);
}

function arcgisFeatureForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "ArcGIS feature layer");
  const url = textInput(
    "ArcGIS layer URL",
    "https://services.example.org/arcgis/rest/services/example/FeatureServer/0"
  );
  const objectId = textInput("Object ID field", "OBJECTID");
  const fields = textInput("Fields · comma separated", "OBJECTID,name");
  const geometry = selectInput("Geometry", "Polygon", [
    ["Point", "Point"],
    ["MultiPoint", "MultiPoint"],
    ["LineString", "LineString"],
    ["MultiLineString", "MultiLineString"],
    ["Polygon", "Polygon"],
    ["MultiPolygon", "MultiPolygon"]
  ]);
  const pageSize = textInput("Page size · 1–2000", "1000");
  const attribution = textInput("Attribution", "Source agency");
  const limits = document.createElement("div");
  limits.className = "gis-callout";
  limits.append(
    textElement("strong", "Known layer registration"),
    textElement("span", "Enter one exact, query-free FeatureServer or MapServer layer URL and its reviewed field identity. A protected copy is limited to the visible WGS84 extent, 50,000 features, and 64 requests.")
  );
  const register = externalSourceRegistrationButton(context, "arcgis", "Register ArcGIS feature source", () => {
    void registerExternalSource(context, {
      name: title.input.value || "ArcGIS feature layer",
      source: {
        type: "arcgis",
        url: url.input.value,
        objectIdField: objectId.input.value,
        fields: commaSeparatedFields(fields.input.value),
        geometryType: geometry.input.value,
        pageSize: Number(pageSize.input.value),
        attribution: attribution.input.value || null
      }
    }, {offerProtectedCopy: true, returnFocusKey: "register-arcgis"});
  });
  register.dataset.preservationReturnFocus = "register-arcgis";
  form.append(
    title.wrapper,
    url.wrapper,
    objectId.wrapper,
    fields.wrapper,
    geometry.wrapper,
    pageSize.wrapper,
    attribution.wrapper,
    limits,
    register
  );
  return form;
}

function wfsFeatureForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "WFS feature layer");
  const url = textInput("WFS endpoint", "https://maps.example.org/geoserver/wfs");
  const typeName = textInput("Feature type name", "workspace:layer");
  const geometryName = textInput("Geometry property", "geom");
  const fields = textInput("Attribute fields · comma separated", "id,name");
  const sortBy = textInput("Stable sort field", "id");
  const geometry = selectInput("Geometry", "Polygon", [
    ["Point", "Point"],
    ["MultiPoint", "MultiPoint"],
    ["LineString", "LineString"],
    ["MultiLineString", "MultiLineString"],
    ["Polygon", "Polygon"],
    ["MultiPolygon", "MultiPolygon"]
  ]);
  const pageSize = textInput("Page size · 1–1000", "1000");
  const attribution = textInput("Attribution", "Source agency");
  const limits = document.createElement("div");
  limits.className = "gis-callout";
  limits.append(
    textElement("strong", "Known collection registration"),
    textElement("span", "Enter one reviewed WFS 2.0 collection and a stable sort field. The geometry property stays separate from the selected attributes. Protected copies use bounded GeoJSON extraction.")
  );
  const register = externalSourceRegistrationButton(context, "wfs", "Register WFS feature source", () => {
    void registerExternalSource(context, {
      name: title.input.value || "WFS feature layer",
      source: {
        type: "wfs",
        url: url.input.value,
        version: "2.0.0",
        typeName: typeName.input.value,
        geometryName: geometryName.input.value,
        fields: commaSeparatedFields(fields.input.value),
        sortBy: sortBy.input.value,
        geometryType: geometry.input.value,
        pageSize: Number(pageSize.input.value),
        attribution: attribution.input.value || null
      }
    }, {offerProtectedCopy: true, returnFocusKey: "register-wfs"});
  });
  register.dataset.preservationReturnFocus = "register-wfs";
  form.append(
    title.wrapper,
    url.wrapper,
    typeName.wrapper,
    geometryName.wrapper,
    fields.wrapper,
    sortBy.wrapper,
    geometry.wrapper,
    pageSize.wrapper,
    attribution.wrapper,
    limits,
    register
  );
  return form;
}

function commaSeparatedFields(value) {
  return value.split(",").map((field) => field.trim()).filter(Boolean);
}

async function registerExternalSource(
  context,
  metadata,
  {offerProtectedCopy = false, returnFocusKey = null} = {}
) {
  if (typeof context.registerSource !== "function") {
    setStatus(context, "A persistent project connection is required to register this source.");
    return;
  }
  if (context.state.sourceRegistrationPending !== null) return;
  const reviewBrowserLayer = browserLayerReviewForProject(context);
  context.state.sourceRegistrationPending = metadata.source.type;
  setStatus(context, `Registering ${metadata.source.type.toUpperCase()} source…`);
  if (!context.publicDemo) context.render();
  try {
    const source = await context.registerSource({
      ...metadata,
      description: metadata.description ?? null,
      classification: "internal",
      tags: [...new Set([metadata.source.type, "external-source", ...(metadata.tags ?? [])])]
    });
    if (context.publicDemo) {
      const layer = {...layerFromExternalSource(source), governedSource: false, fixtureSource: true};
      reviewBrowserLayer({layer, geojson: null, source: {
        url: source.sourceUrl, format: source.sourceType, description: metadata.description ?? null,
        attribution: source.configuration.attribution ?? null,
        configuration: structuredClone(source.configuration), custody: "referenced",
        metadataMethod: "user-supplied connection settings; provider metadata not inspected"
      }, onAdd: async reviewed => {
        reviewed.attribution = reviewed.metadata.curated.attribution;
        context.sources.push(source);
        context.addLayer(reviewed, null);
        rememberBrowserLayer(context, {layer: reviewed, geojson: null});
        fitLayer(context.state.map, reviewed, context.dataByLayerId);
        setStatus(context, `${reviewed.title} added as a provider reference. Source information stays in this browser draft.`);
      }});
      return;
    }
    context.sources.push(source);
    context.addLayer(layerFromExternalSource(source), null);
    if (offerProtectedCopy
      && typeof context.estimateProtectedCopy === "function"
      && typeof context.requestProtectedCopy === "function") {
      openPreservationDialog(context, source, returnFocusKey);
      return;
    }
    setStatus(context, context.publicDemo
      ? `${source.name} added to this browser-only demo. It was not uploaded or published.`
      : `${source.name} registered as governed source revision ${source.versionNumber}. Save the map to persist this layer.`);
  } catch (error) {
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Source registration failed (${error?.code ?? "invalid_source"}).${request}`);
  } finally {
    context.state.sourceRegistrationPending = null;
    if (!context.publicDemo) context.render();
  }
}

function externalSourceRegistrationButton(context, sourceType, label, onClick) {
  const pendingSource = context.state.sourceRegistrationPending;
  const button = actionButton(
    pendingSource === sourceType ? `Registering ${sourceType.toUpperCase()} source…` : label,
    onClick
  );
  button.disabled = pendingSource !== null;
  button.setAttribute("aria-busy", pendingSource === sourceType ? "true" : "false");
  return button;
}

function layerFromExternalSource(source) {
  const configuration = source.configuration;
  const tileUrl = source.sourceType === "wms"
    ? wmsTileUrl(source.sourceUrl, configuration)
    : source.sourceType === "mapserver" ? mapServerTileUrl(source.sourceUrl, configuration)
    : source.sourceType === "imageserver" ? imageServerTileUrl(source.sourceUrl, configuration)
    : ["xyz", "pmtiles"].includes(source.sourceType) ? source.sourceUrl : undefined;
  const sourceType = source.sourceType === "pmtiles"
    ? `pmtiles-${configuration.tileType}`
    : source.sourceType === "geojson"
    ? "geojson-archive"
    : ["arcgis", "wfs"].includes(source.sourceType)
    ? "external-feature-reference"
    : `${source.sourceType}-raster`;
  return {
    layerId: `source_${source.datasetId}`,
    datasetId: source.datasetId,
    title: source.name,
    sourceType,
    sourceVersion: source.versionNumber,
    sourceUrl: source.sourceUrl,
    sourceConfiguration: structuredClone(configuration),
    tileUrl,
    tileSize: configuration.tileSize,
    scheme: configuration.scheme,
    attribution: configuration.attribution,
    minZoom: configuration.minZoom,
    maxZoom: configuration.maxZoom,
    sourceLayer: configuration.sourceLayer,
    governedSource: true,
    geometryType: configuration.geometryType ?? "Raster",
    bbox: configuration.bounds,
    visible: true,
    opacity: 0.9,
    order: 800,
    style: {},
    labels: {enabled: false, field: null}
  };
}

function externalFeatureSourceType(layer) {
  if (layer?.sourceType !== "external-feature-reference") return null;
  const configuration = layer.sourceConfiguration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return null;
  if (Object.hasOwn(configuration, "objectIdField")) return "arcgis";
  if (Object.hasOwn(configuration, "typeName")) return "wfs";
  return null;
}

function liveFeatureLayerStatus(layer) {
  if (layer?.sourceType !== "external-feature-reference") return null;
  if (layer.liveFeatureState === "loading") return "loading current view";
  const receipt = layer.liveFeaturePage;
  if (layer.liveFeatureState === "error") {
    return receipt ? `${receipt.numberReturned} in previous view · refresh failed` : "live view unavailable";
  }
  if (!receipt) return "live reference";
  return `${receipt.numberReturned} in loaded view${receipt.mayBeTruncated ? " · page limited" : ""}`;
}

async function loadLiveExternalFeatureLayer(context, layer, {force = false, announce = true} = {}) {
  const sourceType = externalFeatureSourceType(layer);
  if (!sourceType || !layer.sourceUrl || layer.visible === false || !context.state.map
    || context.layerArchiveModes.has(layer.layerId)) return;
  const existing = context.liveFeatureRequests.get(layer.layerId);
  if (existing && !force) return existing.promise;
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  const request = {controller, promise: null};
  context.liveFeatureRequests.set(layer.layerId, request);
  layer.liveFeatureState = "loading";
  layer.liveFeatureError = null;
  if (announce) setStatus(context, `Loading ${layer.title} for the current map view…`);
  context.render();

  request.promise = scheduleLiveFeatureRequest(context, async () => {
    if (controller.signal.aborted) return null;
    return loadLiveFeaturePage({
      sourceType,
      url: layer.sourceUrl,
      configuration: layer.sourceConfiguration,
      bounds: authoringMapExtent(context),
      signal: controller.signal
    });
  }).then((geojson) => {
    if (!geojson || context.liveFeatureRequests.get(layer.layerId) !== request) return null;
    context.dataByLayerId.set(layer.layerId, geojson);
    layer.liveFeaturePage = geojson.opengeo;
    layer.liveFeatureState = "ready";
    layer.liveFeatureError = null;
    const map = context.state.map;
    const source = map?.getSource?.(sourceId(layer));
    if (source?.setData) source.setData(geojson);
    else if (map?.isStyleLoaded?.()) addMapLayer(context.state, layer, geojson, context.datasets);
    syncLayerOrder(context);
    if (announce) {
      const limited = geojson.opengeo.mayBeTruncated
        ? " The provider may have more matching features; this remains a bounded display page."
        : "";
      setStatus(context, `${layer.title}: ${geojson.opengeo.numberReturned} features loaded for the current map view.${limited}`);
    }
    return geojson;
  }).catch((error) => {
    if (context.liveFeatureRequests.get(layer.layerId) !== request) return null;
    if (error?.code === "request_cancelled") return null;
    layer.liveFeatureState = "error";
    layer.liveFeatureError = error?.code ?? "source_unavailable";
    if (announce || context.state.activeLayerId === layer.layerId) {
      setStatus(context, layer.liveFeaturePage
        ? `${layer.title} could not refresh (${layer.liveFeatureError}); the previous bounded view remains displayed.`
        : `${layer.title} remains in the project, but its current-view page is unavailable (${layer.liveFeatureError}).`);
    }
    return null;
  }).finally(() => {
    if (context.liveFeatureRequests.get(layer.layerId) !== request) return;
    context.liveFeatureRequests.delete(layer.layerId);
    context.render();
  });
  return request.promise;
}

function scheduleLiveFeatureRequest(context, task) {
  return new Promise((resolve, reject) => {
    context.liveFeatureQueue.push({task, resolve, reject});
    drainLiveFeatureQueue(context);
  });
}

function drainLiveFeatureQueue(context) {
  while (context.liveFeatureActive < MAXIMUM_CONCURRENT_LIVE_FEATURE_REQUESTS && context.liveFeatureQueue.length) {
    const item = context.liveFeatureQueue.shift();
    context.liveFeatureActive += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        context.liveFeatureActive -= 1;
        drainLiveFeatureQueue(context);
      });
  }
}

function cancelLiveFeatureLayer(context, layer) {
  const request = context.liveFeatureRequests.get(layer?.layerId);
  if (!request) return;
  request.controller.abort();
  context.liveFeatureRequests.delete(layer.layerId);
  layer.liveFeatureState = context.dataByLayerId.has(layer.layerId) ? "ready" : null;
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

function pmtilesLayerForm(context) {
  const form = document.createElement("div");
  form.className = "gis-form-grid";
  const title = textInput("Layer title", "Public PMTiles layer");
  const url = textInput("PMTiles HTTPS URL", "https://data.example.org/layers/example.pmtiles");
  const tileType = selectInput("Tile type", "vector", [["Vector", "vector"], ["Raster", "raster"]]);
  const sourceLayer = textInput("Source layer", "default");
  const geometry = selectInput("Geometry", "Polygon", [["Point", "Point"], ["LineString", "LineString"], ["Polygon", "Polygon"]]);
  form.append(title.wrapper, url.wrapper, tileType.wrapper, sourceLayer.wrapper, geometry.wrapper, externalSourceRegistrationButton(context, "pmtiles", "Register PMTiles source", () => {
    const vector = tileType.input.value === "vector";
    void registerExternalSource(context, {
      name: title.input.value || "Public PMTiles layer",
      source: {
        type: "pmtiles",
        url: url.input.value,
        tileType: tileType.input.value,
        sourceLayer: vector ? sourceLayer.input.value : null,
        geometryType: vector ? geometry.input.value : null,
        minZoom: 0,
        maxZoom: 24,
        attribution: null
      }
    }, {offerProtectedCopy: true});
  }));
  return form;
}

function awsRegistrationForm(context, source) {
  const box = document.createElement("div");
  box.className = "gis-callout";
  if (context.publicDemo) {
    box.append(
      textElement("strong", "Browser-only demo"),
      textElement("span", "Choose a local GeoJSON or coordinate CSV above. Files stay in this browser and are never uploaded. Open authenticated Studio to persist managed data or database connections."),
      actionButton("Open Studio ↗", () => {
        location.href = MANAGED_STUDIO_URL;
      })
    );
    return box;
  }
  box.append(
    textElement("strong", "Managed ingestion"),
    textElement("span", `${source?.[1] ?? "Source"} files selected above use the same checksum-bound signed upload and verified processing contract as the project dataset uploader.`),
    actionButton("Go to dataset uploader", () => {
      revealProjectControl(".project-upload-form");
      setStatus(context, "Project records opened at the managed dataset uploader.");
    })
  );
  return box;
}

function nativeAnalysisPanel(context) {
  const {state} = context;
  const section = editorSection("Spatial analysis", "Preview a result before adding it to this map.");
  if (!context.previewVectorAnalysis || !context.getAnalysisCollection) {
    section.append(textElement("p", "Server analysis is available in Studio for stored vector layers. Browser tools remain available below."));
    return section;
  }
  const sources = context.layers.filter((layer) => layer.sourceType === "governed-dataset");
  if (!sources.length) {
    section.append(textElement("p", "Add a stored vector layer to use spatial analysis."));
    return section;
  }
  const draft = state.analysisPreviewDraft ??= {operation: "centroid", source: sources[0].layerId, target: sources[0].layerId, distance: "100"};
  const running = Boolean(state.analysisPreviewController);
  const controls = document.createElement("fieldset");
  controls.disabled = running || Boolean(state.analysisRegistrationSession);
  const choices = sources.map((layer) => [layer.layerId, layer.title]);
  const update = (key, value) => {draft[key] = value; state.analysisPreviewResult = null; context.render();};
  controls.append(
    selectField("Operation", draft.operation, [["centroid", "Centroid"], ["measure", "Measure area and length"], ["buffer", "Buffer"], ["clip", "Clip"], ["select-by-location", "Select by location"], ["dissolve", "Dissolve"], ["join-summary", "Spatial join (source summary)"], ["join", "Spatial join (matching pairs)"], ["intersection", "Intersection"]], (value) => update("operation", value)),
    selectField("Source layer", draft.source, choices, (value) => update("source", value))
  );
  if (["clip", "join", "intersection", "join-summary", "select-by-location"].includes(draft.operation)) {
    controls.append(selectField("Target layer", draft.target, choices, (value) => update("target", value)));
  }
  if (draft.operation === "buffer") controls.append(textField("Distance (meters, up to 100,000)", draft.distance, (value) => update("distance", value)));
  controls.append(actionButton("Preview analysis", () => {void runNativeAnalysisPreview(context);}));
  section.append(controls);
  if (running) section.append(actionButton("Cancel preview", () => {
    void cancelNativeAnalysisPreview(context);
  }));
  const status = textElement("p", state.analysisPreviewMessage ?? "Up to 1,000 features per input. Buffer distance is in meters. Measurement uses spheroidal square meters and meters; overlays and centroids use planar CRS84 geometry.");
  status.role = "status";
  status.setAttribute("aria-live", "polite");
  section.append(status);
  const result = state.analysisPreviewResult;
  if (result && !state.analysisPreviewAdded) section.append(actionButton("Add preview to map", () => {
    addProcessingOutputLayer(context, result.source, result.operation, result.collection, `${result.source.title} — ${result.operation} preview`);
    state.analysisPreviewAdded = true;
    state.analysisPreviewMessage = "Added a temporary result. It has not been registered as a catalog Layer.";
    context.render();
  }));
  if (result && context.createAnalysisRegistration && result.collection.features.length) {
    const review = state.analysisRegistrationReview ??= {title: `${result.source.title} ${result.operation}`.slice(0, 160), description: "", license: "", attribution: ""};
    const fields = document.createElement("fieldset");
    fields.disabled = Boolean(state.analysisRegistrationSession);
    for (const [key, label] of [["title", "Derived Layer title"], ["description", "Description"], ["license", "Distribution license (leave blank if unknown)"], ["attribution", "Attribution"]]) {
      fields.append(textField(label, review[key], value => {review[key] = value;}));
    }
    section.append(fields, textElement("p", "Saving creates a restricted catalog Layer with input lineage. Source licenses are not automatically inherited. Processing must finish before adding the saved Layer from the catalog."));
    if (!state.analysisRegistrationComplete) {
      const save = actionButton(state.analysisRegistrationSession ? "Resume Layer registration" : "Save as catalog Layer", () => {void saveNativeAnalysis(context);});
      save.disabled = Boolean(state.analysisRegistrationRunning);
      section.append(save);
    } else section.append(textElement("p", `Catalog Layer ${state.analysisRegistrationComplete.dataset.id} registered; version ${state.analysisRegistrationComplete.versionNumber} is queued for processing.`));
    if (state.analysisRegistrationComplete) section.append(actionButton("Start another analysis", () => {
      state.analysisRegistrationSession = null;
      state.analysisRegistrationComplete = null;
      state.analysisRegistrationReview = null;
      state.analysisPreviewResult = null;
      context.render();
    }));
  }
  return section;
}

async function saveNativeAnalysis(context) {
  const {state} = context;
  if (state.analysisRegistrationRunning || state.analysisRegistrationComplete) return;
  state.analysisRegistrationRunning = true;
  try {
    state.analysisRegistrationSession ??= context.createAnalysisRegistration({
      collection: state.analysisPreviewResult.collection,
      review: state.analysisRegistrationReview,
      assertCurrentScope: async () => {if (context.disposed) throw Error("The project view has changed.");},
      onStage: (_stage, message) => {state.analysisPreviewMessage = message; if (!context.disposed) context.render();}
    });
    context.render();
    state.analysisRegistrationComplete = await state.analysisRegistrationSession.run();
    state.analysisPreviewMessage = "Derived Layer and lineage registered. Processing is queued; catalog assignment to a map remains separate.";
  } catch (error) {
    state.analysisPreviewMessage = `${error.message || "Registration failed."} Any committed registration is retained; resume to continue it.`;
  } finally {
    state.analysisRegistrationRunning = false;
    if (!context.disposed) context.render();
  }
}

export async function runNativeAnalysisPreview(context) {
  const {state} = context;
  if (state.analysisPreviewController) return;
  const draft = {...state.analysisPreviewDraft};
  const source = context.layers.find((layer) => layer.layerId === draft.source && layer.sourceType === "governed-dataset");
  const target = context.layers.find((layer) => layer.layerId === draft.target && layer.sourceType === "governed-dataset");
  const paired = ["clip", "join", "intersection", "join-summary", "select-by-location"].includes(draft.operation);
  if (!source || (paired && !target)) {
    state.analysisPreviewMessage = "Select an available source and target layer.";
    context.render();
    return;
  }
  const controller = new AbortController();
  const options = {signal: controller.signal};
  state.analysisPreviewController = controller;
  const active = {controller, previewId: crypto.randomUUID(), datasetId: source.datasetId, submitted: false};
  state.analysisPreviewActive = active;
  state.analysisPreviewCancellation = null;
  state.analysisPreviewResult = null;
  state.analysisPreviewAdded = false;
  state.analysisRegistrationReview = null;
  state.analysisPreviewMessage = "Checking source versions…";
  context.render();
  try {
    const [sourceCollection, targetCollection] = await Promise.all([
      context.getAnalysisCollection(source.datasetId, options),
      paired ? context.getAnalysisCollection(target.datasetId, options) : null
    ]);
    if (controller.signal.aborted || context.disposed || state.analysisPreviewActive !== active) return;
    const request = {operation: draft.operation, source_generation: sourceCollection.generation, preview_id: active.previewId};
    if (paired) Object.assign(request, {target_dataset_id: target.datasetId, target_generation: targetCollection.generation});
    if (draft.operation === "buffer") {
      const distance = Number(draft.distance);
      if (!Number.isFinite(distance) || distance <= 0 || distance > 100_000) throw new Error("Enter a buffer distance greater than zero and at most 100,000 meters.");
      request.distance_meters = distance;
    }
    state.analysisPreviewMessage = "Computing preview…";
    context.render();
    active.submitted = true;
    const collection = await context.previewVectorAnalysis(source.datasetId, request, options);
    if (controller.signal.aborted || context.disposed || state.analysisPreviewActive !== active) return;
    state.analysisPreviewResult = {collection, source: {...source}, operation: draft.operation};
    state.analysisPreviewMessage = `${collection.features.length} result features ready. Nothing has been saved.`;
  } catch (error) {
    if (!controller.signal.aborted && !context.disposed && state.analysisPreviewActive === active) state.analysisPreviewMessage = error.message || "Analysis preview failed. Check the selected layers and try again.";
  } finally {
    if (state.analysisPreviewController === controller) state.analysisPreviewController = null;
    if (state.analysisPreviewActive === active) state.analysisPreviewActive = null;
    if (!context.disposed) context.render();
  }
}

export async function cancelNativeAnalysisPreview(context) {
  const {state} = context;
  const active = state.analysisPreviewActive;
  if (!active || state.analysisPreviewController !== active.controller) return;
  active.controller.abort();
  state.analysisPreviewController = null;
  state.analysisPreviewActive = null;
  state.analysisPreviewResult = null;
  const cancellation = {};
  state.analysisPreviewCancellation = cancellation;
  state.analysisPreviewMessage = "Preview cancelled. Server computation may continue until its five-second statement limit.";
  if (!active.submitted || !context.cancelVectorAnalysis || context.disposed) {
    if (!context.disposed) context.render();
    return;
  }
  state.analysisPreviewMessage = "Preview cancelled. Requesting server cancellation…";
  context.render();
  try {
    // The preview signal is already aborted. Give the deliberate cancel request
    // its own finite lifetime, and never poll or retry it automatically.
    const result = await context.cancelVectorAnalysis(active.datasetId, active.previewId, {signal: AbortSignal.timeout(5000)});
    if (context.disposed || state.analysisPreviewCancellation !== cancellation) return;
    state.analysisPreviewMessage = result.state === "cancellation_requested"
      ? "Preview cancelled. Server cancellation requested; calculation has a five-second statement limit."
      : "Preview cancelled. No active calculation was found; any pending calculation remains limited to five seconds.";
  } catch {
    if (context.disposed || state.analysisPreviewCancellation !== cancellation) return;
    state.analysisPreviewMessage = "Preview cancelled. Server cancellation could not be confirmed; calculation remains limited to five seconds.";
  }
  if (!context.disposed) context.render();
}

function processingPanel(context) {
  const {state} = context;
  const panel = panelShell();
  const metadata = ensureActiveManagedDatasetMetadata(context);
  if (metadata) {
    panel.append(textElement("p", metadata.error ?? "Loading the selected Layer's dataset metadata…"));
    if (metadata.error) panel.append(actionButton("Retry selected Layer metadata", () => {
      state.managedDatasetMetadataRequest = null;context.render();
    }));
  }
  panel.append(nativeAnalysisPanel(context));
  const tool = PROCESSING_TOOLS.find((candidate) => candidate.id === state.activeToolId) ?? PROCESSING_TOOLS[0];
  panel.dataset.processingRegistry = PROCESSING_REGISTRY_SCHEMA_VERSION;
  panel.dataset.processingTool = tool.id;
  panel.dataset.processingToolVersion = tool.version;
  panel.dataset.processingHistoryCount = `${state.processingHistory.length}`;

  panel.append(selectField("Tool", tool.id, PROCESSING_TOOLS.map((candidate) => [candidate.id, `${candidate.title} (${candidate.engine})`]), (id) => {
    state.activeToolId = id;
    context.render();
  }));
  panel.append(textElement(
    "p",
    `${tool.executionMode} · tool ${tool.version} · registry ${PROCESSING_REGISTRY_SCHEMA_VERSION}`
  ));
  if (tool.id === "vector-to-pmtiles") {
    panel.append(pmtilesDerivativeEditor(context));
  } else {
    panel.append(actionButton("Run", () => {
      runTool(context, state.activeToolId);
      context.render();
    }));
  }

  if (state.processingModels.length) {
    const selectedModel = state.processingModels.find(({id}) => id === state.activeProcessingModelId)
      ?? state.processingModels[0];
    panel.append(
      selectField(
        "Saved model",
        selectedModel.id,
        state.processingModels.map((model) => [model.id, model.name || model.id]),
        (id) => {
          state.activeProcessingModelId = id;
          context.render();
        }
      ),
      actionButton("Run saved model", () => {
        runProcessingModel(context, selectedModel);
        context.render();
      })
    );
  }

  const log = document.createElement("div");
  log.className = "gis-log";
  log.role = "status";
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-atomic", "false");
  for (const line of state.processingLog.slice(0, 10)) log.append(textElement("p", line));
  if (!state.processingLog.length) log.append(textElement("p", "No processing results yet."));
  const history = editorSection(
    "Project processing history",
    `${state.processingHistory.length} of ${BROWSER_PROCESSING_LIMITS.maximumHistoryEntries} portable receipts retained.`
  );
  for (const run of state.processingHistory.slice(-5).reverse()) {
    const row = textElement(
      "p",
      `${run.toolName ?? run.toolId} · ${run.status ?? "unknown"} · ${run.startedAt ?? "time unavailable"}`
    );
    row.dataset.processingRun = run.id;
    row.dataset.processingTool = run.toolId;
    row.dataset.processingStatus = run.status ?? "unknown";
    history.append(row);
  }
  panel.append(log, history, durableJobsSection(context));
  return panel;
}

function ensureActiveManagedDatasetMetadata(context) {
  const layer = activeLayer(context);
  const identity = layer ? persistedLayerSourceIdentity(layer) : null;
  let previous = context.state.managedDatasetMetadataRequest;
  if (previous && (previous.layer !== layer || previous.identity !== identity)) {
    previous.controller.abort();context.state.managedDatasetMetadataRequest = null;previous = null;
  }
  if (layer?.sourceType !== "governed-dataset" || !layer.datasetId
    || context.datasets.some(dataset => dataset.datasetId === layer.datasetId)
    || typeof context.loadManagedDatasetMetadata !== "function") return null;
  if (previous?.layer === layer && previous.identity === identity) return previous;
  previous?.controller.abort();
  const request = {layer, identity, controller: new AbortController(), error: null};
  context.state.managedDatasetMetadataRequest = request;
  void (async () => {
    try {
      const dataset = await context.loadManagedDatasetMetadata(layer.datasetId, request.controller.signal);
      request.controller.signal.throwIfAborted();
      if (context.disposed) return;
      if (activeLayer(context) !== layer || persistedLayerSourceIdentity(layer) !== identity) {
        if (context.state.managedDatasetMetadataRequest === request) context.state.managedDatasetMetadataRequest = null;
        return;
      }
      if (dataset.datasetId !== layer.datasetId) throw Error("The selected Layer's dataset metadata changed. Reopen the Project.");
      if (!context.datasets.some(item => item.datasetId === dataset.datasetId)) context.datasets.push(dataset);
      if (!context.allDatasets.some(item => item.datasetId === dataset.datasetId)) context.allDatasets.push(dataset);
      context.render();
      if (context.state.activePanel === "processing") await refreshDurableJobLists(context);
    } catch (error) {
      if (context.disposed || request.controller.signal.aborted || activeLayer(context) !== layer) return;
      request.error = "The selected Layer's dataset metadata is unavailable. Retry to review its processing options.";
      context.render();
    }
  })();
  return request;
}

function pmtilesDerivativeEditor(context) {
  const layer=activeLayer(context),dataset=context.datasets.find(({datasetId})=>datasetId===layer?.datasetId);
  const eligibility=pmtilesDerivativeEligibility(context,dataset,layer);
  const section=document.createElement('section');section.className='gis-editor-section gis-pmtiles-derivative-editor';
  section.dataset.pmtilesDerivativeEditor='true';section.tabIndex=-1;section.role='region';
  section.setAttribute('aria-busy',String(context.state.pmtilesDerivativeBusy));
  if(!eligibility.allowed){section.append(textElement('h3','Convert vector to PMTiles'),textElement('p',eligibility.message));return section;}
  const availability=workbenchPmtilesAvailability(context,dataset);
  const draft=pmtilesDerivativeDraft(context,dataset,layer);
  section.append(PmtilesConversionEditor({draft,versionLabel:dataset.currentVersion??dataset.currentVersionId,
    busy:context.state.pmtilesDerivativeBusy,jobs:context.pmtilesDerivativeJobs,availability,
    onSubmit:()=>void queuePmtilesDerivative(context,dataset,draft)}));
  if(!availability.allowed&&context.state.pmtilesCapabilitiesRequest?.value!==undefined)section.append(actionButton('Refresh converter metadata',()=>{
    context.state.pmtilesCapabilitiesRequest=null;context.render();
  }));
  const heading=section.querySelector('h3');heading.id='gis-pmtiles-derivative-title';section.setAttribute('aria-labelledby',heading.id);
  return section;
}

function workbenchPmtilesAvailability(context,dataset){
  if(typeof context.getPmtilesConversionCapabilities!=='function')return{allowed:true,message:''};
  let request=context.state.pmtilesCapabilitiesRequest;
  if(!request){
    request={value:undefined};context.state.pmtilesCapabilitiesRequest=request;
    void Promise.resolve().then(()=>context.getPmtilesConversionCapabilities()).then(value=>{request.value=value;},()=>{request.value=null;}).finally(()=>{
      if(!context.disposed)context.render();
    });
  }
  return pmtilesConversionAvailability(dataset.format,request.value);
}

const PMTILES_DERIVATIVE_SOURCE_FORMATS = new Set([
  "geojson", "csv", "shapefile", "geopackage", "geoparquet"
]);

function pmtilesDerivativeEligibility(context, dataset, layer) {
  const generic = "Select an active managed vector upload with an immutable active version. Browser-only and live external layers are not eligible.";
  if (!context.canRequestProjectCompute) {
    return {allowed: false, message: "Your current project and dataset role cannot create archived derivatives."};
  }
  if (layer?.sourceType === "governed-dataset" && layer.datasetVersionId && dataset
    && (layer.datasetVersionId !== dataset.currentVersionId || layer.sourceVersion !== dataset.currentVersionNumber)) {
    return {allowed: false, message: "This Layer pins a different saved dataset version. Keep its existing display or deliberately select the current version before requesting a new conversion."};
  }
  if (!isPmtilesDerivativeSourceEligible(dataset, layer)) return {allowed: false, message: generic};
  return {allowed: true, message: null};
}

export function isPmtilesDerivativeSourceEligible(dataset, layer) {
  return layer?.sourceType === "governed-dataset"
    && (!layer.datasetVersionId || (layer.datasetVersionId === dataset?.currentVersionId
      && layer.sourceVersion === dataset?.currentVersionNumber))
    && Boolean(dataset?.currentVersionId)
    && dataset.sourceType === "upload"
    && PMTILES_DERIVATIVE_SOURCE_FORMATS.has(dataset.format)
    && dataset.status === "active"
    && dataset.currentVersionState === "active";
}

/** Route job history/review to the saved pin without changing the mutable dataset head. */
export function pmtilesJobDatasetForLayer(dataset, layer) {
  if (layer?.sourceType !== "governed-dataset" || dataset?.datasetId !== layer.datasetId
    || dataset.sourceType !== "upload") return null;
  const preserved = dataset.status === "draft" && isPreservedManagedDataset(dataset) && dataset.format === "geojson";
  if (dataset.status !== "active" && !preserved) return null;
  if (layer.datasetVersionId) {
    if (!Number.isSafeInteger(layer.sourceVersion) || layer.sourceVersion < 1) return null;
    if (preserved && (layer.datasetVersionId !== dataset.currentVersionId || layer.sourceVersion !== dataset.currentVersionNumber)) return null;
    return {...dataset, currentVersionId: layer.datasetVersionId, currentVersionNumber: layer.sourceVersion};
  }
  return isPmtilesDerivativeSourceEligible(dataset, layer) ? dataset : null;
}

function pmtilesDerivativeDraft(context, dataset, layer) {
  if (context.state.pmtilesDerivativeDraft?.datasetVersionId === dataset.currentVersionId) {
    return context.state.pmtilesDerivativeDraft;
  }
  const bounds = validGeographicBounds(dataset.bbox)
    ? [...dataset.bbox]
    : authoringMapExtent(context);
  context.state.pmtilesDerivativeDraft=createPmtilesConversionDraft({datasetVersionId:dataset.currentVersionId,bounds,sourceLayer:layer.sourceLayer});
  return context.state.pmtilesDerivativeDraft;
}

function validGeographicBounds(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every(Number.isFinite)
    && value[0] >= -180 && value[0] < value[2] && value[2] <= 180
    && value[1] >= -90 && value[1] < value[3] && value[3] <= 90;
}

async function queuePmtilesDerivative(context, dataset, draft) {
  if (context.state.pmtilesDerivativeBusy) return;
  const availability=workbenchPmtilesAvailability(context,dataset);
  if(!availability.allowed&&!pmtilesUnconfirmedRetry(draft,context.pmtilesDerivativeJobs)){setStatus(context,availability.message);return;}
  let intent;
  try{intent=pmtilesRequestIntent(draft,context.pmtilesDerivativeJobs);}catch(error){setStatus(context,error.message);return;}
  if(intent.existing){setStatus(context,`A matching PMTiles conversion is ${intent.existing.state}; review its saved job instead of queuing a duplicate.`);return;}
  const restoreFocus = pmtilesDerivativeEditorHasFocus();
  if (typeof context.requestPmtilesDerivative !== "function") {
    context.state.processingLog.unshift("This deployment does not expose the durable PMTiles conversion route. No job was queued.");
    context.render();
    if (restoreFocus) restorePmtilesDerivativeFocus(context, "submit");
    return;
  }
  context.state.pmtilesDerivativeBusy = true;
  context.state.processingLog.unshift(`Queuing PMTiles conversion for ${dataset.title} ${dataset.currentVersion ?? ""}…`);
  context.render();
  if (restoreFocus) restorePmtilesDerivativeFocus(context, "editor");
  try {
    const job = await context.requestPmtilesDerivative(dataset,intent.request);
    replaceDurableJob(context.pmtilesDerivativeJobs, job);
    context.state.runtimeJobs.unshift({
      id: job.jobId,
      jobType: "vector-to-pmtiles",
      engine: "isolated aws worker",
      status: job.state,
      outputObjectId: job.outputObjectId
    });
    context.state.processingLog.unshift(
      `PMTiles job ${job.jobId} is ${job.state}; its output path is assigned and sealed by the server.`
    );
    setStatus(context, `PMTiles conversion queued for ${dataset.title}.`);
  } catch (error) {
    context.state.processingLog.unshift(
      `PMTiles conversion was not queued (${error?.code ?? "invalid_request"}). The unchanged request keeps its retry key. Refresh saved jobs before trying again, or review the conversion settings.`
    );
  } finally {
    const returnToEditor = restoreFocus && pmtilesDerivativeEditorHasFocus();
    context.state.pmtilesDerivativeBusy = false;
    context.render();
    if (returnToEditor) restorePmtilesDerivativeFocus(context, "submit");
  }
}

function pmtilesDerivativeEditorHasFocus() {
  return document.activeElement instanceof HTMLElement
    && document.activeElement.closest(".gis-pmtiles-derivative-editor") !== null;
}

function restorePmtilesDerivativeFocus(context, target) {
  queueMicrotask(() => {
    const editor = context.shell.querySelector(".gis-pmtiles-derivative-editor");
    const element = target === "submit"
      ? [...(editor?.querySelectorAll("button") ?? [])]
        .find((button) => /Queue on-demand conversion|Queuing conversion/.test(button.textContent))
      : editor;
    if (element instanceof HTMLElement) element.focus({preventScroll: true});
  });
}

function openCameraTourPanel(context) {
  if (isMobileWorkbenchViewport()) context.state.leftOpen = false;
  context.state.activePanel = "tour";
  context.state.rightOpen = true;
  context.state.activeMenu = null;
  setStatus(context, "Camera tour editor opened.");
  context.render();
}

function cameraTourPanel(context) {
  const {state} = context;
  const panel = panelShell();
  panel.classList.add("gis-camera-tour-panel");
  panel.dataset.playbackState = state.cameraTourPlaybackTimer ? "playing" : "stopped";
  const intro = editorSection(
    "Camera tour",
    "Record map views in sequence, tune their timing, scrub the exact timeline, and play the same deterministic camera path again."
  );
  intro.append(textElement(
    "p",
    "This increment is a silent visual tour. Narration, movie encoding, and KML gx:Tour exchange remain explicit follow-up work."
  ));
  panel.append(intro, cameraTourImportControl(context));
  if (!state.cameraTour) {
    const empty = editorSection(
      "Start with the current view",
      "The first view fixes the starting camera, projection, and spatial body. It does not copy or publish any map data."
    );
    empty.append(actionButton("Start camera tour", () => startCameraTour(context)));
    panel.append(empty);
    return panel;
  }

  const tour = state.cameraTour;
  const duration = cameraTourDurationMilliseconds(tour);
  const selectedIndex = Math.max(0, tour.keyframes.findIndex(({id}) => id === state.cameraTourSelectedId));
  const selected = tour.keyframes[selectedIndex] ?? tour.keyframes[0];
  const identity = editorSection("Tour identity", "The tour is stored as a versioned map extension when you save the project.");
  identity.append(
    textField("Tour name", tour.title, (title) => updateCameraTour(context, {...tour, title}, selected.id)),
    compactKeyValues({
      "Keyframes": `${tour.keyframes.length} of ${CAMERA_TOUR_LIMITS.maximumKeyframes}`,
      "Duration": formatTourTime(duration),
      "Projection": tour.projection,
      "Spatial body": tour.spatialBodyId,
      "Format": tour.schemaVersion
    })
  );
  panel.append(identity);

  const sequence = editorSection("View sequence", "Select a view to inspect it. Add current view records the map exactly as it appears now.");
  const list = document.createElement("div");
  list.className = "gis-camera-tour-keyframes";
  list.setAttribute("aria-label", "Camera tour views");
  for (const [index, keyframe] of tour.keyframes.entries()) {
    const button = actionButton(
      `${index + 1}. ${keyframe.title} · ${formatTourTime(keyframe.transitionMilliseconds)} + ${formatTourTime(keyframe.holdMilliseconds)} hold`,
      () => selectCameraTourKeyframe(context, keyframe.id)
    );
    button.dataset.cameraTourKeyframe = keyframe.id;
    button.classList.toggle("active", keyframe.id === selected.id);
    button.setAttribute("aria-pressed", String(keyframe.id === selected.id));
    list.append(button);
  }
  const sequenceActions = document.createElement("div");
  sequenceActions.className = "gis-camera-tour-actions";
  sequenceActions.append(
    actionButton("Add current view", () => addCurrentCameraTourView(context)),
    actionButton("Replace with current view", () => replaceCurrentCameraTourView(context, selected.id)),
    actionButton("Move earlier", () => moveCurrentCameraTourView(context, selected.id, -1)),
    actionButton("Move later", () => moveCurrentCameraTourView(context, selected.id, 1)),
    actionButton("Remove view", () => removeCurrentCameraTourView(context, selected.id))
  );
  sequenceActions.children[2].disabled = selectedIndex === 0;
  sequenceActions.children[3].disabled = selectedIndex === tour.keyframes.length - 1;
  sequenceActions.children[4].disabled = tour.keyframes.length === 1;
  sequenceActions.children[4].classList.add("danger");
  sequence.append(list, sequenceActions, cameraTourKeyframeEditor(context, selected, selectedIndex));
  panel.append(sequence);

  const playback = editorSection("Playback", "Play, pause, stop, or scrub without changing the recorded keyframes.");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = `${Math.max(1, duration)}`;
  slider.step = "10";
  slider.value = `${Math.min(duration, state.cameraTourElapsedMilliseconds)}`;
  slider.dataset.cameraTourTimeline = "elapsed";
  slider.setAttribute("aria-label", "Camera tour timeline");
  slider.addEventListener("input", () => seekCameraTour(context, Number(slider.value)));
  const time = textElement("output", `${formatTourTime(state.cameraTourElapsedMilliseconds)} / ${formatTourTime(duration)}`);
  time.dataset.cameraTourTime = "elapsed";
  const playbackActions = document.createElement("div");
  playbackActions.className = "gis-camera-tour-actions";
  playbackActions.append(
    actionButton(state.cameraTourPlaybackTimer ? "Pause tour" : "Play tour", () => (
      state.cameraTourPlaybackTimer ? pauseCameraTour(context) : playCameraTour(context)
    )),
    actionButton("Stop tour", () => stopCameraTourPlayback(context)),
    actionButton("Download tour JSON", () => downloadBlob(
      `${slug(tour.title)}.opengeo-tour.json`,
      exportCameraTour(tour),
      "application/json"
    ))
  );
  playback.append(time, slider, playbackActions);
  panel.append(playback);
  return panel;
}

function cameraTourImportControl(context) {
  const section = editorSection(
    "OpenGeo Studio tour file",
    `Import one bounded .json tour file up to ${Math.floor(CAMERA_TOUR_LIMITS.maximumSerializedBytes / 1024)} KiB. Opening it performs no network requests.`
  );
  const label = document.createElement("label");
  label.className = "gis-file-drop";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.opengeo-tour.json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > CAMERA_TOUR_LIMITS.maximumSerializedBytes) throw Object.assign(new Error("camera_tour_serialized_limit"), {code: "camera_tour_serialized_limit"});
      const tour = parseCameraTour(await file.text());
      stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
      stateSetCameraTour(context, tour, tour.keyframes[0].id);
      setStatus(context, `${tour.title} opened locally with ${tour.keyframes.length} camera views.`);
    } catch (error) {
      setStatus(context, `Camera tour file rejected safely (${error?.code ?? "camera_tour_json_invalid"}).`);
      context.render();
    }
  });
  label.append(input, textElement("strong", "Open tour JSON"));
  section.append(label);
  return section;
}

function cameraTourKeyframeEditor(context, keyframe, index) {
  const editor = document.createElement("div");
  editor.className = "gis-camera-tour-keyframe-editor";
  editor.dataset.cameraTourEditor = keyframe.id;
  editor.append(textField("View name", keyframe.title, (title) => (
    updateCameraTourKeyframeFromPanel(context, keyframe.id, {title})
  )));
  const transition = cameraTourDurationInput(
    "Travel time (seconds)",
    keyframe.transitionMilliseconds,
    CAMERA_TOUR_LIMITS.maximumTransitionMilliseconds
  );
  transition.input.disabled = index === 0;
  const hold = cameraTourDurationInput(
    "Hold time (seconds)",
    keyframe.holdMilliseconds,
    CAMERA_TOUR_LIMITS.maximumHoldMilliseconds
  );
  const easing = selectInput("Motion", keyframe.easing, [["smooth", "Smooth"], ["linear", "Linear"]]);
  easing.input.disabled = index === 0;
  const apply = actionButton("Apply timing", () => updateCameraTourKeyframeFromPanel(context, keyframe.id, {
    transitionMilliseconds: index === 0 ? 0 : Math.round(Number(transition.input.value) * 1_000),
    holdMilliseconds: Math.round(Number(hold.input.value) * 1_000),
    easing: easing.input.value
  }));
  editor.append(
    transition.wrapper,
    hold.wrapper,
    easing.wrapper,
    apply,
    compactKeyValues({
      "Longitude": keyframe.camera.center[0],
      "Latitude": keyframe.camera.center[1],
      "Zoom": keyframe.camera.zoom,
      "Bearing": `${keyframe.camera.bearing}°`,
      "Pitch": `${keyframe.camera.pitch}°`
    })
  );
  return editor;
}

function cameraTourDurationInput(labelText, milliseconds, maximumMilliseconds) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = `${maximumMilliseconds / 1_000}`;
  input.step = "0.1";
  input.value = `${milliseconds / 1_000}`;
  return {input, wrapper: fieldWrap(labelText, input)};
}

function startCameraTour(context) {
  try {
    const camera = captureCurrentCameraTourView(context);
    const tour = createCameraTour({
      title: `${context.project?.title ?? context.workspace?.title ?? "Untitled map"} tour`,
      camera,
      projection: context.state.globe ? "globe" : "mercator",
      spatialBodyId: context.state.spatialBody.id
    });
    stateSetCameraTour(context, tour, tour.keyframes[0].id);
    setStatus(context, "Camera tour started with the current map view.");
  } catch (error) {
    setStatus(context, `The current camera could not start a tour (${error?.code ?? "camera_tour_camera_invalid"}).`);
  }
}

function addCurrentCameraTourView(context) {
  try {
    const tour = addCameraTourKeyframe(context.state.cameraTour, captureCurrentCameraTourView(context));
    stateSetCameraTour(context, tour, tour.keyframes.at(-1).id);
    setStatus(context, `View ${tour.keyframes.length} added to the camera tour.`);
  } catch (error) {
    setStatus(context, `The current view was not added (${error?.code ?? "camera_tour_invalid"}).`);
  }
}

function replaceCurrentCameraTourView(context, keyframeId) {
  try {
    const tour = updateCameraTourKeyframe(context.state.cameraTour, keyframeId, {
      camera: captureCurrentCameraTourView(context)
    });
    stateSetCameraTour(context, tour, keyframeId);
    setStatus(context, "The selected camera view was replaced with the current map view.");
  } catch (error) {
    setStatus(context, `The selected view was not replaced (${error?.code ?? "camera_tour_invalid"}).`);
  }
}

function updateCameraTourKeyframeFromPanel(context, keyframeId, patch) {
  try {
    const tour = updateCameraTourKeyframe(context.state.cameraTour, keyframeId, patch);
    stateSetCameraTour(context, tour, keyframeId);
    setStatus(context, "Camera view timing updated.");
  } catch (error) {
    setStatus(context, `Camera view update rejected (${error?.code ?? "camera_tour_invalid"}).`);
  }
}

function moveCurrentCameraTourView(context, keyframeId, direction) {
  try {
    stateSetCameraTour(context, moveCameraTourKeyframe(context.state.cameraTour, keyframeId, direction), keyframeId);
    setStatus(context, direction < 0 ? "Camera view moved earlier." : "Camera view moved later.");
  } catch (error) {
    setStatus(context, `Camera view was not moved (${error?.code ?? "camera_tour_invalid"}).`);
  }
}

function removeCurrentCameraTourView(context, keyframeId) {
  try {
    const currentIndex = context.state.cameraTour.keyframes.findIndex(({id}) => id === keyframeId);
    const tour = removeCameraTourKeyframe(context.state.cameraTour, keyframeId);
    stateSetCameraTour(context, tour, tour.keyframes[Math.min(currentIndex, tour.keyframes.length - 1)].id);
    setStatus(context, "Camera view removed.");
  } catch (error) {
    setStatus(context, `Camera view was not removed (${error?.code ?? "camera_tour_last_keyframe_required"}).`);
  }
}

function selectCameraTourKeyframe(context, keyframeId) {
  const keyframe = context.state.cameraTour?.keyframes.find(({id}) => id === keyframeId);
  if (!keyframe) return;
  stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
  context.state.cameraTourSelectedId = keyframeId;
  applyCameraTourCamera(context.state.map, keyframe.camera);
  context.render();
}

function updateCameraTour(context, value, selectedId) {
  try {
    stateSetCameraTour(context, cameraTourForSave(value), selectedId);
    setStatus(context, "Camera tour updated.");
  } catch (error) {
    setStatus(context, `Camera tour update rejected (${error?.code ?? "camera_tour_invalid"}).`);
  }
}

function stateSetCameraTour(context, tour, selectedId) {
  stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
  context.state.cameraTour = cameraTourForSave(tour);
  context.state.cameraTourSelectedId = context.state.cameraTour.keyframes.some(({id}) => id === selectedId)
    ? selectedId
    : context.state.cameraTour.keyframes[0].id;
  context.state.cameraTourElapsedMilliseconds = 0;
  context.render();
}

function captureCurrentCameraTourView(context) {
  return captureCameraTourView(
    context.state.map,
    context.state.restoredMapViews?.[0] ?? context.project?.mapViews?.[0]
  );
}

function playCameraTour(context) {
  const {state} = context;
  if (!state.cameraTour || state.cameraTourPlaybackTimer) return;
  const duration = cameraTourDurationMilliseconds(state.cameraTour);
  if (state.cameraTourElapsedMilliseconds >= duration) state.cameraTourElapsedMilliseconds = 0;
  state.cameraTourPlaybackStartElapsedMilliseconds = state.cameraTourElapsedMilliseconds;
  state.cameraTourPlaybackStartedAt = monotonicNow();
  const tick = () => {
    if (!state.cameraTourPlaybackTimer || !state.cameraTour) return;
    const elapsed = state.cameraTourPlaybackStartElapsedMilliseconds + monotonicNow() - state.cameraTourPlaybackStartedAt;
    const frame = cameraTourFrameAt(state.cameraTour, elapsed);
    state.cameraTourElapsedMilliseconds = frame.elapsedMilliseconds;
    state.cameraTourSelectedId = state.cameraTour.keyframes[frame.keyframeIndex].id;
    applyCameraTourCamera(state.map, frame.camera);
    updateCameraTourPlaybackPresentation(context, frame);
    if (frame.done) {
      clearTimeout(state.cameraTourPlaybackTimer);
      state.cameraTourPlaybackTimer = null;
      state.cameraTourPlaybackStartedAt = null;
      setStatus(context, "Camera tour finished.");
      context.render();
      return;
    }
    state.cameraTourPlaybackTimer = setTimeout(tick, CAMERA_TOUR_LIMITS.minimumPlaybackIntervalMilliseconds);
  };
  state.cameraTourPlaybackTimer = setTimeout(tick, 0);
  setStatus(context, "Camera tour playing. Pause or stop at any time.");
  context.render();
}

function pauseCameraTour(context) {
  stopCameraTourPlayback(context, {reset: false, announce: false});
  setStatus(context, `Camera tour paused at ${formatTourTime(context.state.cameraTourElapsedMilliseconds)}.`);
}

function stopCameraTourPlayback(context, {reset = true, render = true, announce = true} = {}) {
  const {state} = context;
  if (state.cameraTourPlaybackTimer) clearTimeout(state.cameraTourPlaybackTimer);
  state.cameraTourPlaybackTimer = null;
  state.cameraTourPlaybackStartedAt = null;
  state.cameraTourPlaybackStartElapsedMilliseconds = 0;
  if (reset) {
    state.cameraTourElapsedMilliseconds = 0;
    if (state.cameraTour) {
      const frame = cameraTourFrameAt(state.cameraTour, 0);
      state.cameraTourSelectedId = state.cameraTour.keyframes[frame.keyframeIndex].id;
      applyCameraTourCamera(state.map, frame.camera);
    }
  }
  if (announce) setStatus(context, reset ? "Camera tour stopped at its starting view." : "Camera tour paused.");
  if (render) context.render();
}

function seekCameraTour(context, elapsedMilliseconds) {
  const {state} = context;
  if (!state.cameraTour) return;
  stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
  const frame = cameraTourFrameAt(state.cameraTour, elapsedMilliseconds);
  state.cameraTourElapsedMilliseconds = frame.elapsedMilliseconds;
  state.cameraTourSelectedId = state.cameraTour.keyframes[frame.keyframeIndex].id;
  applyCameraTourCamera(state.map, frame.camera);
  updateCameraTourPlaybackPresentation(context, frame);
}

function applyCameraTourCamera(map, camera) {
  map?.jumpTo?.({
    center: camera.center,
    zoom: camera.zoom,
    pitch: camera.pitch,
    bearing: camera.bearing
  });
}

function updateCameraTourPlaybackPresentation(context, frame) {
  const timeline = context.shell.querySelector('[data-camera-tour-timeline="elapsed"]');
  const output = context.shell.querySelector('[data-camera-tour-time="elapsed"]');
  if (timeline) timeline.value = `${Math.round(frame.elapsedMilliseconds)}`;
  if (output) output.textContent = `${formatTourTime(frame.elapsedMilliseconds)} / ${formatTourTime(frame.durationMilliseconds)}`;
  context.shell.dataset.cameraTourElapsed = `${Math.round(frame.elapsedMilliseconds)}`;
  context.shell.dataset.cameraTourPhase = frame.phase;
}

function formatTourTime(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1_000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`
    : `${seconds.toFixed(1)}s`;
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function openFlightSimulatorPanel(context) {
  const {state} = context;
  if (state.spatialBody.id !== "earth") {
    setStatus(context, `The current flight model and governed terrain source are Earth-only and unavailable on ${state.spatialBody.title}.`);
    return;
  }
  stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
  stopHistoricalPlayback(state);
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  state.activePanel = "flight";
  state.rightOpen = true;
  state.activeMenu = null;
  setStatus(context, "Terrain-aware flight simulator opened.");
  context.render();
}

function flightSimulatorPanel(context) {
  const {state} = context;
  const panel = panelShell();
  panel.classList.add("gis-flight-panel");
  const intro = editorSection(
    "Terrain-aware flight",
    "Fly a bounded training model over the same governed Earth terrain shown on the map. This is an exploratory GIS control, not a certified flight model."
  );
  intro.append(compactKeyValues({
    "Model": "opengeo.flight-model.1.0.0",
    "Maximum session": "60 minutes",
    "Physics step": `${FLIGHT_LIMITS.fixedStepMilliseconds} ms`,
    "Terrain clearance": `${FLIGHT_LIMITS.minimumClearanceMeters} m`,
    "Authority": "browser map only"
  }));
  panel.append(intro);

  const readiness = flightReadiness(context);
  const scene = editorSection(
    "Flight scene",
    readiness.ready
      ? "Globe and governed terrain are ready at the current map position."
      : readiness.message
  );
  scene.dataset.flightReadiness = readiness.code;
  if (!readiness.ready) {
    const prepare = actionButton("Enable globe and governed terrain", () => prepareFlightScene(context));
    prepare.disabled = state.spatialBody.id !== "earth" || !state.map;
    scene.append(prepare);
  }
  scene.append(projectionDisclosure(context));
  panel.append(scene);

  if (!state.flightSession) {
    panel.append(flightConfigurationPanel(context, readiness));
    return panel;
  }

  panel.append(flightSessionPanel(context));
  return panel;
}

function flightConfigurationPanel(context, readiness) {
  const {state} = context;
  const section = editorSection(
    "Start flight",
    "The aircraft starts above the current map center and heading. Terrain must have a finite unexaggerated elevation sample at that position."
  );
  const profile = selectInput(
    "Aircraft",
    state.flightProfileId,
    Object.values(AIRCRAFT_PROFILES).map(({id, title}) => [id, title])
  );
  profile.input.addEventListener("change", () => {
    state.flightProfileId = profile.input.value;
    setStatus(context, `${aircraftProfile(state.flightProfileId).title} selected.`);
    context.render();
  });
  const agl = flightNumberInput(
    "Starting height above terrain (metres)",
    state.flightStartingAglMeters,
    FLIGHT_LIMITS.minimumStartingAglMeters,
    FLIGHT_LIMITS.maximumStartingAglMeters,
    10
  );
  const heading = flightNumberInput("Starting heading (degrees)", state.flightHeadingDegrees, 0, 359.9, 1);
  const start = actionButton("Start flight", () => {
    state.flightStartingAglMeters = Number(agl.input.value);
    state.flightHeadingDegrees = Number(heading.input.value);
    startFlightSimulation(context);
  });
  start.disabled = !readiness.ready;
  section.append(
    profile.wrapper,
    textElement("p", aircraftProfile(state.flightProfileId).description),
    agl.wrapper,
    heading.wrapper,
    start,
    textElement("p", "Keyboard and controller input remain inactive until a flight starts. No session, controller reading, or terrain sample is persisted.")
  );
  return section;
}

function flightNumberInput(label, value, minimum, maximum, step) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = `${minimum}`;
  input.max = `${maximum}`;
  input.step = `${step}`;
  input.value = `${value}`;
  return {input, wrapper: fieldWrap(label, input)};
}

function flightSessionPanel(context) {
  const {state} = context;
  const session = state.flightSession;
  const hud = flightHud(session);
  const profile = aircraftProfile(session.profileId);
  const section = editorSection(
    "Active flight",
    `${profile.title} · ${flightPhaseLabel(session.phase)}. Focus the HUD over the map for keyboard control.`
  );
  section.dataset.flightPhase = session.phase;
  section.append(compactKeyValues({
    "Airspeed": `${hud.airspeedKnots} kt`,
    "Altitude": `${hud.altitudeFeet} ft MSL`,
    "Height": `${hud.aglFeet} ft AGL`,
    "Heading": `${String(hud.headingDegrees % 360).padStart(3, "0")}°`,
    "Vertical speed": `${hud.verticalSpeedFeetPerMinute} ft/min`,
    "Throttle": `${hud.throttlePercent}%`,
    "Elapsed": formatTourTime(hud.elapsedMilliseconds)
  }));
  const lifecycle = document.createElement("div");
  lifecycle.className = "gis-flight-actions";
  if (session.phase === "flying") {
    lifecycle.append(actionButton("Pause flight", () => pauseFlightSimulation(context)));
  } else if (session.phase === "paused") {
    lifecycle.append(actionButton("Resume flight", () => resumeFlightSimulation(context)));
  }
  lifecycle.append(
    actionButton("Reset flight", () => resetFlightSimulation(context)),
    actionButton("End flight", () => endFlightSimulation(context))
  );
  section.append(lifecycle);

  const controls = document.createElement("div");
  controls.className = "gis-flight-control-grid";
  controls.setAttribute("aria-label", "Press and hold flight controls");
  controls.append(
    flightHoldButton(context, "Nose down", "pitch", -1),
    flightHoldButton(context, "Nose up", "pitch", 1),
    flightHoldButton(context, "Bank left", "roll", -1),
    flightHoldButton(context, "Bank right", "roll", 1),
    flightHoldButton(context, "Yaw left", "yaw", -1),
    flightHoldButton(context, "Yaw right", "yaw", 1),
    flightHoldButton(context, "Throttle down", "throttleDeltaPerSecond", -1),
    flightHoldButton(context, "Throttle up", "throttleDeltaPerSecond", 1)
  );
  section.append(controls);

  const controller = editorSection(
    "Optional controller",
    "After explicit activation, OpenGeo Studio reads only the first connected standard browser gamepad. It requests no additional device, network, storage, data, or publication authority."
  );
  const toggle = actionButton(state.flightControllerEnabled ? "Disable controller" : "Enable standard controller", () => {
    state.flightControllerEnabled = !state.flightControllerEnabled;
    state.flightControllerIndex = null;
    state.flightControllerStatus = state.flightControllerEnabled ? "waiting" : "not-enabled";
    setStatus(context, state.flightControllerEnabled
      ? "Standard-controller reading enabled for this flight only."
      : "Controller reading disabled.");
    context.render();
  });
  controller.append(toggle, textElement("p", `Controller status: ${flightControllerStatusLabel(state.flightControllerStatus)}`));
  section.append(controller);
  return section;
}

function flightReadiness(context) {
  const {state} = context;
  if (state.spatialBody.id !== "earth") return {ready: false, code: "earth-required", message: "Select an Earth project before starting flight."};
  if (!state.map) return {ready: false, code: "map-loading", message: "Wait for the interactive map to finish loading."};
  if (!state.globe) return {ready: false, code: "globe-required", message: "Enable the globe projection before starting flight."};
  if (!state.terrainEnabled || state.map.getTerrain?.()?.source !== OPEN_TERRAIN_SOURCE.sourceId) {
    return {ready: false, code: "terrain-required", message: "Enable the governed open-terrain surface before starting flight."};
  }
  const center = state.map.getCenter?.();
  if (!center) return {ready: false, code: "position-unavailable", message: "The current map position is unavailable."};
  const elevation = queryFlightTerrain(state.map, [center.lng, center.lat]);
  if (!Number.isFinite(elevation)) return {ready: false, code: "terrain-sample-unavailable", message: "Terrain has not produced a finite elevation at the current map center. Move to covered terrain or retry after tiles load."};
  return {ready: true, code: "ready", message: "Flight scene ready.", position: [center.lng, center.lat], elevation};
}

function prepareFlightScene(context) {
  const {state} = context;
  if (state.spatialBody.id !== "earth" || !state.map) return;
  if (!state.globe) toggleProjection(context);
  if (state.globe && !state.terrainEnabled) toggleTerrain(context);
  const readiness = flightReadiness(context);
  setStatus(context, readiness.ready ? "Globe and governed terrain are ready for flight." : readiness.message);
  context.render();
}

function startFlightSimulation(context) {
  const {state} = context;
  const readiness = flightReadiness(context);
  if (!readiness.ready) {
    setStatus(context, readiness.message);
    context.render();
    return;
  }
  try {
    cancelQueryDrawing(context, {render: false, announce: false});
    cancelMapAuthoring(context, {render: false, announce: false});
    cancelTemporaryEdit(context, {render: false, announce: false});
    state.measureMode = false;
    state.measurePoints = [];
    state.flightSession = resumeFlight(createFlightSession({
      profileId: state.flightProfileId,
      position: readiness.position,
      terrainElevationMeters: readiness.elevation,
      startingAglMeters: state.flightStartingAglMeters,
      headingDegrees: state.flightHeadingDegrees
    }));
    state.flightKeyboardKeys.clear();
    state.flightAccumulatorMilliseconds = 0;
    applyFlightCamera(context);
    setStatus(context, `${aircraftProfile(state.flightProfileId).title} flight started. Focus the HUD for keyboard control.`);
    context.render();
    startFlightLoop(context);
    queueMicrotask(() => context.shell.querySelector(".gis-flight-hud")?.focus({preventScroll: true}));
  } catch (error) {
    setStatus(context, `Flight did not start (${error?.code ?? "flight_start_invalid"}).`);
    context.render();
  }
}

function startFlightLoop(context) {
  const {state} = context;
  stopFlightLoop(context);
  if (state.flightSession?.phase !== "flying") return;
  state.flightLastFrameAt = null;
  const tick = (now) => {
    if (state.flightSession?.phase !== "flying") {
      stopFlightLoop(context);
      return;
    }
    const previous = state.flightLastFrameAt;
    state.flightLastFrameAt = now;
    const delta = previous === null
      ? FLIGHT_LIMITS.fixedStepMilliseconds
      : Math.min(FLIGHT_LIMITS.maximumCatchUpMilliseconds, Math.max(0, now - previous));
    state.flightAccumulatorMilliseconds = Math.min(
      FLIGHT_LIMITS.maximumCatchUpMilliseconds,
      state.flightAccumulatorMilliseconds + delta
    );
    const controls = currentFlightControls(context);
    while (state.flightAccumulatorMilliseconds >= FLIGHT_LIMITS.fixedStepMilliseconds
      && state.flightSession.phase === "flying") {
      state.flightSession = stepFlight(
        state.flightSession,
        controls,
        FLIGHT_LIMITS.fixedStepMilliseconds,
        {terrainElevationAt: (position) => queryFlightTerrain(state.map, position)}
      );
      state.flightAccumulatorMilliseconds -= FLIGHT_LIMITS.fixedStepMilliseconds;
    }
    applyFlightCamera(context);
    updateFlightPresentation(context);
    if (state.flightSession.phase === "flying") {
      state.flightAnimationFrameId = requestAnimationFrame(tick);
      return;
    }
    state.flightAnimationFrameId = null;
    state.flightLastFrameAt = null;
    setStatus(context, flightTerminalMessage(state.flightSession.phase));
    context.render();
  };
  state.flightAnimationFrameId = requestAnimationFrame(tick);
}

function stopFlightLoop(context) {
  const {state} = context;
  if (state.flightAnimationFrameId !== null) cancelAnimationFrame(state.flightAnimationFrameId);
  state.flightAnimationFrameId = null;
  state.flightLastFrameAt = null;
  state.flightAccumulatorMilliseconds = 0;
  state.flightKeyboardKeys.clear();
  state.flightManualControls = {pitch: 0, roll: 0, yaw: 0, throttleDeltaPerSecond: 0};
}

function pauseFlightSimulation(context, {render = true, announce = true} = {}) {
  if (!context.state.flightSession) return;
  stopFlightLoop(context);
  context.state.flightSession = pauseFlight(context.state.flightSession);
  if (announce) setStatus(context, "Flight paused. The exact aircraft state remains in this browser session.");
  if (render) context.render();
}

function resumeFlightSimulation(context) {
  const session = context.state.flightSession;
  if (!session) return;
  context.state.flightSession = resumeFlight(session);
  if (context.state.flightSession.phase !== "flying") {
    setStatus(context, "Reset the flight after a collision, terrain gap, or session limit before resuming.");
    context.render();
    return;
  }
  setStatus(context, "Flight resumed.");
  context.render();
  startFlightLoop(context);
  queueMicrotask(() => context.shell.querySelector(".gis-flight-hud")?.focus({preventScroll: true}));
}

function resetFlightSimulation(context) {
  if (!context.state.flightSession) return;
  stopFlightLoop(context);
  context.state.flightSession = resetFlight(context.state.flightSession);
  applyFlightCamera(context);
  setStatus(context, "Flight reset to its exact starting aircraft state and remains paused.");
  context.render();
}

function endFlightSimulation(context, {render = true, announce = true} = {}) {
  stopFlightLoop(context);
  context.state.flightSession = null;
  context.state.flightControllerEnabled = false;
  context.state.flightControllerIndex = null;
  context.state.flightControllerStatus = "not-enabled";
  delete context.shell.dataset.flightPhase;
  delete context.shell.dataset.flightElapsed;
  delete context.shell.dataset.flightHeading;
  delete context.shell.dataset.flightAgl;
  if (announce) setStatus(context, "Flight ended. No simulator state was saved or published.");
  if (render) context.render();
}

function markFlightTerrainUnavailable(context) {
  const session = context.state.flightSession;
  if (!session) return;
  stopFlightLoop(context);
  context.state.flightSession = {...pauseFlight(session), phase: "terrain_unavailable"};
}

function currentFlightControls(context) {
  const {state} = context;
  const keyboard = keyboardFlightControls(state.flightKeyboardKeys);
  const controller = activeStandardController(state);
  return mergeFlightControls(keyboard, state.flightManualControls, controller);
}

function activeStandardController(state) {
  if (!state.flightControllerEnabled) return null;
  let gamepads;
  try {
    gamepads = globalThis.navigator?.getGamepads?.();
  } catch {
    state.flightControllerStatus = "unavailable";
    return null;
  }
  const candidates = [...(gamepads ?? [])].filter(Boolean);
  let gamepad = Number.isInteger(state.flightControllerIndex)
    ? candidates.find(({index}) => index === state.flightControllerIndex)
    : candidates.find(({connected, mapping}) => connected && mapping === "standard");
  const controls = standardControllerFlightControls(gamepad);
  if (!controls) {
    state.flightControllerStatus = candidates.length ? "unsupported" : "waiting";
    state.flightControllerIndex = null;
    return null;
  }
  state.flightControllerIndex = gamepad.index;
  state.flightControllerStatus = "connected";
  return controls;
}

function queryFlightTerrain(map, [longitude, latitude]) {
  if (!map || typeof map.queryTerrainElevation !== "function") return null;
  try {
    const elevation = map.queryTerrainElevation({lng: longitude, lat: latitude}, {exaggerated: false});
    return Number.isFinite(elevation) ? elevation : null;
  } catch {
    return null;
  }
}

function applyFlightCamera(context) {
  const session = context.state.flightSession;
  const map = context.state.map;
  if (!session || !map) return;
  const zoom = Math.max(4, Math.min(18, 16 - Math.log2(Math.max(30, session.aglMeters) / 100)));
  map.jumpTo?.({
    center: session.position,
    bearing: session.headingDegrees,
    pitch: Math.max(45, Math.min(85, 65 + session.pitchDegrees * 0.3)),
    zoom
  });
}

function flightHudOverlay(context) {
  const {state} = context;
  const hud = flightHud(state.flightSession);
  const overlay = document.createElement("section");
  overlay.className = "gis-flight-hud";
  overlay.tabIndex = 0;
  overlay.setAttribute("aria-label", "Flight simulator heads-up display. Focus here for keyboard controls.");
  overlay.dataset.flightPhase = hud.phase;
  const horizon = document.createElement("div");
  horizon.className = "gis-flight-horizon";
  horizon.style.setProperty("--flight-bank", `${hud.bankDegrees}deg`);
  horizon.style.setProperty("--flight-pitch", `${hud.pitchDegrees}px`);
  horizon.append(textElement("span", "—  —"));
  const values = document.createElement("div");
  values.className = "gis-flight-hud-values";
  for (const [key, label, value] of [
    ["speed", "SPD", `${hud.airspeedKnots} kt`],
    ["altitude", "ALT", `${hud.altitudeFeet} ft`],
    ["agl", "AGL", `${hud.aglFeet} ft`],
    ["heading", "HDG", `${String(hud.headingDegrees % 360).padStart(3, "0")}°`],
    ["vertical", "V/S", `${hud.verticalSpeedFeetPerMinute}`],
    ["throttle", "THR", `${hud.throttlePercent}%`]
  ]) {
    const output = textElement("output", `${label} ${value}`);
    output.dataset.flightHudValue = key;
    values.append(output);
  }
  const help = textElement(
    "span",
    "Arrow keys: pitch/bank · A/D: yaw · Page Up/Down: throttle · Escape: pause"
  );
  help.className = "gis-flight-hud-help";
  overlay.append(
    textElement("strong", flightPhaseLabel(hud.phase)),
    horizon,
    values,
    help,
    textElement("small", "Training model · unexaggerated governed terrain · not for navigation")
  );
  bindFlightHudKeyboard(context, overlay);
  return overlay;
}

function bindFlightHudKeyboard(context, element) {
  const recognized = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyA", "KeyD", "PageUp", "PageDown"]);
  element.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      event.preventDefault();
      pauseFlightSimulation(context);
      return;
    }
    if (!recognized.has(event.code) || context.state.flightSession?.phase !== "flying") return;
    event.preventDefault();
    context.state.flightKeyboardKeys.add(event.code);
  });
  element.addEventListener("keyup", (event) => {
    if (!recognized.has(event.code)) return;
    event.preventDefault();
    context.state.flightKeyboardKeys.delete(event.code);
  });
  element.addEventListener("blur", () => context.state.flightKeyboardKeys.clear());
}

function flightHoldButton(context, label, control, value) {
  const button = actionButton(label, () => {});
  const press = (event) => {
    event.preventDefault();
    context.state.flightManualControls[control] = value;
    button.setAttribute("aria-pressed", "true");
  };
  const release = () => {
    context.state.flightManualControls[control] = 0;
    button.removeAttribute("aria-pressed");
  };
  button.addEventListener("pointerdown", press);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
  button.addEventListener("keydown", (event) => {
    if (["Enter", "Space"].includes(event.code)) press(event);
  });
  button.addEventListener("keyup", (event) => {
    if (["Enter", "Space"].includes(event.code)) release();
  });
  button.addEventListener("blur", release);
  return button;
}

function updateFlightPresentation(context) {
  const session = context.state.flightSession;
  if (!session) return;
  const hud = flightHud(session);
  const overlay = context.shell.querySelector(".gis-flight-hud");
  if (overlay) {
    overlay.dataset.flightPhase = hud.phase;
    const values = {
      speed: `SPD ${hud.airspeedKnots} kt`,
      altitude: `ALT ${hud.altitudeFeet} ft`,
      agl: `AGL ${hud.aglFeet} ft`,
      heading: `HDG ${String(hud.headingDegrees % 360).padStart(3, "0")}°`,
      vertical: `V/S ${hud.verticalSpeedFeetPerMinute}`,
      throttle: `THR ${hud.throttlePercent}%`
    };
    for (const [key, value] of Object.entries(values)) {
      const output = overlay.querySelector(`[data-flight-hud-value="${key}"]`);
      if (output) output.textContent = value;
    }
    const horizon = overlay.querySelector(".gis-flight-horizon");
    horizon?.style.setProperty("--flight-bank", `${hud.bankDegrees}deg`);
    horizon?.style.setProperty("--flight-pitch", `${hud.pitchDegrees}px`);
  }
  context.shell.dataset.flightPhase = hud.phase;
  context.shell.dataset.flightElapsed = `${hud.elapsedMilliseconds}`;
  context.shell.dataset.flightHeading = `${hud.headingDegrees % 360}`;
  context.shell.dataset.flightAgl = `${hud.aglFeet}`;
}

function flightPhaseLabel(phase) {
  return ({
    flying: "Flying",
    paused: "Paused",
    collision: "Terrain contact",
    terrain_unavailable: "Terrain unavailable",
    session_limit: "Session limit reached"
  })[phase] ?? "Flight unavailable";
}

function flightTerminalMessage(phase) {
  return ({
    collision: "Flight paused at the exact terrain-clearance limit after terrain contact. Reset before continuing.",
    terrain_unavailable: "Flight paused safely because the governed terrain surface returned no finite elevation. Reset after terrain is available.",
    session_limit: "Flight ended at the declared 60-minute session limit. Reset to begin again."
  })[phase] ?? "Flight paused safely."
}

function flightControllerStatusLabel(status) {
  return ({
    "not-enabled": "not enabled",
    waiting: "waiting for a connected standard controller",
    connected: "connected for this browser session",
    unsupported: "connected controller does not expose the standard mapping",
    unavailable: "browser controller access is unavailable"
  })[status] ?? "unavailable";
}

function openHistoricalImageryPanel(context) {
  const {state} = context;
  if (state.spatialBody.id !== "earth") {
    setStatus(context, "Historical Earth imagery is available only in an empty or Earth project.");
    return;
  }
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  state.activePanel = "history";
  state.rightOpen = true;
  state.activeMenu = null;
  setStatus(context, "Historical imagery timeline opened.");
  context.render();
}

function historicalImageryPanel(context) {
  const {state} = context;
  if (state.historyViewerSource === WAYBACK_SOURCE_ID) return waybackHistoryPanel(context);
  const panel = panelShell();
  panel.classList.add("gis-history-panel");
  panel.setAttribute("aria-live", "polite");
  const configuration = state.historicalImagery;
  const source = historicalImagerySource(configuration.sourceId);
  const dates = state.historicalAvailability;
  const currentDate = configuration.selection.displayedDate;
  const currentIndex = dates.indexOf(currentDate);
  const basemap = activeBasemap(context);
  const activeTemporal = basemap?.kind === "temporal-raster";
  panel.dataset.imageryActive = String(activeTemporal);

  const intro = editorSection(
    "Imagery timeline",
    "Explore dated imagery from another source. Opening this panel does not change the map or show the edit history of your layers. Choose View date to replace the basemap; your drawings and layers stay in place."
  );
  intro.append(selectField(
    "Imagery source to explore",
    source.sourceId,
    [...reviewedHistoricalImagerySources().map(({sourceId, title}) => [sourceId, title]), [WAYBACK_SOURCE_ID, "Esri World Imagery Wayback"]],
    (sourceId) => changeHistoricalImagerySource(context, sourceId)
  ));
  const sourceDetails = document.createElement("details");
  sourceDetails.append(textElement("summary", "Source and date details"));
  sourceDetails.append(compactKeyValues({
    "Current basemap": basemap?.title ?? "No basemap",
    "Active imagery date": activeTemporal ? basemap.selection.displayedDate : "No historical imagery is active",
    "Selected date": currentDate,
    "Date result": configuration.selection.reason === "exact"
      ? "Exact provider date"
      : `${configuration.selection.requestedDate} → ${currentDate} (${configuration.selection.policy})`,
    "Resolution": source.resolution,
    "Time meaning": source.timeMeaning
  }));
  intro.append(textElement("p", activeTemporal
    ? `On map: ${basemap.title}`
    : `Current basemap: ${basemap?.title ?? "None"}. No historical imagery is active.`));
  panel.append(intro);

  const timeline = editorSection(
    "Available dates",
    state.historicalAvailabilityMessage
  );
  timeline.dataset.availabilityStatus = state.historicalAvailabilityStatus;
  const dateReadout = textElement("output", currentDate);
  dateReadout.className = "gis-history-selected-date";
  dateReadout.setAttribute("aria-live", "polite");
  timeline.append(dateReadout);
  let range;
  if (dates.length) {
    range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = `${Math.max(0, dates.length - 1)}`;
    range.step = "1";
    range.value = `${Math.max(0, currentIndex)}`;
    range.setAttribute("aria-label", "Historical imagery date");
    range.setAttribute("aria-valuetext", currentDate);
    range.addEventListener("input", () => {
      const date = dates[Number(range.value)];
      dateReadout.textContent = date;
      range.setAttribute("aria-valuetext", date);
      dateInput.value = date;
      configuration.selection.requestedDate = date;
    });
    range.addEventListener("change", () => applyHistoricalImageryDate(context, dates[Number(range.value)], "exact"));
    timeline.append(fieldWrap(`Timeline · ${dates.length} reviewed dates`, range));
    const ticks = document.createElement("div");
    ticks.className = "gis-history-date-ticks";
    ticks.setAttribute("aria-hidden", "true");
    for (const date of dates) {
      const tick = textElement("span", "");
      tick.title = date;
      ticks.append(tick);
    }
    timeline.append(ticks, textElement("p", `${dates[0]} — ${dates.at(-1)} · Snaps to available provider dates`));
  }
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.value = configuration.selection.requestedDate;
  if (dates[0]) dateInput.min = dates[0];
  if (dates.at(-1)) dateInput.max = dates.at(-1);
  dateInput.addEventListener("change", () => {
    if (!dateInput.value || !dates.length) return;
    const requestedDate = dateInput.value;
    const selection = resolveHistoricalSelection({requestedDate, availableDates: dates, policy: "nearest"});
    if (selection.status !== "resolved") return;
    dateInput.value = selection.displayedDate;
    configuration.selection.requestedDate = selection.displayedDate;
    dateReadout.textContent = selection.displayedDate === requestedDate
      ? selection.displayedDate
      : `${selection.displayedDate} · nearest available to ${requestedDate}`;
    if (range) {
      range.value = String(dates.indexOf(selection.displayedDate));
      range.setAttribute("aria-valuetext", selection.displayedDate);
    }
  });
  dateInput.disabled = !dates.length;
  timeline.append(fieldWrap("Find nearest available date (UTC)", dateInput));
  const policy = selectField(
    "When the requested date has a gap",
    configuration.selection.policy,
    [
      ["exact", "Require the exact date"],
      ["previous", "Use the previous available date"],
      ["next", "Use the next available date"],
      ["nearest", "Use the nearest available date"]
    ],
    (value) => configuration.selection.policy = value
  );
  sourceDetails.append(policy);
  const navigation = document.createElement("div");
  navigation.className = "gis-icon-row gis-history-navigation";
  const previous = actionButton("Previous", () => stepHistoricalImagery(context, -1));
  previous.disabled = currentIndex <= 0;
  const apply = actionButton("View date", () => applyHistoricalImageryDate(
    context,
    configuration.selection.requestedDate,
    configuration.selection.policy
  ));
  apply.disabled = !dates.length;
  const next = actionButton("Next", () => stepHistoricalImagery(context, 1));
  next.disabled = currentIndex < 0 || currentIndex >= dates.length - 1;
  const play = actionButton(state.historicalPlaybackTimer ? "Pause" : "Play", () => toggleHistoricalPlayback(context));
  play.disabled = dates.length < 2;
  navigation.append(previous, apply, next, play);
  timeline.append(navigation);
  const refresh = actionButton(
    state.historicalAvailabilityBusy ? "Checking provider…" : "Refresh provider dates",
    () => void refreshHistoricalAvailability(context)
  );
  refresh.disabled = state.historicalAvailabilityBusy;
  timeline.append(refresh);
  panel.append(timeline, sourceDetails);

  const compare = editorSection(
    "Before and after",
    "Save one comparison date and switch between A and B without changing either selection. A swipe view remains a later increment."
  );
  const compareInput = document.createElement("input");
  compareInput.type = "date";
  compareInput.value = configuration.comparison?.requestedDate ?? dates[0] ?? currentDate;
  if (dates[0]) compareInput.min = dates[0];
  if (dates.at(-1)) compareInput.max = dates.at(-1);
  compare.append(fieldWrap("Comparison date", compareInput));
  const compareActions = document.createElement("div");
  compareActions.className = "gis-icon-row";
  compareActions.append(
    actionButton("Set B", () => setHistoricalComparison(context, compareInput.value)),
    actionButton("Show A", () => showHistoricalComparison(context, "primary")),
    actionButton("Show B", () => showHistoricalComparison(context, "comparison"))
  );
  compareActions.children[1].disabled = configuration.compareShowing === "primary";
  compareActions.children[2].disabled = !configuration.comparison || configuration.compareShowing === "comparison";
  compare.append(compareActions);
  panel.append(compare);

  const sunlight = editorSection(
    "Sunlight guide",
    "Show the approximate day/night terminator and subsolar point for planning. This deterministic guide is not photorealistic lighting or a survey calculation."
  );
  const sunlightTime = document.createElement("input");
  sunlightTime.type = "datetime-local";
  sunlightTime.value = configuration.sunlight.dateTime.slice(0, 16);
  sunlightTime.addEventListener("change", () => {
    const parsed = new Date(`${sunlightTime.value}:00Z`);
    if (!Number.isFinite(parsed.getTime())) return;
    configuration.sunlight.dateTime = parsed.toISOString();
    syncSunlightGuide(state);
    context.render();
  });
  sunlight.append(
    checkField("Show sunlight guide", configuration.sunlight.enabled, (checked) => {
      configuration.sunlight.enabled = checked;
      syncSunlightGuide(state);
      setStatus(context, checked ? "Approximate sunlight guide shown." : "Sunlight guide hidden.");
      context.render();
    }),
    fieldWrap("UTC date and time", sunlightTime),
    sunlightFacts(state)
  );
  panel.append(sunlight);

  const provenance = editorSection(
    "Source and coverage",
    "The dates above are provider time-domain dates. Spatial pixel availability is not confirmed: a date does not prove a cloud-free or populated pixel at the current map location, and catalog or granule metadata is required for that confirmation."
  );
  provenance.classList.add("gis-history-provenance");
  provenance.append(compactKeyValues({
    "Provider": source.provider,
    "Source revision": source.sourceRevision,
    "Coverage statement": source.coverageMeaning,
    "Capability observed": source.capabilityObservedAt.slice(0, 10),
    "Access": "Anonymous provider request · no OpenGeo Studio credentials"
  }));
  const sourceLink = document.createElement("a");
  sourceLink.className = "gis-button gis-link-button";
  sourceLink.href = source.providerRecordUrl;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.textContent = "Open provider record";
  provenance.append(sourceLink, textElement("small", `${source.attribution}. Use is governed by the linked NASA data-use guidance.`));
  panel.append(provenance);
  return panel;
}

function changeHistoricalImagerySource(context, sourceId) {
  context.state.historyViewerSource = sourceId;
  if (sourceId === WAYBACK_SOURCE_ID) {
    stopHistoricalPlayback(context.state);
    context.state.historicalAvailabilityAbortController?.abort();
    context.render();
    if (!context.state.waybackReleases) void loadWaybackHistory(context);
    return;
  }
  const source = historicalImagerySource(sourceId);
  if (!source) return;
  const sunlight = structuredClone(context.state.historicalImagery.sunlight);
  stopHistoricalPlayback(context.state);
  context.state.historicalAvailabilityAbortController?.abort();
  context.state.historicalAvailability = reviewedHistoricalDates(sourceId);
  context.state.historicalAvailabilityStatus = "reviewed-capability-receipt";
  context.state.historicalAvailabilityMessage = "Showing the last reviewed provider time-domain dates. Visible pixels can still contain gaps or clouds.";
  context.state.historicalImagery = historicalImageryForProject({
    extensions: {historicalImagery: {
      enabled: false,
      sourceId,
      sourceRevision: source.sourceRevision,
      selection: {displayedDate: source.defaultDate, requestedDate: source.defaultDate, policy: "exact", reason: "exact"},
      sunlight
    }}
  });
  setStatus(context, `${source.title} selected. Choose View date to change the map.`);
  context.render();
}

async function loadWaybackHistory(context) {
  const {state} = context;
  if (state.waybackBusy) return;
  state.waybackBusy = true;
  state.waybackError = null;
  context.render();
  try {
    state.waybackReleases = await fetchWaybackReleases();
    state.waybackReleaseId ??= state.waybackReleases.at(-1)?.id;
  } catch {
    state.waybackError = "Wayback releases could not be loaded. Retry or open the provider viewer.";
  } finally {
    state.waybackBusy = false;
    context.render();
  }
}

function waybackHistoryPanel(context) {
  const {state} = context;
  const panel = panelShell();
  panel.classList.add("gis-history-panel");
  const intro = editorSection("Wayback imagery history", "Explore earlier World Imagery basemaps in Esri’s viewer at your current map location. Your Studio map stays in place.");
  intro.append(selectField("Imagery source to explore", WAYBACK_SOURCE_ID,
    [...reviewedHistoricalImagerySources().map(({sourceId, title}) => [sourceId, title]), [WAYBACK_SOURCE_ID, "Esri World Imagery Wayback"]],
    sourceId => changeHistoricalImagerySource(context, sourceId)));
  const releases = state.waybackReleases ?? [];
  const section = editorSection("Basemap releases", "Release dates describe when Esri published each basemap version. Image acquisition dates vary by location; a new release may contain no local change.");
  if (releases.length) {
    section.append(selectField("Wayback release date", state.waybackReleaseId,
      [...releases].reverse().map(r => [r.id, r.date]), id => {state.waybackReleaseId = id; context.render();}));
    const release = releases.find(r => r.id === state.waybackReleaseId) ?? releases.at(-1);
    const center = state.map?.getCenter?.();
    const open = document.createElement("a");
    open.className = "gis-button gis-link-button";
    open.href = waybackViewerUrl(release.id, {longitude: center?.lng ?? 0, latitude: center?.lat ?? 20, zoom: state.map?.getZoom?.() ?? 2});
    open.target = "_blank"; open.rel = "noopener noreferrer";
    open.textContent = "Open selected release in Wayback ↗";
    open.addEventListener("click", () => {
      const current = state.map?.getCenter?.();
      open.href = waybackViewerUrl(release.id, {longitude: current?.lng ?? 0, latitude: current?.lat ?? 20, zoom: state.map?.getZoom?.() ?? 2});
    });
    section.append(open);
    const record = document.createElement("a");
    record.href = `https://www.arcgis.com/home/item.html?id=${release.itemId}`;
    record.target = "_blank"; record.rel = "noopener noreferrer"; record.textContent = "Release metadata and terms ↗";
    section.append(record);
  }
  if (state.waybackError) section.append(textElement("p", state.waybackError));
  const refresh = actionButton(state.waybackBusy ? "Loading releases…" : "Refresh Wayback releases", () => void loadWaybackHistory(context));
  refresh.disabled = state.waybackBusy; section.append(refresh);
  if (!releases.length) {
    const open = document.createElement("a");
    open.href = "https://livingatlas.arcgis.com/wayback/"; open.target = "_blank"; open.rel = "noopener noreferrer"; open.textContent = "Open Wayback viewer ↗"; section.append(open);
  }
  const provenance = editorSection("Source and coverage", "Esri hosts the imagery. Embedded use in OpenGeo Studio requires applicable Esri rights; this option opens the provider viewer and does not download or archive imagery.");
  provenance.classList.add("gis-history-provenance");
  provenance.append(compactKeyValues({Provider: "Esri World Imagery Wayback", "Date meaning": "Basemap publication date; acquisition date varies by location", Access: "Provider-hosted viewer", Attribution: "Esri and its imagery providers; see the selected release for credits and terms"}));
  panel.append(intro, section, provenance);
  return panel;
}

function applyHistoricalImageryDate(context, requestedDate, policy = "exact", {target = "primary"} = {}) {
  const {state} = context;
  let selection;
  try {
    selection = resolveHistoricalSelection({requestedDate, availableDates: state.historicalAvailability, policy});
  } catch (error) {
    setStatus(context, `Historical date was not applied (${error?.code ?? "invalid_date"}).`);
    context.render();
    return false;
  }
  if (selection.status !== "resolved") {
    state.historicalAvailabilityMessage = `No ${policy} provider date resolves ${requestedDate}. The current imagery remains visible.`;
    setStatus(context, state.historicalAvailabilityMessage);
    context.render();
    return false;
  }
  if (target === "comparison") state.historicalImagery.comparison = selection;
  else state.historicalImagery.selection = selection;
  state.historicalImagery.enabled = true;
  state.historicalImagery.compareShowing = target;
  const source = historicalImagerySource(state.historicalImagery.sourceId);
  const basemap = historicalImageryBasemap({
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    selection
  });
  state.customBasemaps = [
    ...state.customBasemaps.filter(({kind}) => kind !== "temporal-raster"),
    basemap
  ];
  const switched = switchBasemap(context, basemap.basemapId);
  if (!switched) return false;
  const adjustment = selection.reason === "exact" ? "" : ` Requested ${selection.requestedDate}; ${selection.reason}.`;
  setStatus(context, `${source.title} for ${selection.displayedDate} displayed.${adjustment}`);
  context.render();
  return true;
}

function stepHistoricalImagery(context, step) {
  stopHistoricalPlayback(context.state);
  const {historicalAvailability: dates, historicalImagery: configuration} = context.state;
  const index = dates.indexOf(configuration.selection.displayedDate);
  const nextDate = dates[index + step];
  if (nextDate) applyHistoricalImageryDate(context, nextDate, "exact");
}

function toggleHistoricalPlayback(context) {
  const {state} = context;
  if (state.historicalPlaybackTimer) {
    stopHistoricalPlayback(state);
    setStatus(context, "Historical imagery playback paused.");
    context.render();
    return;
  }
  state.historicalPlaybackFrames = 0;
  const advance = () => {
    const dates = state.historicalAvailability;
    const current = dates.indexOf(state.historicalImagery.selection.displayedDate);
    if (current < 0 || current >= dates.length - 1
      || state.historicalPlaybackFrames >= HISTORICAL_IMAGERY_LIMITS.maximumPlaybackFrames) {
      stopHistoricalPlayback(state);
      setStatus(context, "Historical imagery playback reached its bounded end.");
      context.render();
      return;
    }
    state.historicalPlaybackFrames += 1;
    applyHistoricalImageryDate(context, dates[current + 1], "exact");
    state.historicalPlaybackTimer = setTimeout(advance, HISTORICAL_IMAGERY_LIMITS.minimumPlaybackIntervalMilliseconds);
  };
  state.historicalPlaybackTimer = setTimeout(advance, HISTORICAL_IMAGERY_LIMITS.minimumPlaybackIntervalMilliseconds);
  setStatus(context, "Historical imagery playback started at one reviewed frame per second.");
  context.render();
}

function stopHistoricalPlayback(state) {
  if (state.historicalPlaybackTimer) clearTimeout(state.historicalPlaybackTimer);
  state.historicalPlaybackTimer = null;
}

async function refreshHistoricalAvailability(context) {
  const {state} = context;
  if (state.historicalAvailabilityBusy) return;
  stopHistoricalPlayback(state);
  state.historicalAvailabilityAbortController?.abort();
  const controller = new AbortController();
  state.historicalAvailabilityAbortController = controller;
  state.historicalAvailabilityBusy = true;
  state.historicalAvailabilityStatus = "checking-provider";
  state.historicalAvailabilityMessage = "Checking the reviewed NASA time-domain endpoint with an anonymous bounded request…";
  context.render();
  const fallback = reviewedHistoricalDates(state.historicalImagery.sourceId);
  try {
    const result = await fetchHistoricalAvailability(state.historicalImagery.sourceId, {
      startDate: fallback[0],
      endDate: fallback.at(-1),
      signal: controller.signal
    });
    if (state.historicalAvailabilityAbortController !== controller) return;
    state.historicalAvailability = result.dates;
    state.historicalAvailabilityStatus = "live-provider-time-domain";
    state.historicalAvailabilityMessage = `${result.dates.length} provider dates checked at ${result.observedAt}. Spatial pixel availability is not confirmed.`;
    setStatus(context, "Historical imagery dates refreshed from NASA GIBS.");
  } catch (error) {
    if (controller.signal.aborted) return;
    state.historicalAvailability = fallback;
    state.historicalAvailabilityStatus = "reviewed-receipt-fallback";
    state.historicalAvailabilityMessage = `The provider check failed safely (${error?.code ?? "provider_unavailable"}). Reviewed dates remain available; their observation date is shown below.`;
    setStatus(context, "NASA GIBS availability could not be refreshed; reviewed dates retained.");
  } finally {
    if (state.historicalAvailabilityAbortController === controller) {
      state.historicalAvailabilityAbortController = null;
      state.historicalAvailabilityBusy = false;
      context.render();
    }
  }
}

function setHistoricalComparison(context, requestedDate) {
  const applied = applyHistoricalImageryDate(context, requestedDate, "nearest", {target: "comparison"});
  if (applied) {
    setStatus(context, `Comparison B saved and displayed for ${context.state.historicalImagery.comparison.displayedDate}.`);
    context.render();
  }
}

function showHistoricalComparison(context, target) {
  const selection = target === "comparison"
    ? context.state.historicalImagery.comparison
    : context.state.historicalImagery.selection;
  if (!selection) {
    setStatus(context, "Set comparison B before showing it.");
    context.render();
    return;
  }
  applyHistoricalImageryDate(context, selection.requestedDate, selection.policy, {target});
}

function sunlightFacts(state) {
  const center = state.map?.getCenter?.() ?? {lng: 0, lat: 0};
  try {
    const facts = solarElevationAt({
      longitude: Number(center.lng) || 0,
      latitude: Number(center.lat) || 0,
      dateTime: state.historicalImagery.sunlight.dateTime
    });
    return compactKeyValues({
      "Subsolar point": `${facts.subsolarLatitude.toFixed(2)}°, ${facts.subsolarLongitude.toFixed(2)}°`,
      "Sun at map center": `${facts.elevationDegrees.toFixed(1)}° elevation`,
      "Model": "Approximate solar position · visual guide"
    });
  } catch {
    return compactKeyValues({"Sunlight guide": "Unavailable for this time or map center"});
  }
}

function syncSunlightGuide(state) {
  const map = state.map;
  if (!map?.isStyleLoaded?.()) return;
  const sourceId = "opengeo-sunlight-source";
  const layerIds = ["opengeo-sunlight-terminator", "opengeo-sunlight-subsolar"];
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  if (!state.historicalImagery?.sunlight?.enabled || state.spatialBody.id !== "earth") return;
  map.addSource(sourceId, {
    type: "geojson",
    data: sunlightGuideGeojson(state.historicalImagery.sunlight.dateTime)
  });
  map.addLayer({
    id: layerIds[0],
    type: "line",
    source: sourceId,
    filter: ["==", ["get", "kind"], "terminator"],
    paint: {"line-color": "#fbbf24", "line-width": 2.5, "line-dasharray": [3, 2]}
  });
  map.addLayer({
    id: layerIds[1],
    type: "circle",
    source: sourceId,
    filter: ["==", ["get", "kind"], "subsolar-point"],
    paint: {"circle-color": "#fde047", "circle-radius": 7, "circle-stroke-color": "#713f12", "circle-stroke-width": 2}
  });
}

function controlsPanel(context) {
  const {state} = context;
  const panel = panelShell();
  panel.append(
    checkField("Identify features on click", state.identify, (checked) => {
      state.identify = checked;
      setStatus(context, checked ? "Identify enabled." : "Identify disabled.");
    }),
    checkField("Show graticule", state.graticule, (checked) => {
      state.graticule = checked;
      setStatus(context, checked ? "Graticule enabled." : "Graticule hidden.");
    }),
    checkField("Left layer panel", state.leftOpen, (checked) => {
      state.leftOpen = checked;
      context.render();
    }),
    checkField("Right inspector", state.rightOpen, (checked) => {
      state.rightOpen = checked;
      context.render();
    })
  );

  const measurementTools = editorSection(
    "Measurement tools",
    "Save line, path, polygon, and circle results with the map."
  );
  const measurementActions = document.createElement("div");
  measurementActions.className = "gis-icon-row";
  for (const kind of ["line", "path", "polygon", "circle"]) {
    const definition = measurementKindDefinition(kind);
    measurementActions.append(actionButton(definition.label, () => beginMeasurement(context, kind)));
  }
  if (state.measureMode) measurementActions.append(actionButton("Stop", () => stopMeasurement(context)));
  measurementTools.append(measurementActions);
  panel.append(measurementTools);

  panel.append(textElement("h3", "Plugin surfaces"));
  for (const [id, label, description] of PLUGINS) {
    const row = checkField(label, state.pluginState.has(id), () => togglePlugin(context, id));
    if (id === "time") {
      panel.append(actionButton("Open imagery history", () => openHistoricalImageryPanel(context)));
      continue;
    }
    row.append(textElement("small", description));
    panel.append(row);
  }
  return panel;
}

function measurementPanel(context) {
  const {state} = context;
  const panel = panelShell();
  const intro = editorSection(
    "Saved measurements",
    "Choose a geometry, click directly on the map, and save the result with this project. Calculations use the selected world's documented spherical mean-radius model. Path elevation samples are renderer observations, not survey data."
  );
  const startActions = document.createElement("div");
  startActions.className = "gis-icon-row gis-measurement-start-actions";
  for (const kind of ["line", "path", "polygon", "circle"]) {
    const definition = measurementKindDefinition(kind);
    const start = actionButton(definition.label, () => beginMeasurement(context, kind));
    start.classList.toggle("active", state.measureMode && state.measurementKind === kind);
    startActions.append(start);
  }
  startActions.append(actionButton("3D polygon", () => openPolygon3DMeasurementEditor(context)));
  if (state.measureMode) startActions.append(actionButton("Cancel", () => stopMeasurement(context)));
  intro.append(startActions);
  if (state.measurePoints.length) {
    intro.append(compactKeyValues({
      "Draft vertices": String(state.measurePoints.length),
      "Draft result": draftMeasurementFacts(state) ?? "Add another vertex"
    }));
  }
  panel.append(intro);

  if (!state.measurements.length) {
    panel.append(editorSection(
      "No saved measurements",
      "Saved line, path, polygon, and circle results appear here and reopen with this map. A terrain profile is available for paths when Earth terrain is active and loaded along the route."
    ));
    return panel;
  }

  for (const measurement of state.measurements) {
    const section = editorSection(measurement.title);
    section.classList.add("gis-measurement-card");
    section.dataset.measurementId = measurement.id;
    section.classList.toggle("active", state.selectedMeasurementId === measurement.id);
    if (measurement.kind === "path-profile") appendPathMeasurementSummary(section, measurement);
    else appendAreaMeasurementSummary(section, measurement);
    const actions = document.createElement("div");
    actions.className = "gis-icon-row";
    actions.append(
      actionButton("Zoom", () => zoomToMeasurement(context, measurement)),
      actionButton("Edit", () => editSavedMeasurement(context, measurement))
    );
    if (measurement.kind === "path-profile") {
      actions.append(actionButton("CSV", () => downloadMeasurementCsv(measurement)));
    }
    if (measurement.kind === "polygon-area") actions.append(actionButton("3D face…", () => openPolygon3DMeasurementEditor(context, null, measurement)));
    if (measurement.kind === "polygon-3d") actions.append(actionButton("GeoJSON", () => downloadBlob(`${slug(measurement.title)}-3d.geojson`, polygon3DGeojson(measurement), "application/geo+json")));
    actions.append(actionButton("Remove", () => removeMeasurement(context, measurement.id)));
    actions.lastElementChild.classList.add("danger");
    section.append(actions);
    panel.append(section);
  }
  return panel;
}

async function openPolygon3DMeasurementEditor(context, measurement=null, polygon=null) {
  if(!measurement&&context.state.measurements.length>=PATH_MEASUREMENT_LIMITS.maximumMeasurements)return setStatus(context,"Remove a measurement before adding another; this map holds at most 50.");
  const request=context.polygon3dEditorRequest=(context.polygon3dEditorRequest??0)+1;
  let Polygon3DMeasurementEditor;
  try {({Polygon3DMeasurementEditor}=await import("./Polygon3DMeasurementEditor.js"));}
  catch {if(!context.disposed&&request===context.polygon3dEditorRequest)setStatus(context,"The 3D polygon editor could not be loaded. Your map remains available.");return;}
  if(context.disposed||request!==context.polygon3dEditorRequest)return;
  context.polygon3dDialog?.dispose();let dialog;
  dialog=Polygon3DMeasurementEditor({measurement,polygon,spatialBody:context.state.spatialBody,
    onSave:record=>{
      if(context.disposed)throw Error("workbench_disposed");
      const index=measurement?context.state.measurements.findIndex(m=>m.id===measurement.id):-1;
      if(measurement&&index<0)throw Error("measurement_changed");
      if(index>=0)context.state.measurements.splice(index,1,record);else context.state.measurements.push(record);
      context.state.selectedMeasurementId=record.id;context.state.activePanel="measure";context.state.rightOpen=true;
      syncMeasureLayer(context.state);setStatus(context,`${record.title} saved with its 3D vertices and source. Save the Project to retain it.`);context.render();
    },onDownload:body=>downloadBlob(`${slug(measurement?.title??polygon?.title??"3d-polygon")}-3d.geojson`,body,"application/geo+json"),
    onClose:()=>{if(context.polygon3dDialog===dialog)context.polygon3dDialog=null;}});
  const palette=context.shell.ownerDocument.defaultView.getComputedStyle(context.shell);
  for(const [name,source] of [["--theme-foreground","--gis-ink"],["--theme-foreground-muted","--gis-muted"],["--theme-background","--gis-panel-bg"],["--theme-background-alt","--gis-elevated"],["--opengeo-line","--gis-line"]]){
    const value=palette.getPropertyValue(source);if(value.trim())dialog.style.setProperty(name,value);
  }
  context.polygon3dDialog=dialog;document.body.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.open=true;
  dialog.querySelector('[aria-label="Measurement title"]')?.focus();
}

function appendPathMeasurementSummary(section, measurement) {
  const profile = measurement.terrainProfile;
  const summary = profile.summary;
  const slope = measurementSlopeSummary(measurement);
  section.append(compactKeyValues({
    "Geometry": measurement.coordinates.length === 2 ? "Line" : "Path",
    "Path vertices": `${measurement.coordinates.length} vertices`,
    "2D path": formatMeasurementDistance(measurement.horizontalDistanceMeters),
    "Terrain path": summary.threeDimensionalDistanceMeters === null
      ? "Unavailable"
      : formatMeasurementDistance(summary.threeDimensionalDistanceMeters),
    "Elevation": summary.minimumElevationMeters === null
      ? profile.status === "partial" ? "Partial samples" : "Unavailable"
      : `${formatElevation(summary.minimumElevationMeters)} to ${formatElevation(summary.maximumElevationMeters)}`,
    "Ascent / descent": summary.ascentMeters === null
      ? "Unavailable"
      : `${formatElevation(summary.ascentMeters)} / ${formatElevation(summary.descentMeters)}`,
    "Maximum sampled slope": slope.status === "complete"
      ? `${formatGrade(slope.maximumAbsoluteGradePercent)} · ${slope.maximumSlopeDegrees.toFixed(1)}°`
      : "Unavailable",
    "Elevation accuracy": profile.status === "unavailable"
      ? "No samples"
      : "Provider accuracy not declared",
    "Model": `${measurement.measurementModel} · ${measurement.spatialBodyId}`,
    "Terrain source": profile.source
      ? `${profile.source.provider} · ${profile.source.queryMode}`
      : "No terrain samples saved"
  }));
  const chart = elevationProfileChart(measurement);
  if (chart) section.append(chart);
  if (measurement.coordinates.length === 2) section.append(ProfileLineOfSight(measurement, {
    onDownload: body => downloadBlob(`${slug(measurement.title)}-line-of-sight.json`, body, "application/json")
  }));
}

function appendAreaMeasurementSummary(section, measurement) {
  if(measurement.kind==="polygon-3d") {
    section.append(compactKeyValues({Geometry:"3D polygon face",Vertices:String(measurement.coordinates.length),
      "3D perimeter":formatMeasurementDistance(measurement.summary.perimeterMeters),"Face area":formatMeasurementArea(measurement.summary.areaSquareMeters),
      "Horizontal width":formatMeasurementDistance(measurement.summary.widthMeters),"Elevation range":formatElevation(measurement.summary.heightMeters),
      "Elevation source":measurement.source.label,"Vertical datum":measurement.source.verticalDatum,
      "Elevation uncertainty":measurement.uncertaintyMeters===null?"Not supplied":`± ${formatElevation(measurement.uncertaintyMeters)}`,
      "Model":`${measurement.measurementModel} · ${measurement.spatialBodyId}`}));
    return;
  }
  const facts = measurement.kind === "polygon-area"
    ? {
        "Geometry": "Polygon",
        "Vertices": String(measurement.coordinates.length),
        "Perimeter": formatMeasurementDistance(measurement.perimeterMeters),
        "Area": formatMeasurementArea(measurement.areaSquareMeters)
      }
    : {
        "Geometry": "Circle",
        "Radius": formatMeasurementDistance(measurement.radiusMeters),
        "Circumference": formatMeasurementDistance(measurement.circumferenceMeters),
        "Area": formatMeasurementArea(measurement.areaSquareMeters)
      };
  section.append(compactKeyValues({
    ...facts,
    "Model": `${measurement.measurementModel} · ${measurement.spatialBodyId}`
  }));
}

function elevationProfileChart(measurement) {
  const available = measurement.terrainProfile.samples.filter(({elevationMeters}) => Number.isFinite(elevationMeters));
  if (available.length < 2) return null;
  const width = 320;
  const height = 116;
  const inset = 12;
  const maximumDistance = measurement.horizontalDistanceMeters;
  const elevations = available.map(({elevationMeters}) => elevationMeters);
  const minimum = Math.min(...elevations);
  const maximum = Math.max(...elevations);
  const range = maximum - minimum || 1;
  const points = available.map(({distanceMeters, elevationMeters}) => {
    const x = inset + (width - inset * 2) * distanceMeters / maximumDistance;
    const y = height - inset - (height - inset * 2) * (elevationMeters - minimum) / range;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const figure = document.createElement("figure");
  figure.className = "gis-elevation-profile";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `${measurement.title} elevation profile from ${formatElevation(minimum)} to ${formatElevation(maximum)} over ${formatMeasurementDistance(maximumDistance)}`
  );
  const baseline = document.createElementNS(svg.namespaceURI, "path");
  baseline.setAttribute("d", `M ${inset} ${height - inset} H ${width - inset}`);
  baseline.classList.add("gis-elevation-axis");
  const polyline = document.createElementNS(svg.namespaceURI, "polyline");
  polyline.setAttribute("points", points);
  polyline.classList.add("gis-elevation-line");
  svg.append(baseline, polyline);
  figure.append(svg, textElement("figcaption", `${available.length} unexaggerated terrain samples · ${measurement.terrainProfile.status} profile`));
  return figure;
}

function rememberBrowserLayer(context, value) {
  context.browserCatalogPanel = null;
  context.browserRegistrations.set(value.layer.datasetId, structuredClone(value));
  context.browserCatalogNotice = writeBrowserLayerCatalog(browserLocalStorage(), context.browserRegistrations)
    ? "" : "The catalog could not be saved in this browser. These registrations remain available until reload; export important data.";
}

function browserLayerCatalogPanel(context) {
  if (context.browserCatalogPanel) return context.browserCatalogPanel;
  const panel = panelShell();
  panel.append(textElement("h3", "Layer catalog"), textElement("p", "Choose a Layer, review its source metadata, then add it to this Project. Demo records stay in your browser."));
  if (context.browserCatalogNotice) panel.append(textElement("p", context.browserCatalogNotice));
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "Search Layers"; search.setAttribute("aria-label", "Search Layers");
  search.value = context.state.browserCatalogSearch ?? "";
  const summary = textElement("p", ""); summary.setAttribute("role", "status");
  const clear = actionButton("Clear search", () => {search.value = ""; context.state.browserCatalogSearch = ""; render();});
  const list = document.createElement("div"); list.className = "browser-layer-catalog";
  const entries = [...context.browserCatalog, ...[...context.browserRegistrations].map(([id, value]) => ({id, title: value.layer.title, load: async () => value}))];
  const render = () => {
    list.replaceChildren();
    const matches = entries.filter(entry => entry.title.toLowerCase().includes(search.value.trim().toLowerCase()));
    summary.textContent = `${matches.length} of ${entries.length} Layers · review a source to add it to this map.`;
    clear.hidden = !search.value;
    for (const entry of matches) {
      const row = document.createElement("article"); row.append(textElement("strong", entry.title));
      row.dataset.browserCatalogLayer = entry.id;
      if (entry.description) row.append(textElement("p", entry.description));
      const facts = [entry.source?.license, entry.source?.attribution].filter(Boolean);
      if (facts.length) row.append(textElement("small", facts.join(" · ")));
      const status = textElement("p", ""); status.setAttribute("role", "status");
      const add = actionButton("Review and add", async () => {
        const reviewBrowserLayer = browserLayerReviewForProject(context);
        add.disabled = true; status.textContent = "Loading source metadata and preview data…";
        try {
          const candidate = await entry.load();
          const layer = structuredClone(candidate.layer); layer.visible = true;
          if (!candidate.kml) layer.layerId = `browser_${crypto.randomUUID()}`;
          if (context.browserCatalog.some(item => item.id === entry.id)) layer.browserCatalogId = entry.id;
          reviewBrowserLayer({layer, geojson: candidate.geojson, source: candidate.source ?? layer.metadata?.source ?? {}, onAdd: async (reviewed, data) => {
            if (candidate.kml) await importKmlPlaces(context, {name: reviewed.title}, candidate.kml, reviewed);
            else {
              context.addLayer(reviewed, data);
              if (context.browserRegistrations.has(entry.id)) rememberBrowserLayer(context, {...candidate, layer: reviewed, geojson: data});
            }
            fitLayer(context.state.map, reviewed, context.dataByLayerId);
            setStatus(context, `Added ${reviewed.title} from the catalog. Metadata remains with the Layer in this browser draft.`);
          }});
          status.textContent = "Source ready for review.";
        } catch {status.textContent = "This source could not load. Try again; your Project is unchanged.";}
        finally {add.disabled = false;}
      });
      add.setAttribute("aria-label", `Review and add ${entry.title}`);
      row.append(add, status); list.append(row);
    }
    if (!list.children.length) list.append(textElement("p", "No matching Layers. Add a local file or try another search."));
  };
  search.oninput = () => {context.state.browserCatalogSearch = search.value; render();}; render(); panel.append(search, clear, summary, list);
  if (!context.landingMode) panel.append(navLink("Browse example Catalog", "/?view=catalog"));
  panel.append(actionButton("Register a local source", () => {context.state.activePanel = "add"; context.render();}));
  context.browserCatalogPanel = panel;
  return panel;
}

function catalogPanel(context) {
  const {datasets, objects, layouts, jobs, state} = context;
  const panel = panelShell();
  if (context.publicDemo) return browserLayerCatalogPanel(context);
  if (context.landingMode) {
    panel.append(textElement("p", "This map is a browser draft. Its files are not uploaded or listed in your account catalog."),
      navLink("Open account catalog", directoryHref({view: "data"})));
    return panel;
  }
  if (context.projectSwitcher) {
    panel.append(
      textElement("p", "Data available to this Project. Open the Catalog to inspect and reuse Layers across Projects."),
      navLink("Browse catalog", directoryHref({view: "data", adapterKind: fixtureAdapterKind(context.persistenceMode)})),
      datasetDirectory(context)
    );
  } else {
    panel.append(textElement("p", "Browse the data and resources available to this workspace."));
    panel.append(compactKeyValues(context.publicDemo
    ? {
        "Access": "Anonymous public demo",
        "Persistence": "Browser only; daily reset",
        "Uploads": "None",
        "Private data": "Unavailable"
      }
    : {
        "Storage bucket": `s3://${context.storage.bucket}`,
        "Dev prefix": context.storage.prefix,
        "Project record": projectS3Uri(context),
        "Upload prefix": uploadS3Uri(context)
      }), workspaceDirectory(context), datasetDirectory(context));
  }
  panel.append(compactTable("Datasets", datasets.map((dataset) => ({
    name: dataset.title,
    type: dataset.datasetType,
    status: dataset.status
  }))));
  panel.append(compactTable("Objects", objects.map((object) => ({
    role: object.objectRole,
    type: object.contentType,
    size: formatBytes(object.sizeBytes)
  }))));
  panel.append(compactTable("Print layouts", layouts.map((layout) => ({
    title: layout.title,
    page: `${layout.pageSize} ${layout.orientation}`,
    class: layout.classification
  }))));
  panel.append(durableJobsSection(context));
  panel.append(compactTable("Processing jobs", catalogProcessingJobs(context).map((job) => ({
    job: job.jobType,
    engine: job.engine,
    status: job.status
  }))));
  return panel;
}

function durableJobsSection(context) {
  const section = editorSection(
    "Durable jobs",
    "Refresh the active layer's persisted copy and conversion requests. Completed and cancelled records remain visible after a browser reload."
  );
  section.classList.add("gis-durable-jobs");
  section.role = "region";
  const controls = document.createElement("div");
  controls.className = "gis-inline-actions";
  const refresh = actionButton(
    context.state.durableJobsBusy ? "Refreshing jobs…" : "Refresh jobs",
    () => void refreshDurableJobLists(context)
  );
  refresh.disabled = context.state.durableJobsBusy
    || context.state.durableJobActionPending !== null
    || typeof context.refreshDurableJobs !== "function";
  refresh.dataset.durableJobAction = "refresh";
  controls.append(refresh);
  section.append(controls);

  const feedback = textElement(
    "p",
    context.state.durableJobsMessage ?? "Jobs shown here are server records for the active eligible layer."
  );
  feedback.className = "gis-durable-jobs-feedback";
  feedback.role = "status";
  feedback.setAttribute("aria-live", "polite");
  section.append(feedback);

  const activeResources = activeDurableJobResources(context);
  const records = [
    ...context.protectedCopyJobs
      .filter(({sourceDatasetId}) => sourceDatasetId === activeResources.source?.datasetId)
      .map((job) => ({kind: "protected-copy", job})),
    ...context.pmtilesDerivativeJobs
      .filter(({datasetId, datasetVersionId}) => (
        datasetId === activeResources.dataset?.datasetId
        && datasetVersionId === activeResources.dataset?.currentVersionId
      ))
      .map((job) => ({kind: "pmtiles-derivative", job}))
  ];
  if (!records.length) {
    section.append(textElement("p", "No durable jobs were returned for the active layer."));
    return section;
  }
  const list = document.createElement("div");
  list.className = "gis-durable-job-list";
  for (const record of records) list.append(durableJobRow(context, record));
  section.append(list);
  return section;
}

function durableJobRow(context, {kind, job}) {
  const row = document.createElement("article");
  row.className = "gis-durable-job-row";
  row.dataset.jobId = job.jobId;
  const title = kind === "protected-copy" ? "Protected source copy" : "Vector to PMTiles";
  row.append(
    textElement("strong", title),
    textElement("span", `${job.state} · ${job.jobId}`)
  );
  if(kind==='pmtiles-derivative'&&job.options)row.append(textElement('p',`Zoom ${job.minZoom}–${job.maxZoom} · output ${job.sourceLayer} · ${pmtilesOptionsSummary(job.options)}`));
  if (durableJobCanCancel(context, kind, job)) {
    const cancel = actionButton(
      context.state.durableJobActionPending === job.jobId ? "Cancelling…" : "Cancel job",
      () => void cancelDurableJob(context, kind, job)
    );
    cancel.disabled = context.state.durableJobActionPending !== null || context.state.durableJobsBusy;
    cancel.dataset.durableJobAction = `cancel:${job.jobId}`;
    cancel.setAttribute("aria-label", `Cancel ${title.toLowerCase()} ${job.jobId}`);
    row.append(cancel);
  }
  if (kind === "pmtiles-derivative" && job.state === "completed"
    && context.canRequestProjectCompute && typeof context.reviewPmtilesDisplay === "function") {
    const review = actionButton("Review tiled display", () => void reviewCompletedPmtilesDisplay(context, job));
    review.disabled = Boolean(context.state.pmtilesDisplayReview?.busy);
    row.append(review);
    if (context.state.pmtilesDisplayReview?.jobId === job.jobId) row.append(pmtilesDisplayReviewForm(context, job));
  }
  return row;
}

function currentPmtilesReviewLayer(context, job, expected = null) {
  const layer = activeLayer(context), dataset = pmtilesJobDatasetForLayer(context.datasets.find(item => item.datasetId === job.datasetId), layer);
  if (context.disposed || !context.canRequestProjectCompute || !dataset
    || layer.datasetId !== job.datasetId || dataset.currentVersionId !== job.datasetVersionId
    || (layer.datasetVersionId && layer.datasetVersionId !== job.datasetVersionId)
    || (expected && (expected.layer !== layer || expected.identity !== persistedLayerSourceIdentity(layer)))) {
    throw Error("The selected Layer or saved dataset version changed. Review the completed job again.");
  }
  return {layer, dataset, identity: persistedLayerSourceIdentity(layer)};
}

async function reviewCompletedPmtilesDisplay(context, job) {
  if (context.state.pmtilesDisplayReview?.busy) return;
  const model = {jobId: job.jobId, busy: true, title: "", rightsBasis: "", attribution: "", acknowledgeConversionLimits: false};
  context.state.pmtilesDisplayReview = model;
  try {
    const target = currentPmtilesReviewLayer(context, job);
    model.target = target; model.title = target.layer.title;
    context.render();
    const review = await context.reviewPmtilesDisplay(job);
    currentPmtilesReviewLayer(context, job, target);
    if (context.state.pmtilesDisplayReview !== model) return;
    if (review.jobId !== job.jobId || review.datasetId !== job.datasetId || review.datasetVersionId !== job.datasetVersionId) throw Error("The display review belongs to another saved dataset version.");
    model.review = review;
  } catch (error) {model.error = error.message;}
  finally {model.busy = false;if (!context.disposed) context.render();}
}

function pmtilesDisplayReviewForm(context, job) {
  const model = context.state.pmtilesDisplayReview;
  const section = editorSection("Tiled display review", "Reviewing metadata reads no stored map bytes. Admission does not download tiles or change the original data.");
  if (model.busy) section.append(textElement("p", "Loading display review…"));
  if (model.error) section.append(textElement("p", model.error));
  const review = model.review;
  if (!review) return section;
  section.append(compactKeyValues({"Stored output": formatBytes(review.downloadBytes),
    "Zooms": `${review.minZoom}–${review.maxZoom}`, "Reported tile fragments": String(review.reportedFragmentCount ?? "Not established")}));
  section.append(textElement("p", "Tile fragments are not source records. Geometry is clipped, quantized and may be simplified for display; do not use it for measurement. Properties may change or be omitted, and source feature IDs are not preserved. Source-record preservation has not been verified."));
  if (!review.eligible) {section.append(textElement("p", "This output is not eligible for map display. The completed conversion and original data remain available."));return section;}
  if (model.admitted) {
    section.append(textElement("p", "Tiled display admitted. Choose it and acknowledge storage costs before downloading any tiles."));
    section.append(actionButton("Choose admitted tiled display", () => {
      try {
        const {layer, dataset} = currentPmtilesReviewLayer(context, job, model.target);
        layer.datasetVersionId = job.datasetVersionId; layer.sourceVersion = dataset.currentVersionNumber;
        layer.managedDisplayId = model.admitted.displayId; validateManagedDisplayReference(layer);
        context.state.archiveTileSessions.get(layer.layerId)?.dispose(); context.state.archiveTileSessions.delete(layer.layerId);
        context.dataByLayerId.delete(layer.layerId); removeMapLayer(context.state, layer.layerId);
        context.layerArchiveModes.delete(layer.layerId);
        context.layerArchiveControls.get(layer.layerId)?.dispose(); context.layerArchiveControls.delete(layer.layerId);
        setStatus(context, "Tiled display selected. Save the Project to retain this choice; acknowledge storage costs before downloading tiles.");
        context.render(); context.layerArchiveControls.get(layer.layerId)?.openSelection(model.admitted.displayId);
      } catch (error) {model.error = error.message;context.render();}
    }));
    return section;
  }
  const title = textInput("Tiled display title", model.title), rights = textAreaInput("Display rights basis", model.rightsBasis), attribution = textAreaInput("Display attribution", model.attribution);
  title.input.maxLength = 200; rights.input.maxLength = attribution.input.maxLength = 2000;
  for (const [field, key] of [[title, "title"], [rights, "rightsBasis"], [attribution, "attribution"]]) field.input.addEventListener("input", () => {model[key] = field.input.value;});
  const acknowledge = checkField("I reviewed the conversion limits; tile counts and feature IDs do not establish source-record preservation.", model.acknowledgeConversionLimits,
    checked => {model.acknowledgeConversionLimits = checked;});
  const admit = actionButton(model.busy ? "Admitting tiled display…" : "Admit tiled display", () => void (async () => {
    if (model.busy || typeof context.admitPmtilesDisplay !== "function") return;
    try {
      currentPmtilesReviewLayer(context, job, model.target);
      if (!model.title.trim() || !model.rightsBasis.trim() || !model.attribution.trim() || !model.acknowledgeConversionLimits) throw Error("Enter a title, rights basis and attribution, and acknowledge the conversion limits.");
      model.busy = true;model.error = null;context.render();
      const admitted = await context.admitPmtilesDisplay(job, {expectedReviewSha256: review.reviewSha256, title: model.title.trim(), rightsBasis: model.rightsBasis.trim(), attribution: model.attribution.trim(), acknowledgeConversionLimits: true});
      currentPmtilesReviewLayer(context, job, model.target);
      if (admitted.displayId !== job.jobId || admitted.datasetId !== job.datasetId || admitted.datasetVersionId !== job.datasetVersionId || admitted.reviewSha256 !== review.reviewSha256) throw Error("The admitted display does not match the reviewed output.");
      model.admitted = admitted;
    } catch (error) {model.error = error.message;}
    finally {model.busy = false;if (!context.disposed) context.render();}
  })());
  admit.disabled = model.busy || typeof context.admitPmtilesDisplay !== "function";
  section.append(title.wrapper, rights.wrapper, attribution.wrapper, acknowledge, admit);
  return section;
}

function durableJobCanCancel(context, kind, job) {
  if (!job?.cancellable) return false;
  if (kind === "protected-copy") {
    return typeof context.cancelProtectedCopy === "function"
      && context.sources.some((source) => (
        source.datasetId === job.sourceDatasetId
        && isProtectedCopySourceEligible(source)
      ));
  }
  const dataset = context.datasets.find(({datasetId}) => datasetId === job.datasetId);
  const layer = activeLayer(context);
  return typeof context.cancelPmtilesDerivative === "function"
    && context.canRequestProjectCompute
    && pmtilesJobDatasetForLayer(dataset, layer)?.currentVersionId === job.datasetVersionId;
}

async function refreshDurableJobLists(context) {
  if (context.state.durableJobsBusy || context.state.durableJobActionPending !== null
    || typeof context.refreshDurableJobs !== "function") return;
  const returnFocus = document.activeElement?.dataset?.durableJobAction ?? null;
  context.state.durableJobsBusy = true;
  context.state.durableJobsMessage = "Refreshing durable jobs from the server…";
  context.render();
  try {
    const result = await context.refreshDurableJobs(activeDurableJobResources(context));
    replaceArrayContents(context.protectedCopyJobs, result?.protectedCopyJobs ?? []);
    replaceArrayContents(context.pmtilesDerivativeJobs, result?.pmtilesDerivativeJobs ?? []);
    context.state.durableJobsMessage = result?.message
      ?? "Durable jobs refreshed from the server.";
  } catch {
    context.state.durableJobsMessage = "Durable jobs could not be refreshed. Existing records remain visible.";
  } finally {
    context.state.durableJobsBusy = false;
    context.render();
    restoreDurableJobFocus(context, returnFocus);
  }
}

async function cancelDurableJob(context, kind, job) {
  if (context.state.durableJobActionPending !== null || !durableJobCanCancel(context, kind, job)) return;
  const focusKey = `cancel:${job.jobId}`;
  context.state.durableJobActionPending = job.jobId;
  context.state.durableJobsMessage = `Cancelling durable job ${job.jobId}…`;
  context.render();
  try {
    let cancelled;
    if (kind === "protected-copy") {
      const source = context.sources.find(({datasetId}) => datasetId === job.sourceDatasetId);
      cancelled = await context.cancelProtectedCopy(source, job.jobId);
      replaceDurableJob(context.protectedCopyJobs, cancelled);
    } else {
      const dataset = activeDurableJobResources(context).dataset;
      cancelled = await context.cancelPmtilesDerivative(dataset, job.jobId);
      replaceDurableJob(context.pmtilesDerivativeJobs, cancelled);
    }
    context.state.durableJobsMessage = `Durable job ${job.jobId} is ${cancelled.state}.`;
  } catch (error) {
    context.state.durableJobsMessage = `Durable job was not cancelled (${error?.code ?? "request_failed"}).`;
  } finally {
    context.state.durableJobActionPending = null;
    context.render();
    restoreDurableJobFocus(context, focusKey, "refresh");
  }
}

function activeDurableJobResources(context) {
  const layer = activeLayer(context);
  const source = context.sources.find(({datasetId}) => datasetId === layer?.datasetId);
  const dataset = context.datasets.find(({datasetId}) => datasetId === layer?.datasetId);
  return {
    source: isProtectedCopySourceEligible(source) ? source : null,
    dataset: pmtilesJobDatasetForLayer(dataset, layer)
  };
}

export function isProtectedCopySourceEligible(source) {
  return Boolean(source)
    && ["wms", "pmtiles", "arcgis", "wfs"].includes(source.sourceType)
    && source.status === "active"
    && Number.isInteger(source.versionNumber)
    && source.versionNumber > 0;
}

function replaceDurableJob(jobs, replacement) {
  const index = jobs.findIndex(({jobId}) => jobId === replacement.jobId);
  if (index >= 0) jobs.splice(index, 1, replacement);
  else jobs.unshift(replacement);
}

function replaceArrayContents(target, values) {
  const replacements = Array.isArray(values) ? [...values] : [];
  target.splice(0, target.length, ...replacements);
}

function restoreDurableJobFocus(context, preferred, fallback = null) {
  queueMicrotask(() => {
    const key = preferred ?? fallback;
    const target = key
      ? context.shell.querySelector(`[data-durable-job-action="${key}"]`)
      : null;
    const fallbackTarget = fallback
      ? context.shell.querySelector(`[data-durable-job-action="${fallback}"]`)
      : null;
    (target instanceof HTMLElement ? target : fallbackTarget)?.focus({preventScroll: true});
  });
}

function catalogProcessingJobs(context) {
  const rows = [];
  const seen = new Set();
  const append = (job, defaults) => {
    const id = job.id ?? job.jobId ?? `${defaults.jobType}:${rows.length}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({
      ...job,
      jobType: job.jobType ?? defaults.jobType,
      engine: job.engine ?? defaults.engine,
      status: job.status ?? job.state ?? "unknown"
    });
  };
  for (const job of context.jobs) append(job, {jobType: "processing", engine: "worker"});
  for (const job of context.protectedCopyJobs) {
    append(job, {jobType: "protected-source-copy", engine: "isolated aws worker"});
  }
  for (const job of context.pmtilesDerivativeJobs) {
    append(job, {jobType: "vector-to-pmtiles", engine: "isolated aws worker"});
  }
  for (const job of context.state.runtimeJobs) {
    append(job, {jobType: "processing", engine: "isolated aws worker"});
  }
  return rows;
}

function workspaceDirectory(context) {
  const section = document.createElement("section");
  section.className = "gis-catalog-section";
  section.append(textElement("h3", "Workspace directory"));
  const list = document.createElement("div");
  list.className = "gis-card-list";

  for (const workspace of context.workspaces) {
    const item = document.createElement("a");
    item.href = context.publicDemo
      ? "/"
      : projectHref(workspace.workspaceId, {
          adapterKind: fixtureAdapterKind(context.persistenceMode)
        });
    item.className = "gis-catalog-card";
    item.classList.toggle("active", workspace.workspaceId === context.workspace?.workspaceId);
    const count = context.allDatasets.filter((dataset) => dataset.workspaceId === workspace.workspaceId).length;
    item.append(
      textElement("strong", workspace.title),
      textElement("span", workspace.description),
      textElement("small", `${count} datasets / ${workspace.classification}`)
    );
    list.append(item);
  }

  section.append(list);
  return section;
}

function datasetDirectory(context) {
  const section = document.createElement("section");
  section.className = "gis-catalog-section";
  section.append(textElement("h3", "Data catalog"));
  const list = document.createElement("div");
  list.className = "gis-catalog-list";
  const workspaceById = new Map(context.workspaces.map((workspace) => [workspace.workspaceId, workspace]));

  for (const dataset of context.allDatasets) {
    const item = document.createElement(context.publicDemo ? "div" : "a");
    if (!context.publicDemo) item.href = projectHref(
      dataset.workspaceId ?? context.workspace.workspaceId,
      {
        adapterKind: fixtureAdapterKind(context.persistenceMode),
        management: "data",
        datasetId: dataset.datasetId
      }
    );
    item.className = "gis-catalog-row";
    item.append(
      textElement("strong", dataset.title),
      textElement("span", workspaceById.get(dataset.workspaceId)?.title ?? dataset.workspaceId),
      textElement("small", [dataset.datasetType, dataset.geometryType, dataset.status].filter(Boolean).join(" / "))
    );
    list.append(item);
  }

  section.append(list);
  return section;
}

function sqlPanel(context) {
  const panel = panelShell();
  const layer = activeLayer(context);
  const geojson = context.dataByLayerId.get(layer?.layerId);
  const query = document.createElement("textarea");
  query.rows = 5;
  query.value = `select count(*) as features\nfrom ${slug(layer?.title ?? "active_layer")};`;
  const output = document.createElement("pre");
  output.className = "gis-sql-output";
  output.textContent = "Run a query to inspect the active layer.";
  panel.append(fieldWrap("DuckDB-style SQL", query), actionButton("Run browser query", () => {
    output.textContent = JSON.stringify({features: geojson?.features?.length ?? 0, layer: layer?.title ?? null}, null, 2);
  }), output);
  return panel;
}

function settingsPanel(context) {
  const panel = panelShell();
  if (context.localProjectRecord) {
    panel.append(textElement("h3", "Saved on this device"), textElement("p", context.demoSurface ? "This personal Project is independent of sample resets. Browser data can still be cleared or evicted; download a backup for important work." : "This Project is saved on this device. Browser data can be cleared or evicted; download a backup for important work."),
      compactKeyValues({"Project": context.localProjectRecord.title, "Saved revision": context.localProjectRecord.revision, "Account upload": "None"}),
      actionButton("Projects and backups on this device", () => void openPersonalProjects(context)), navLink("Open managed Studio", MANAGED_STUDIO_URL));
    return panel;
  }
  if (context.landingMode) {
    panel.append(textElement("h3", "Browser draft"),
      textElement("p", "Save in browser keeps this map on this device and browser profile. It is not an account save, and signing in does not upload it."),
      textElement("p", "Save keeps a personal Project in this device's library. Existing scratch drafts are retained until you deliberately save them as personal Projects. Browser storage can be cleared; download a backup for important work."),
      navLink("Open account projects", `${MANAGED_STUDIO_URL}workspaces`));
    return panel;
  }
  if (context.publicDemo) {
    panel.append(
      textElement("h3", "Public demo privacy"),
      textElement("p", "This workbench runs without authentication. The checked-in map is public and permissively licensed; files you open and changes you make remain in this browser."),
      compactKeyValues({
        "Account": "None",
        "Server upload": "Disabled",
        "Save": "Personal Projects on this device; no daily reset",
        "Older sample drafts": "Separate browser storage with daily expiry",
        "External sources": "Direct public HTTPS only",
        "Private workspaces": "Available after sign-in"
      }),
      actionButton("Reset demo now", () => resetPublicDemo(context)),
      actionButton("Open authenticated Studio", () => {
        location.href = MANAGED_STUDIO_URL;
      })
    );
    const retained = readBrowserDraft(draftStorageKey(context.workspace, true, context.draftScopeId));
    try {
      if (retained && JSON.parse(retained).demoDate !== demoDateKey()) panel.append(textElement("h3", "Earlier sample draft"),
        actionButton("Download earlier sample draft", () => downloadBlob("earlier-sample.opengeo-project.json", retained, "application/json")));
    } catch { /* Preserve invalid retained bytes for recovery from browser storage. */ }
    return panel;
  }
  panel.append(textElement("h3", context.project?.name ?? "Project"),
    textElement("p", `Access workspace: ${context.workspace?.title ?? "Not recorded"}. Shared data and permissions belong to this workspace.`));
  if (context.draftScopeId && readBrowserDraft(draftStorageKey(context.workspace)) != null) {
    panel.append(textElement("h3", "Older workspace draft"),
      textElement("p", "An older browser draft is retained, but its Project is not recorded. It has not been applied to this Project. Download it to inspect or keep a backup."),
      actionButton("Download older workspace draft", () => {
        const saved = readBrowserDraft(draftStorageKey(context.workspace));
        if (saved != null) downloadBlob("older-workspace-draft.json", saved, "application/json");
      }));
  }
  panel.append(
    textElement("h3", "AWS-backed workspace"),
    compactKeyValues({
      "Provider": context.storage.provider,
      "Bucket": context.storage.bucket,
      "Dev prefix": context.storage.prefix,
      "Project object": projectS3Uri(context),
      "Upload area": uploadS3Uri(context),
      "Project read": `GET /projects/${context.workspace?.workspaceId ?? "{projectId}"}`,
      "Map read": `GET /projects/${context.workspace?.workspaceId ?? "{projectId}"}/maps`,
      "Map write": "PATCH /projects/{projectId}/maps/{mapId}",
      "Upload request": "POST /projects/{projectId}/uploads/request",
      "Complete upload": "POST /projects/{projectId}/uploads/{uploadId}/complete",
      "Object URL": "GET /objects/{objectId}/signed-url",
      "Processing": "POST /processing/jobs"
    })
  );
  return panel;
}

function helpPanel(context) {
  const panel = panelShell();
  panel.append(
    textElement("h3", "OpenGeo Studio workbench"),
    textElement("p", context.publicDemo
      ? "This is the anonymous edition of the same browser-native GIS workbench used by Studio. Explore the map, style layers, inspect attributes, process public data, open local files, and exchange GeoLibre projects without signing in."
      : "This is a browser-native GIS workspace manager: JavaScript map controls, catalog records, layer styling, processing jobs, and AWS object storage instead of a traditional server/Python desktop stack."),
    compactKeyValues({
      "Add data": "Add Data menu or layer panel Add button",
      "Identify": "Toggle Identify, then click a feature",
      "Measure": "Measure, click along a path, then save it with an optional terrain profile",
      "Navigate globe": "Drag to pan; right-drag or Control-drag to orbit; wheel to zoom; two-finger pinch/rotate/pitch on touch; arrow and Shift+arrow keyboard controls",
      "Save": context.landingMode ? "Save in browser keeps this draft on this device; it does not save to your account" : context.publicDemo
        ? "Browser-only draft; resets daily"
        : "Save updates the selected map; Save As creates a separate map",
      "Persist": context.publicDemo
        ? "Open authenticated Studio to save governed team work"
        : "Server writes enforce tenant and role permissions before writing project and object records"
    })
  );
  return panel;
}

function createMap(adapter, container, savedView, projection, basemap = null, transformRequest = (url) => ({url, credentials: "omit"})) {
  const view = normalizeMapView(savedView);
  return adapter.createMap({
    container,
    style: basemapNetworkAllowed(basemap)
      && ["maplibre-style", "provider-style"].includes(basemap?.kind)
      && basemap.styleUrl
      ? basemap.styleUrl
      : emptyMapStyle(projection),
    center: view?.center ?? [0, 0],
    zoom: view?.zoom ?? 2,
    pitch: view?.pitch ?? 0,
    bearing: view?.bearing ?? 0,
    interactive: true,
    dragPan: true,
    dragRotate: true,
    scrollZoom: true,
    keyboard: true,
    touchZoomRotate: true,
    touchPitch: true,
    cooperativeGestures: false,
    preserveDrawingBuffer: true,
    canvasContextAttributes: {preserveDrawingBuffer: true},
    attributionControl: {compact: false},
    transformRequest
  });
}

function emptyMapStyle(projection = "mercator") {
  return {
    version: 8,
    sources: {},
    layers: [
      {id: "background", type: "background", paint: {"background-color": "#061526"}}
    ],
    projection: {type: normalizeProjection(projection)},
    sky: {
      "sky-color": "#061526",
      "horizon-color": "#dbeafe",
      "fog-color": "#93c5fd",
      "sky-horizon-blend": 0.45,
      "horizon-fog-blend": 0.35,
      "fog-ground-blend": 0.25,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 8, 0.7, 12, 0]
    }
  };
}

function visibleBasemap(project) {
  return project?.basemaps?.find((basemap) => basemap.visible)?.basemapId ?? "openfreemap-positron";
}

function savedBasemapOpacity(project) {
  const opacity=project?.basemaps?.find(basemap=>basemap.visible)?.opacity;
  return Number.isFinite(opacity)?Math.max(0,Math.min(1,opacity)):1;
}

function visibleProviderBinding(project) {
  const basemap = project?.basemaps?.find((candidate) => (
    candidate.visible && ["provider-style", "provider-raster"].includes(candidate.kind)
  ));
  return typeof basemap?.connectionBindingId === "string"
    ? basemap.connectionBindingId
    : null;
}

function basemapsForSave(context) {
  const basemap = activeBasemap(context);
  if (!basemap) return [];
  if (basemap.kind === "temporal-raster") {
    return [{
      basemapId: basemap.basemapId,
      title: basemap.title,
      kind: "temporal-raster",
      sourceId: basemap.sourceId,
      sourceRevision: basemap.sourceRevision,
      selection: structuredClone(basemap.selection),
      attribution: basemap.attribution,
      visible: true,
      opacity: context.state.basemapOpacity
    }];
  }
  if (["provider-style", "provider-raster"].includes(basemap.kind)) {
    return [{
      basemapId: basemap.basemapId,
      title: basemap.title,
      kind: basemap.kind,
      provider: basemap.provider,
      connectionBindingId: basemap.connectionBindingId,
      flavor: basemap.flavor,
      attribution: basemap.attribution,
      visible: true,
      opacity: context.state.basemapOpacity
    }];
  }
  if (basemap.kind === "governed-raster") {
    return [{
      basemapId: basemap.basemapId,
      title: basemap.title,
      kind: "governed-raster",
      datasetId: basemap.datasetId,
      sourceType: basemap.sourceType,
      sourceVersion: basemap.sourceVersion,
      sourceUrl: basemap.sourceUrl,
      sourceConfiguration: structuredClone(basemap.sourceConfiguration),
      attribution: basemap.attribution,
      visible: true,
      opacity: context.state.basemapOpacity
    }];
  }
  if (basemap.kind === "planetary-blank") {
    return [{
      basemapId: basemap.basemapId,
      title: basemap.title,
      kind: "planetary-blank",
      spatialBodyId: basemap.spatialBodyId,
      attribution: basemap.attribution,
      visible: true,
      opacity: context.state.basemapOpacity
    }];
  }
  return [{
    basemapId: basemap.basemapId,
    title: basemap.title,
    kind: basemap.kind,
    url: basemap.styleUrl ?? basemap.url ?? null,
    attribution: basemap.attribution ?? "Attribution supplied by the project",
    visible: true,
    opacity: context.state.basemapOpacity
  }];
}

function allBasemaps(context) {
  return applyBasemapGovernance([...BASEMAPS, ...(context.state.customBasemaps ?? [])]);
}

function projectBasemapChoices(project) {
  const knownIds = new Set(BASEMAPS.map(({basemapId}) => basemapId));
  return (project?.basemaps ?? []).flatMap((entry) => {
    if (!entry?.basemapId || knownIds.has(entry.basemapId)) return [];
    if (entry.kind === "temporal-raster") {
      try {
        return [historicalImageryBasemap({
          sourceId: entry.sourceId,
          sourceRevision: entry.sourceRevision,
          selection: entry.selection
        })];
      } catch {
        return [];
      }
    }
    if (["provider-style", "provider-raster"].includes(entry.kind)
      && ["protomaps", "carto"].includes(entry.provider)
      && typeof entry.connectionBindingId === "string"
      && (entry.provider === "protomaps"
        ? ["light", "dark", "white", "grayscale", "black"].includes(entry.flavor)
        : ["voyager", "positron", "dark-matter"].includes(entry.flavor))) {
      const providerName = entry.provider === "carto" ? "CARTO" : "Protomaps";
      return [{
        basemapId: entry.basemapId,
        title: entry.title ?? `${providerName} ${entry.flavor}`,
        section: "Project",
        kind: entry.kind,
        provider: entry.provider,
        connectionBindingId: entry.connectionBindingId,
        flavor: entry.flavor,
        description: "Resolved from this project's reusable basemap connection.",
        attribution: entry.attribution ?? `${providerName} · © OpenStreetMap contributors`
      }];
    }
    if (
      entry.kind === "governed-raster"
      && entry.sourceType === "xyz-raster"
      && typeof entry.datasetId === "string"
      && Number.isInteger(entry.sourceVersion)
      && typeof entry.sourceUrl === "string"
      && entry.sourceConfiguration?.presentationRole === "regional_basemap"
      && entry.sourceConfiguration?.coordinateBehavior === "wgs84_web_mercator"
    ) {
      const configuration = structuredClone(entry.sourceConfiguration);
      return [{
        basemapId: entry.basemapId,
        title: entry.title ?? "Regional basemap",
        section: "Regional",
        kind: "governed-raster",
        datasetId: entry.datasetId,
        sourceType: entry.sourceType,
        sourceVersion: entry.sourceVersion,
        sourceUrl: entry.sourceUrl,
        sourceConfiguration: configuration,
        url: entry.sourceUrl,
        tileSize: configuration.tileSize,
        scheme: configuration.scheme,
        minZoom: configuration.minZoom,
        maxZoom: configuration.maxZoom,
        description: `Restored from governed source revision ${entry.sourceVersion}.`,
        attribution: entry.attribution ?? configuration.attribution
      }];
    }
    if (entry.kind === "planetary-blank"
      && ["moon", "mars"].includes(entry.spatialBodyId)
      && entry.basemapId === `planetary-blank-${entry.spatialBodyId}`) {
      const body = spatialBodyDefinition(entry.spatialBodyId);
      return [{
        basemapId: entry.basemapId,
        title: entry.title ?? `Blank ${body.title} map`,
        section: body.title === "Moon" ? "The Moon" : body.title,
        kind: "planetary-blank",
        spatialBodyId: body.id,
        description: `${body.title} angular coordinates with no network imagery.`,
        attribution: entry.attribution ?? `No imagery · ${body.title} angular canvas`
      }];
    }
    const styleUrl = entry.kind === "maplibre-style" ? entry.styleUrl ?? entry.url : null;
    const rasterUrl = entry.kind === "raster" ? entry.url : null;
    if (!styleUrl && !rasterUrl && entry.kind !== "blank") return [];
    return [{
      basemapId: entry.basemapId,
      title: entry.title ?? "Project basemap",
      section: "Project",
      kind: entry.kind ?? (styleUrl ? "maplibre-style" : "raster"),
      description: "Restored from this map definition.",
      ...(styleUrl ? {styleUrl} : {}),
      ...(rasterUrl ? {url: rasterUrl} : {}),
      ...esriTileConfiguration(rasterUrl),
      attribution: entry.attribution ?? "Attribution supplied by the project"
    }];
  });
}

function activeBasemap(context) {
  return allBasemaps(context).find(({basemapId}) => basemapId === context.state.currentBasemapId)
    ?? BASEMAPS.find(({basemapId}) => basemapId === "openfreemap-positron");
}

function workbenchManagedSourceIds(state) {
  const managed = new Set([
    OPEN_TERRAIN_SOURCE.sourceId,
    OPEN_3D_SCENE_SOURCE.sourceId,
    "opengeo-authoring-source",
    "opengeo-query-drawing-source",
    "opengeo-query-result-source",
    "opengeo-measure-source",
    "opengeo-graticule-source",
    "opengeo-sunlight-source"
  ]);
  for (const handle of state.layerHandles.values()) {
    if (handle.sourceId) managed.add(handle.sourceId);
    for (const sourceId of handle.sourceIds ?? []) managed.add(sourceId);
  }
  return managed;
}

function runtimeSnapshotSignature(runtime) {
  return JSON.stringify({
    state: runtime.state,
    issueCounts: runtime.issueCounts,
    coverageIssues: runtime.coverageIssues,
    reason: runtime.reason
  });
}

function activeBasemapCoverageSources(context) {
  const {state} = context;
  if (!state.map || state.spatialBody.id !== "earth") return [];
  const style = state.map.getStyle?.();
  if (!style?.sources || !Array.isArray(style.layers)) return [];
  const managed = workbenchManagedSourceIds(state);
  for (const sourceId of state.basemapRuntimeManagedSourceIds ?? []) managed.add(sourceId);
  const sourceIds = new Set(
    style.layers
      .map((layer) => layer?.source)
      .filter((sourceId) => typeof sourceId === "string" && !managed.has(sourceId))
  );
  return [...sourceIds]
    .map((sourceId) => style.sources[sourceId])
    .filter(Boolean);
}

function mapViewportBounds(map) {
  const bounds = map?.getBounds?.();
  if (!bounds) return null;
  const west = bounds.getWest?.() ?? bounds._sw?.lng;
  const south = bounds.getSouth?.() ?? bounds._sw?.lat;
  const east = bounds.getEast?.() ?? bounds._ne?.lng;
  const north = bounds.getNorth?.() ?? bounds._ne?.lat;
  return [west, south, east, north].every(Number.isFinite)
    ? {west, south, east, north}
    : null;
}

function refreshBasemapCoverage(context) {
  const {state} = context;
  if (!state.map || state.basemapRuntimeSwitchPending) return;
  const before = state.basemapRuntimeHealth.snapshot();
  const issues = basemapCoverageIssues({
    zoom: state.map.getZoom?.(),
    viewportBounds: mapViewportBounds(state.map),
    sources: activeBasemapCoverageSources(context)
  });
  const after = state.basemapRuntimeHealth.recordCoverage(state.currentBasemapId, issues);
  if (runtimeSnapshotSignature(before) === runtimeSnapshotSignature(after)) return;
  setStatus(context, basemapRuntimeMessage({title: activeBasemap(context)?.title, runtime: after}));
  context.render();
}

function basemapRuntimeAlert(context) {
  const {state} = context;
  const runtime = state.basemapRuntimeHealth.snapshot();
  if (!["outage", "incomplete", "limited", "retained", "retrying"].includes(runtime.state)) return null;
  const basemap = activeBasemap(context);
  const alert = document.createElement("section");
  alert.className = "gis-basemap-runtime-alert";
  alert.dataset.runtimeState = runtime.state;
  alert.role = runtime.state === "outage" ? "alert" : "status";
  alert.ariaLive = "polite";
  const heading = runtime.state === "retrying"
    ? "Checking background"
    : runtime.state === "limited"
      ? "Background detail limit"
      : runtime.state === "incomplete"
        ? "Background partly available"
        : "Background incomplete";
  alert.append(
    textElement("strong", heading),
    textElement("p", basemapRuntimeMessage({title: basemap?.title, runtime}))
  );
  const details = basemapRuntimeIssueDetails(runtime);
  if (details.length) {
    const list = document.createElement("ul");
    list.className = "gis-basemap-runtime-details";
    for (const detail of details) list.append(textElement("li", detail));
    alert.append(list);
  }
  const actions = document.createElement("div");
  actions.className = "gis-basemap-runtime-actions";
  if (runtime.failureCount > 0 || ["outage", "retrying"].includes(runtime.state)) {
    const retry = actionButton(`Retry ${basemap?.title ?? "background"}`, () => retryActiveBasemap(context));
    retry.disabled = state.basemapActivationState === "loading" || runtime.state === "retrying";
    actions.append(retry);
  }
  if (["outage", "incomplete", "limited"].includes(runtime.state)) {
    actions.append(actionButton("Keep current", () => retainActiveBasemapAfterOutage(context)));
  }
  actions.append(actionButton("Change basemap", () => openBasemapChooser(context)));
  alert.append(actions);
  return alert;
}

function retainActiveBasemapAfterOutage(context) {
  const {state} = context;
  const runtime = state.basemapRuntimeHealth.retain(state.currentBasemapId);
  const message = basemapRuntimeMessage({title: activeBasemap(context)?.title, runtime});
  setStatus(context, message);
  context.render();
}

function retryActiveBasemap(context) {
  const {state} = context;
  const basemap = activeBasemap(context);
  if (!basemap || !basemapNetworkAllowed(basemap) || state.basemapActivationState === "loading") return;
  state.basemapRuntimeRecoveryPending = true;
  state.basemapRuntimeProbeInProgress = true;
  const runtime = state.basemapRuntimeHealth.retry(state.currentBasemapId);
  setStatus(context, basemapRuntimeMessage({title: basemap.title, runtime}));
  context.render();
  void selectBasemapChoice(context, basemap);
}

function installRasterBasemap(state, basemap) {
  const map = state.map;
  if (!map || !map.isStyleLoaded()) return;
  if (map.getLayer("basemap")) map.removeLayer("basemap");
  if (map.getSource("basemap")) map.removeSource("basemap");
  if (!basemapNetworkAllowed(basemap)
    || !["raster", "provider-raster", "governed-raster", "temporal-raster"].includes(basemap?.kind)
    || !basemap.url) return;
  map.addSource("basemap", {
    type: "raster",
    tiles: [basemap.url],
    tileSize: basemap.tileSize ?? 256,
    scheme: basemap.scheme ?? "xyz",
    minzoom: basemap.minZoom ?? 0,
    maxzoom: basemap.maxZoom ?? (basemap.provider === "carto" ? 20 : 22),
    attribution: basemap.attribution
  });
  map.addLayer({id: "basemap", type: "raster", source: "basemap", paint: {"raster-opacity": state.basemapOpacity}}, firstDataLayerId(map));
}

function canSwitchBasemap(context, basemap) {
  if (!basemap) return false;
  const {state} = context;
  const nextBody = spatialBodyForBasemap(basemap);
  if (nextBody.id !== state.spatialBody.id && (context.layers.length > 0 || state.measurements.length > 0)) {
    setStatus(
      context,
      `Start an empty ${nextBody.title} project before changing spatial body; existing ${state.spatialBody.title} layer and measurement coordinates were left unchanged.`
    );
    return false;
  }
  return true;
}

function switchBasemap(context, basemapId, {runtimeRecovery = false} = {}) {
  const {state} = context;
  const basemap = allBasemaps(context).find((candidate) => candidate.basemapId === basemapId);
  if (!canSwitchBasemap(context, basemap)) return false;
  const nextBody = spatialBodyForBasemap(basemap);
  state.basemapRuntimeManagedSourceIds = workbenchManagedSourceIds(state);
  state.basemapRuntimeSwitchPending = Boolean(state.map);
  state.basemapRuntimeHealth.begin(basemapId, {recovery: runtimeRecovery});
  state.currentBasemapId = basemapId;
  state.spatialBody = nextBody;
  if (nextBody.id !== "earth") {
    state.terrainEnabled = false;
    state.openScene3dEnabled = false;
  }
  updateProjectionPresentation(context);
  if (!state.map) {
    state.basemapRuntimeSwitchPending = false;
    state.basemapRuntimeManagedSourceIds = null;
    return true;
  }
  const map = state.map;
  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: basemap.pitch ?? map.getPitch(),
    bearing: map.getBearing()
  };
  for (const layer of context.layers) removeMapLayer(state, layer.layerId);
  state.layerHandles.clear();
  const switchRevision = ++state.basemapSwitchRevision;
  if (state.basemapRuntimeSwitchTimer) clearTimeout(state.basemapRuntimeSwitchTimer);
  state.basemapRuntimeSwitchTimer = setTimeout(() => {
    if (state.map !== map
      || state.basemapSwitchRevision !== switchRevision
      || !state.basemapRuntimeSwitchPending) return;
    const runtime = state.basemapRuntimeHealth.recordUnavailable(basemapId);
    state.basemapRuntimeSwitchTimer = null;
    const message = basemapRuntimeMessage({title: basemap.title, runtime});
    setStatus(context, message);
    context.render();
  }, BASEMAP_ACTIVATION_LIMITS.timeoutMilliseconds);
  let restorationScheduled = false;
  let restorationRetryTimer = null;
  const readyEvents = ["style.load", "idle"];
  const stopWaiting = () => {
    for (const eventName of readyEvents) map.off(eventName, handleStyleReady);
    if (restorationRetryTimer) clearTimeout(restorationRetryTimer);
    restorationRetryTimer = null;
  };
  const restoreComposition = () => {
    if (state.map !== map || state.basemapSwitchRevision !== switchRevision) {
      stopWaiting();
      return;
    }
    if (!map.isStyleLoaded()) {
      if (!restorationRetryTimer) {
        restorationRetryTimer = setTimeout(() => {
          restorationRetryTimer = null;
          restoreComposition();
        }, 16);
      }
      return;
    }
    stopWaiting();
    applyMapProjection(map, state.globe ? "globe" : "mercator");
    installRasterBasemap(state, basemap);
    captureBasemapOpacityLayers(state);
    setBasemapOpacity(state);
    if (state.terrainEnabled && state.globe) {
      applyOpenTerrain(map, true, {
        exaggeration: state.terrainExaggeration,
        activation: currentTerrainActivation(state)
      });
    }
    if (state.openScene3dEnabled && state.globe) {
      applyOpenScene3d(map, true, {
        globe: true,
        activation: currentOpenScene3dActivation(state)
      });
    }
    for (const layer of [...context.layers].reverse()) {
      addMapLayer(state, layer, context.dataByLayerId.get(layer.layerId), context.datasets);
    }
    syncMapAuthoringLayer(state);
    syncQueryGeometryLayer(state);
    syncQueryResultLayer(context, context.state.queryResult?.features ?? []);
    syncMeasureLayer(state);
    syncGraticule(state);
    syncSunlightGuide(state);
    syncTemporaryEditLayer(state, {styleReady: true});
    map.jumpTo(camera);
    state.basemapRuntimeSwitchPending = false;
    state.basemapRuntimeManagedSourceIds = null;
    if (state.basemapRuntimeSwitchTimer) clearTimeout(state.basemapRuntimeSwitchTimer);
    state.basemapRuntimeSwitchTimer = null;
    requestAnimationFrame(() => map.resize());
  };
  // Cached or equivalent styles may reach idle without a new style.load event.
  // Defer one task so MapLibre finishes replacing the outgoing style first.
  const handleStyleReady = () => {
    if (restorationScheduled) return;
    restorationScheduled = true;
    setTimeout(() => {
      restorationScheduled = false;
      restoreComposition();
    }, 0);
  };
  for (const eventName of readyEvents) map.on(eventName, handleStyleReady);
  map.setStyle(
    basemapNetworkAllowed(basemap)
      && ["maplibre-style", "provider-style"].includes(basemap.kind)
      && basemap.styleUrl
      ? basemap.styleUrl
      : emptyMapStyle(state.globe ? "globe" : "mercator")
  );
  return true;
}

function beginBasemapActivation(context, choice) {
  const {state} = context;
  state.cancelBasemapActivationProbe?.();
  const attempt = state.basemapActivationAttempt + 1;
  const current = activeBasemap(context);
  state.basemapActivationAttempt = attempt;
  state.basemapActivationState = "loading";
  state.basemapActivationCandidateId = choice.catalogId ?? choice.basemapId;
  state.basemapActivationCandidateTitle = choice.title ?? "Candidate basemap";
  state.basemapActivationFailureCode = null;
  state.basemapActivationRetryChoice = choice;
  state.basemapGovernanceSubjectId = null;
  state.basemapActivationMessage = `Checking ${state.basemapActivationCandidateTitle} for up to 8 seconds. ${current?.title ?? "The current map"} remains visible and remains the saved selection until the check passes.`;
  state.basemapCatalogMessage = state.basemapActivationMessage;
  setStatus(context, state.basemapActivationMessage);
  context.render();
  return attempt;
}

function failBasemapActivation(context, attempt, code) {
  const {state} = context;
  if (attempt !== state.basemapActivationAttempt) return;
  const message = basemapActivationFailureMessage({
    candidateTitle: state.basemapActivationCandidateTitle ?? "The candidate basemap",
    currentTitle: activeBasemap(context)?.title ?? "The current map",
    code
  });
  state.cancelBasemapActivationProbe = null;
  state.basemapActivationState = "failed";
  state.basemapActivationFailureCode = code;
  state.basemapActivationMessage = message;
  state.basemapCatalogMessage = message;
  if (state.basemapRuntimeRecoveryPending) {
    state.basemapRuntimeRecoveryPending = false;
    state.basemapRuntimeProbeInProgress = false;
    state.basemapRuntimeHealth.retryFailed(state.currentBasemapId);
  }
  setStatus(context, message);
  context.render();
}

function retainCurrentBasemap(context) {
  const {state} = context;
  state.cancelBasemapActivationProbe?.();
  state.basemapActivationAttempt += 1;
  state.basemapActivationState = "retained";
  state.basemapActivationCandidateId = null;
  state.basemapActivationCandidateTitle = null;
  state.basemapActivationFailureCode = null;
  state.basemapActivationRetryChoice = null;
  state.basemapGovernanceSubjectId = null;
  state.cancelBasemapActivationProbe = null;
  const message = `${activeBasemap(context)?.title ?? "The current map"} remains active. No basemap selection changed.`;
  state.basemapActivationMessage = message;
  state.basemapCatalogMessage = message;
  setStatus(context, message);
  context.render();
}

async function stageBasemapCandidate(context, candidate, attempt) {
  if (!basemapRequiresNetworkProbe(candidate)) return {ok: true, code: "network-free"};
  const {state} = context;
  const currentCenter = state.map?.getCenter?.()?.toArray?.() ?? [0, 0];
  const view = basemapProbeView(candidate, {
    center: currentCenter,
    zoom: state.map?.getZoom?.() ?? 2
  });
  const container = document.createElement("div");
  container.className = "gis-basemap-activation-probe";
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);

  return new Promise((resolve) => {
    let probe = null;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (state.cancelBasemapActivationProbe === cancel) {
        state.cancelBasemapActivationProbe = null;
      }
      try {
        context.rendererAdapter.disposeMap(probe);
      } catch {
        // A partially initialized renderer may already have released its resources.
      }
      container.remove();
      resolve(result);
    };
    const cancel = () => finish({ok: false, code: "superseded"});
    state.cancelBasemapActivationProbe = cancel;
    timer = setTimeout(
      () => finish({ok: false, code: "timeout"}),
      BASEMAP_ACTIVATION_LIMITS.timeoutMilliseconds
    );
    try {
      probe = context.rendererAdapter.createMap({
        container,
        style: basemapProbeStyle(candidate),
        center: view.center,
        zoom: view.zoom,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        transformRequest: context.esriBasemapSession.transformRequest
      });
      probe.on("error", (event) => {
        const issue = basemapRuntimeIssueFromError({event, style: probe?.getStyle?.()});
        if (basemapRuntimeIssueBlocksActivation(issue)) finish({ok: false, code: "render"});
      });
      probe.once("idle", () => {
        if (attempt !== state.basemapActivationAttempt) {
          finish({ok: false, code: "superseded"});
          return;
        }
        finish({ok: probe.isStyleLoaded(), code: probe.isStyleLoaded() ? "ready" : "render"});
      });
    } catch {
      finish({ok: false, code: "render"});
    }
  });
}

function commitBasemapActivation(context, attempt, candidate, originalChoice) {
  const {state} = context;
  if (attempt !== state.basemapActivationAttempt) return false;
  const previousCustomBasemaps = state.customBasemaps;
  if (!BASEMAPS.some(({basemapId}) => basemapId === candidate.basemapId)) {
    state.customBasemaps = [
      ...state.customBasemaps.filter(({basemapId}) => basemapId !== candidate.basemapId),
      candidate
    ];
  }
  const runtimeRecovery = state.basemapRuntimeRecoveryPending;
  if (!switchBasemap(context, candidate.basemapId, {runtimeRecovery})) {
    state.customBasemaps = previousCustomBasemaps;
    failBasemapActivation(context, attempt, "render");
    return false;
  }
  state.basemapRuntimeRecoveryPending = false;
  state.basemapRuntimeProbeInProgress = false;
  state.cancelBasemapActivationProbe = null;
  state.basemapActivationState = "active";
  state.basemapActivationCandidateId = originalChoice.catalogId ?? candidate.basemapId;
  state.basemapActivationCandidateTitle = candidate.title;
  state.basemapActivationFailureCode = null;
  state.basemapActivationRetryChoice = null;
  state.basemapGovernanceSubjectId = null;
  const message = `${candidate.title} is active. Save the map to keep this background.`;
  state.basemapActivationMessage = message;
  state.basemapCatalogMessage = message;
  setStatus(context, message);
  context.render();
  return true;
}

async function resolveConnectedBasemap(context, candidate) {
  const bindingId = candidate.bindingId ?? candidate.connectionBindingId;
  const flavor = candidate.flavor;
  const providerFlavors = candidate.provider === "carto"
    ? ["voyager", "positron", "dark-matter"]
    : ["light", "dark", "white", "grayscale", "black"];
  if (!["protomaps", "carto"].includes(candidate.provider)
    || typeof bindingId !== "string"
    || !providerFlavors.includes(flavor)
    || typeof context.resolveBasemapStyle !== "function"
    || context.state.basemapResolutionBusy) {
    setStatus(context, "This connected basemap cannot be resolved in the current project session.");
    return null;
  }
  context.state.basemapResolutionBusy = true;
  try {
    const resolved = await context.resolveBasemapStyle(bindingId, flavor);
    if (resolved.bindingId !== bindingId
      || resolved.provider !== candidate.provider
      || resolved.flavor !== flavor
      || resolved.browserKeyExposure !== "client_visible") {
      throw new Error("basemap_resolution_contract_mismatch");
    }
    const providerName = candidate.provider === "carto" ? "CARTO" : "Protomaps";
    const title = new RegExp(`^${providerName}\\b`).test(candidate.title ?? "")
      ? candidate.title
      : `${providerName} ${candidate.title ?? flavor}`;
    const values = {
      basemapId: candidate.basemapId,
      title,
      section: "Project",
      kind: resolved.resourceKind === "raster" ? "provider-raster" : "provider-style",
      provider: candidate.provider,
      connectionBindingId: bindingId,
      flavor,
      description: `${resolved.connectionName} · client-visible origin-restricted key`,
      ...(resolved.resourceKind === "raster"
        ? {url: resolved.resourceUrl}
        : {styleUrl: resolved.resourceUrl}),
      attribution: resolved.attribution,
      credentialRevision: resolved.credentialRevision
    };
    return values;
  } catch {
    return null;
  } finally {
    context.state.basemapResolutionBusy = false;
  }
}

function captureBasemapOpacityLayers(state) {
  const dataIds = new Set([...state.layerHandles.values()].flatMap(({layerIds}) => layerIds));
  state.basemapOpacityLayers = (state.map?.getStyle().layers ?? [])
    .filter(({id}) => !dataIds.has(id))
    .map(({id, type, paint = {}}) => ({
      id,
      type,
      values: Object.fromEntries(basemapOpacityProperties(type)
        .filter((property) => paint[property] !== undefined)
        .map((property) => [property, paint[property]]))
    }));
}

function basemapOpacityProperties(type) {
  return ({
    background: ["background-opacity"],
    fill: ["fill-opacity"],
    line: ["line-opacity"],
    circle: ["circle-opacity", "circle-stroke-opacity"],
    symbol: ["icon-opacity", "text-opacity"],
    raster: ["raster-opacity"],
    "fill-extrusion": ["fill-extrusion-opacity"],
    heatmap: ["heatmap-opacity"]
  })[type] ?? [];
}

function setBasemapOpacity(state) {
  const map = state.map;
  if (!map?.isStyleLoaded()) return;
  if (map.getLayer("basemap")) map.setPaintProperty("basemap", "raster-opacity", state.basemapOpacity);
  for (const layer of state.basemapOpacityLayers ?? []) {
    if (!map.getLayer(layer.id) || layer.id === "basemap") continue;
    for (const [property, original] of Object.entries(layer.values)) {
      if (typeof original === "number") map.setPaintProperty(layer.id, property, original * state.basemapOpacity);
    }
  }
}

function addRuntimeLayer(context) {
  const {state, layers, dataByLayerId, layer, geojson, datasets, panelAfterAdd = "style"} = context;
  layers.unshift(layer);
  layers.forEach((candidate, order) => candidate.order = order);
  if (geojson) dataByLayerId.set(layer.layerId, geojson);
  context.shell.__opengeoLayers = layers;
  context.shell.__opengeoData = dataByLayerId;
  const map = state.map;
  if (map) {
    try {
      addMapLayer(state, layer, geojson, datasets);
      syncLayerOrder(context);
    } catch (error) {
      if (error?.message !== "Style is not done loading.") throw error;
      map.once("style.load", () => {
        if (state.map !== map || !layers.includes(layer) || map.getSource(sourceId(layer))) return;
        addMapLayer(state, layer, geojson, datasets);
        syncLayerOrder(context);
      });
    }
  }
  state.activeLayerId = layer.layerId;
  state.activePanel = panelAfterAdd;
  context.render();
  if (layer.sourceType === "geojson-archive" && !geojson) {
    void loadPersistedDatasetLayers(context);
  }
  if (layer.sourceType === "external-feature-reference" && !geojson) {
    void loadLiveExternalFeatureLayer(context, layer, {announce: true});
  }
}

function bindLayerInteraction(state, map, layer, mapLayerId, datasets) {
  const click = event => {
    if (!state.identify || state.measureMode || state.mapAuthoring || state.queryDrawing) return;
    if (layer.sourceType === "kml-places") return state.onKmlFeatureClick?.(layer, event);
    state.activeLayerId = layer.layerId;
    if (!isGovernedDatasetLayer(layer)) showFeaturePopup(map, event, datasets.find(dataset => dataset.datasetId === layer.datasetId));
  };
  const mouseenter = () => map.getCanvas().style.cursor = state.mapAuthoring || state.queryDrawing ? "crosshair" : state.identify ? "pointer" : "";
  const mouseleave = () => map.getCanvas().style.cursor = state.mapAuthoring || state.queryDrawing ? "crosshair" : "";
  return [["click",click],["mouseenter",mouseenter],["mouseleave",mouseleave]].map(([type, handler]) => {
    map.on(type, mapLayerId, handler); return {type, mapLayerId, handler};
  });
}

export function addMapLayer(state, layer, geojson, datasets) {
  const map = state.map;
  if (!map || state.layerHandles.has(layer.layerId)) return;
  if (layer.sourceType === "cog-raster") {
    if (workbenchRenderer(map).id !== "maplibre") {
      state.rendererLayerIssues ??= new Map(); state.rendererLayerIssues.set(layer.layerId, "Referenced COG preview currently uses MapLibre. The Layer is preserved."); return;
    }
    try {
      if (layer.styleReference) {
        state.rendererLayerIssues ??= new Map();
        state.rendererLayerIssues.set(layer.layerId, "The saved Style reference is preserved; this raster preview does not apply vector Styles.");
      } else state.rendererLayerIssues?.delete(layer.layerId);
      const id = `${layer.layerId}-cog`;
      const session = installCogMapLayer(map, {sourceId: sourceId(layer), layerId: id,
        source: {sourceUrl: layer.sourceUrl, configuration: layer.sourceConfiguration}, opacity: layer.opacity ?? 1, visible: layer.visible,
        displayOptions: cogDisplayOptions(layer),
        onStatus: message => map.fire("cogstatus", {message: `${layer.title}: ${message}`}),
        onReady: () => map.fire("coglayerready")});
      state.layerHandles.set(layer.layerId, {sourceId: sourceId(layer), layerIds: [id], paintLayerIds: [id], cog: session});
      if (layer.visible) void session.refresh().catch(() => {});
    } catch (error) {state.rendererLayerIssues ??= new Map(); state.rendererLayerIssues.set(layer.layerId, error.message);}
    return;
  }
  if (layer.styleReference && !state.resolvedLayerStyles?.has(layer.layerId)) return;
  if (workbenchRenderer(map).id === "mapbox") {
    const report = mapboxCompatibility({layers:[layer],state:{archiveTileSessions:state.archiveTileSessions,mapFontSession:state.mapFontSession},allowPendingFonts:true});
    if (!report.ready) {
      state.rendererLayerIssues ??= new Map();
      state.rendererLayerIssues.set(layer.layerId, report.issues[0].message);
      return;
    }
  }
  state.rendererLayerIssues?.delete(layer.layerId);
  const clustering = pointClusteringOptions(layer);
  if (clustering.enabled) {
    const issue = pointClusteringIssue(layer, geojson, {archive: state.archiveTileSessions?.has(layer.layerId), renderer: workbenchRenderer(map).id});
    if (issue) {state.rendererLayerIssues ??= new Map();state.rendererLayerIssues.set(layer.layerId, issue);return;}
  }

  let inlinePointImages = [];
  try {
    inlinePointImages = !layer.styleReference && pointSymbolStyleParts(layer).length ? pointSymbolImages(layer.style) : [];
  } catch (error) {
    if (error?.message !== "Point symbol assets have not been loaded" || typeof state.preparePointSymbols !== "function") throw error;
    if (layer.visible !== false) state.preparePointSymbols(layer);
    return;
  }
  for (const image of inlinePointImages) {
    if (!map.hasImage(image.id)) map.addImage(image.id, image.pixels, {pixelRatio: image.pixelRatio});
  }

  const archive = state.archiveTileSessions?.get(layer.layerId);
  if (archive) {
    if (archive.source.stats().closed) return;
    state.pmtilesReady = registerArchiveProtocols(workbenchRenderer(map));
    const ranges = archive.layerRanges ?? archive.record.tile_layers.map(item => ({
      sourceLayer: item.source_layer, minZoom: archive.record.min_zoom, maxZoom: archive.record.max_zoom
    }));
    const sourceGroups = new Map(), sourcesByLayer = new Map(), sourceIds = [];
    for (const range of ranges) {
      const key = `${range.minZoom}/${range.maxZoom}`;
      if (!sourceGroups.has(key)) {
        const id = sourceIds.length ? `${sourceId(layer)}-detail-${sourceIds.length}` : sourceId(layer);
        const url = archive.layerRanges ? `${archive.url}?source_layer=${encodeURIComponent(range.sourceLayer)}` : archive.url;
        map.addSource(id, {type: "vector", url, attribution: archive.record.attribution});
        sourceGroups.set(key, id); sourceIds.push(id);
      }
      sourcesByLayer.set(range.sourceLayer, sourceGroups.get(key));
    }
    const layerIds = [];
    const baseFilters={};
    if(archive.raster){
      const id=`${sourceId(layer)}-overview`, overview=archive.raster.review;
      map.addSource(id,{type:'raster',tiles:[archive.url.replace('tiles.json','overview/{z}/{x}/{y}')],
        tileSize:overview.tile_size,minzoom:overview.min_zoom,maxzoom:overview.max_zoom,
        bounds:[archive.header.minLon,archive.header.minLat,archive.header.maxLon,archive.header.maxLat],
        attribution:archive.record.attribution});
      map.addLayer({id,type:'raster',source:id,minzoom:overview.min_zoom,maxzoom:overview.vector_min_zoom,
        layout:{visibility:layer.visible&&!layer.filter?'visible':'none'},
        paint:{'raster-opacity':layer.opacity??1,'raster-resampling':'nearest','raster-fade-duration':0}},firstSymbolLayerId(map));
      sourceIds.push(id);layerIds.push(id);
    }
    for (const [index, item] of archive.record.tile_layers.entries()) {
      const presentation = {...layer, layerId: `${layer.layerId}-archive-${index}`, geometryType: item.geometry_type};
      for (const paintLayer of archivePaintLayers(paintForLayer(presentation, null), archive.overview, item.source_layer)) {
        baseFilters[paintLayer.id]=paintLayer.filter??null;
        map.addLayer({...paintLayer, ...mapFilterOptions(paintLayer.filter,layer.filter), source: sourcesByLayer.get(item.source_layer), "source-layer": item.source_layer,
          ...(archive.raster ? {minzoom: Math.max(paintLayer.minzoom ?? 0, archive.raster.review.vector_min_zoom)} : {}),
          layout: {...paintLayer.layout, visibility: layer.visible ? "visible" : "none"}}, firstSymbolLayerId(map));
        layerIds.push(paintLayer.id);
      }
    }
    state.layerHandles.set(layer.layerId, {sourceId: sourceId(layer), sourceIds, layerIds, paintLayerIds: layerIds,
      imageIds: inlinePointImages.map(image => image.id), baseFilters, overviewFiltered:Boolean(layer.filter), rasterOverviewId: archive.raster ? `${sourceId(layer)}-overview` : null});
    return;
  }

  if (layer.sourceType === "pmtiles-vector" && layer.sourceUrl) {
    state.pmtilesReady = registerArchiveProtocols(workbenchRenderer(map));
    const sourceUrl = layer.sourceUrl.startsWith("pmtiles://") ? layer.sourceUrl : `pmtiles://${layer.sourceUrl}`;
    map.addSource(sourceId(layer), {type: "vector", url: sourceUrl});
    const paintLayers = paintForLayer(layer, geojson);
    const layerIds = [];
    for (const paintLayer of paintLayers) {
      map.addLayer({
        ...paintLayer,
        ...mapFilterOptions(paintLayer.filter,layer.filter),
        source: sourceId(layer),
        "source-layer": layer.sourceLayer,
        layout: {...paintLayer.layout, visibility: layer.visible ? "visible" : "none"}
      }, firstSymbolLayerId(map));
      layerIds.push(paintLayer.id);
    }
    state.layerHandles.set(layer.layerId, {
      sourceId: sourceId(layer),
      layerIds,
      paintLayerIds: paintLayers.map((paintLayer) => paintLayer.id),
      imageIds: inlinePointImages.map(image => image.id),
      baseFilters:Object.fromEntries(paintLayers.map(p=>[p.id,p.filter??null]))
    });
    return;
  }

  if (layer.sourceType === "pmtiles-raster" && layer.sourceUrl) {
    state.pmtilesReady = registerArchiveProtocols(workbenchRenderer(map));
    const sourceUrl = layer.sourceUrl.startsWith("pmtiles://") ? layer.sourceUrl : `pmtiles://${layer.sourceUrl}`;
    map.addSource(sourceId(layer), {
      type: "raster",
      url: sourceUrl,
      ...(layer.attribution ? {attribution: layer.attribution} : {}),
      ...(Number.isInteger(layer.minZoom) ? {minzoom: layer.minZoom} : {}),
      ...(Number.isInteger(layer.maxZoom) ? {maxzoom: layer.maxZoom} : {})
    });
    const layerId = `${layer.layerId}-raster`;
    map.addLayer({id: layerId, type: "raster", source: sourceId(layer), layout: {visibility: layer.visible ? "visible" : "none"}, paint: {"raster-opacity": layer.opacity ?? 1}});
    state.layerHandles.set(layer.layerId, {sourceId: sourceId(layer), layerIds: [layerId], paintLayerIds: [layerId]});
    return;
  }

  if (["xyz-raster", "wms-raster", "imageserver-raster", "mapserver-raster"].includes(layer.sourceType) && layer.tileUrl) {
    map.addSource(sourceId(layer), {
      type: "raster",
      tiles: [layer.sourceType === "imageserver-raster" ? normalizeImageServerTileUrl(layer.tileUrl) : layer.tileUrl],
      tileSize: layer.tileSize ?? 256,
      ...(layer.scheme ? {scheme: layer.scheme} : {}),
      ...(layer.attribution ? {attribution: layer.attribution} : {}),
      ...(Number.isInteger(layer.minZoom) ? {minzoom: layer.minZoom} : {}),
      ...(Number.isInteger(layer.maxZoom) ? {maxzoom: layer.maxZoom} : {})
    });
    map.addLayer({id: `${layer.layerId}-raster`, type: "raster", source: sourceId(layer), layout: {visibility: layer.visible ? "visible" : "none"}, paint: {"raster-opacity": layer.opacity ?? 1}});
    state.layerHandles.set(layer.layerId, {sourceId: sourceId(layer), layerIds: [`${layer.layerId}-raster`], paintLayerIds: [`${layer.layerId}-raster`]});
    return;
  }

  if (!geojson) return;
  const dataSourceId = sourceId(layer);
  const boundStyle = state.resolvedLayerStyles?.get(layer.layerId);
  const originalPaintLayers = layer.styleReference ? referencedStylePaint(boundStyle, layer) : paintForLayer(layer, geojson);
  const clusterParts = clustering.enabled ? pointClusterParts(layer) : [];
  const paintLayers = clustering.enabled ? [...originalPaintLayers.map(part => ({...part, filter: unclusteredPointFilter(part.filter)})), ...clusterParts] : originalPaintLayers;
  if (workbenchRenderer(map).id === "mapbox") {
    const report = mapboxCompatibility({style:{layers:paintLayers}});
    if (!report.ready) {
      state.rendererLayerIssues ??= new Map();
      state.rendererLayerIssues.set(layer.layerId, report.issues[0].message);
      return;
    }
  }
  if (!map.getSource(dataSourceId)) map.addSource(dataSourceId, {type: "geojson", data: clustering.enabled ? pointClusterData(layer, geojson) : geojson,
    ...(clustering.enabled ? {cluster: true, clusterRadius: clustering.radius, clusterMaxZoom: clustering.maxZoom, maxzoom: Math.max(18, clustering.maxZoom + 1)} : {})});
  for (const image of boundStyle?.images ?? []) {
    if (!map.hasImage(image.id)) map.addImage(image.id, image.pixels, {pixelRatio: image.pixelRatio});
  }
  let labelLayer = layer.styleReference ? null : labelForLayer(layer, state.mapFontSession, geojson);
  if (labelLayer && clustering.enabled) labelLayer = {...labelLayer, filter: unclusteredPointFilter(labelLayer.filter)};
  const layerIds = [];
  const mapEventHandlers = [];

  for (const paintLayer of paintLayers) {
    map.addLayer({...paintLayer, ...mapFilterOptions(paintLayer.filter,clustering.enabled ? null : layer.filter), source: dataSourceId,
      layout: {...paintLayer.layout, visibility: layer.visible ? "visible" : "none"}});
    layerIds.push(paintLayer.id);
    if (!clusterParts.some(part => part.id === paintLayer.id)) mapEventHandlers.push(...bindLayerInteraction(state, map, layer, paintLayer.id, datasets));
  }

  if (labelLayer && layer.labels?.enabled) {
    map.addLayer({...labelLayer, ...mapFilterOptions(labelLayer.filter,clustering.enabled ? null : layer.filter), source: dataSourceId, layout: {...labelLayer.layout, visibility: layer.visible ? "visible" : "none"}});
    layerIds.push(labelLayer.id);
  }

  const clusterImageIds = [];
  const clusterCleanup = clustering.enabled ? installPointClusterCountImages(map, clusterImageIds) : null;
  if (clustering.enabled) {
    const click = async event => {
      if (state.measureMode || state.mapAuthoring || state.queryDrawing || state.temporaryEdit) return;
      const feature = event.features?.[0], count = feature?.properties?.point_count;
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(feature.properties.cluster_id)) return;
      state.activeLayerId = layer.layerId;
      map.fire("pointcluster", {message: `${layer.title}: ${count.toLocaleString()} points grouped for display. Zooming in.`});
      try {
        const source = map.getSource(dataSourceId), zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id);
        if (state.map === map && map.getSource(dataSourceId) === source) map.easeTo({center: feature.geometry.coordinates, zoom: Math.min(24, zoom)});
      } catch { /* A removed or replaced source must not move the new map. */ }
    };
    const enter = () => {map.getCanvas().style.cursor = "pointer";}, leave = () => {map.getCanvas().style.cursor = "";};
    for (const [type, handler] of [["click", click], ["mouseenter", enter], ["mouseleave", leave]]) {
      map.on(type, clusterParts[0].id, handler);mapEventHandlers.push({type, mapLayerId: clusterParts[0].id, handler});
    }
  }
  const overlays = layer.sourceType === "kml-places" ? addKmlImageOverlays(state, layer, geojson) : {layerIds: [], sourceIds: [], elements: [], presentations: []};
  state.layerHandles.set(layer.layerId, {
    sourceId: dataSourceId,
    sourceIds: [dataSourceId, ...overlays.sourceIds],
    layerIds: [...layerIds, ...overlays.layerIds],
    paintLayerIds: paintLayers.map((paintLayer) => paintLayer.id),
    baseFilters:Object.fromEntries([...paintLayers,...(labelLayer?[labelLayer]:[])].map(p=>[p.id,p.filter??null])),
    boundStyle,
    imageIds: clusterImageIds,
    clusterLayerIds: clusterParts.map(part => part.id), clusterCleanup,
    clustered: clustering.enabled,
    opacityMode: layer.opacityMode ?? "feature",
    compositePaint: layer.opacityMode === "composite" ? Object.fromEntries(paintLayers.map(part => [part.id, part.paint])) : null,
    fillOpacityFactor: layer.style?.fillOpacityFactor ?? 0.45,
    labelLayerId: labelLayer?.id,
    layerVisible: layer.visible !== false,
    kmlGeojson: layer.sourceType === "kml-places" ? geojson : null,
    kmlDocument: layer.sourceType === "kml-places" ? layer.kmlDocument ?? (layer.layerId === "kml-places" ? state.kmlPlaces : null) : null,
    overlayElements: overlays.elements,
    overlayPresentations: overlays.presentations,
    mapEventHandlers
  });
  clusterImageIds.push(...[...(boundStyle?.images ?? []), ...inlinePointImages].map(image => image.id));
  if (layer.sourceType === "kml-places") refreshKmlRegionPresentation(state);
}

export function cogDisplayEditor(context, layer) {
  const section = editorSection("Raster display", "Refresh reads the current map area. Apply a range, then save the Project to keep its appearance.");
  const session = context.state.layerHandles.get(layer.layerId)?.cog;
  const current = cogDisplayOptions(layer);
  const message = textElement("p", ""); message.setAttribute("role", "status");
  let apply, busy = false;
  const refresh = actionButton("Refresh raster window", () => void read());
  const cancel = actionButton("Cancel raster read", () => {
    session?.cancel();
    message.textContent = "Raster read cancelled. The previous view and display settings are preserved.";
    setBusy(false);
  });
  cancel.disabled = !session?.loading;
  function setBusy(value) {busy = value; refresh.disabled = value; cancel.disabled = !value; if (apply) apply.disabled = value;}
  async function read(display = cogDisplayOptions(layer), persist = false) {
    if (busy) return;
    setBusy(true); message.textContent = "Reading raster window…";
    try {
      const result = await refreshCogWindow(context, layer, display);
      if (result && session?.result === result && context.layers.includes(layer)) {
        if (persist) {
          layer.style = {...layer.style, cogDisplay: structuredClone(display)};
          setStatus(context, "Raster display updated. Save the Project to keep these settings.");
          context.render();
        }
        message.textContent = "Raster view ready.";
      } else if (message.textContent === "Reading raster window…") {
        message.textContent = layer.visible ? "Raster view unchanged. Review the map status and try again." : "Show this Layer before refreshing its raster window.";
      }
    } finally {setBusy(false);}
  }
  section.append(refresh, cancel);
  if (layer.sourceConfiguration?.bands?.length === 1) {
    const form = document.createElement("form");
    const inputs = ["Display minimum", "Display maximum", "Transparent value (optional)"].map((name, index) => {
      const input = document.createElement("input"); input.type = "number"; input.step = "any";
      input.required = index < 2; input.setAttribute("aria-label", name);
      input.value = [current.displayRange?.minimum, current.displayRange?.maximum, current.noDataValue][index] ?? "";
      form.append(fieldWrap(name, input)); return input;
    });
    form.append(textElement("p", "Values outside the range use black or white. Missing values remain transparent."));
    apply = actionButton("Apply display range", () => {}); apply.type = "submit"; form.append(apply);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const display = {displayRange: {minimum: inputs[0].valueAsNumber, maximum: inputs[1].valueAsNumber},
        noDataValue: inputs[2].value === "" ? null : inputs[2].valueAsNumber};
      try {cogDisplayOptions({...layer, style: {...layer.style, cogDisplay: display}});}
      catch (error) {message.textContent = error.message; return;}
      void read(display, true);
    });
    section.append(form);
  }
  section.append(message);
  if(context.state.spatialBody?.id==="earth"&&session) {
    if(context.rasterViewshed?.session!==session){context.rasterViewshed?.view.dispose();let view;
      view=RasterViewshed({getGrid:()=>session.grid,initialObserver:()=>context.state.map.getCenter().toArray(),
        pickObserver:callback=>{if(context.state.temporaryEdit||context.state.queryDrawing||context.state.mapAuthoring||context.state.measureMode){setStatus(context,"Finish or cancel the current drawing before choosing an observer.");return false;}
          context.rasterObserverPick={root:view,callback};return true;},clearPick:()=>{if(context.rasterObserverPick?.root===view)context.rasterObserverPick=null;},
        onDownload:body=>downloadBlob(`${slug(layer.title)}-viewshed.geojson`,body,"application/geo+json"),
        onAdd:data=>{addProcessingOutputLayer(context,layer,"viewshed",data,`${layer.title} viewshed`,{
          renderer:"graduated",fill:"#16a34a",stroke:"#334155",strokeWidth:.5,
          graduated:{field:"visibility_code",breaks:[.5,1.5,2.5,3.5],colors:data.opengeo.legend.map(row=>row.color),noDataColor:"#9ca3af",noDataLabel:"Unknown"}});
          setStatus(context,"Viewshed added as a temporary processing Layer. Download its GeoJSON to retain the full analytical record.");}});
      context.rasterViewshed={session,view};
    }
    context.rasterViewshed.view.updateSource();section.append(context.rasterViewshed.view);
  }
  return section;
}

async function refreshCogWindow(context, layer, display = cogDisplayOptions(layer)) {
  const {state} = context, session = state.layerHandles.get(layer?.layerId)?.cog;
  if (!session || !layer.visible) return setStatus(context, "Show the referenced COG in MapLibre before refreshing its raster window.");
  const bounds = state.map.getBounds();
  return session.refresh([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], display).catch(() => null);
}

function addKmlImageOverlays(state, layer, geojson) {
  const map = state.map;
  const document = layer.kmlDocument ?? (layer.layerId === "kml-places" ? state.kmlPlaces : null);
  const resources = new Map((document?.resources ?? []).map((resource) => [resource.path, resource]));
  const overlays = collectKmlOverlays(document);
  const layerIds = [];
  const sourceIds = [];
  const elements = [];
  const presentations = [];
  for (const item of overlays.sort((left, right) => left.overlay.drawOrder - right.overlay.drawOrder)) {
    const {overlay, regions, visible} = item;
    const resource = resources.get(overlay.icon?.href);
    if (!resource) continue;
    const dataUrl = `data:${resource.mediaType};base64,${resource.dataBase64}`;
    const colorOpacity = kmlColorOpacity(overlay.color);
    const baseOpacity = colorOpacity * (layer.opacity ?? 1);
    if (overlay.kind === "ground-overlay") {
      const feature = geojson.features.find(({id}) => id === overlay.id);
      const ring = feature?.geometry?.type === "Polygon" ? feature.geometry.coordinates?.[0] : null;
      if (!ring || ring.length < 4) continue;
      const overlaySourceId = `${sourceId(layer)}-image-${mapSafeId(overlay.id)}`;
      const overlayLayerId = `${layer.layerId}-image-${mapSafeId(overlay.id)}`;
      map.addSource(overlaySourceId, {type: "image", url: dataUrl, coordinates: ring.slice(0, 4)});
      map.addLayer({
        id: overlayLayerId,
        type: "raster",
        source: overlaySourceId,
        layout: {visibility: visible ? "visible" : "none"},
        paint: {"raster-opacity": baseOpacity, "raster-fade-duration": 0}
      }, map.getLayer(`${layer.layerId}-polygons`) ? `${layer.layerId}-polygons` : undefined);
      sourceIds.push(overlaySourceId);
      layerIds.push(overlayLayerId);
      presentations.push({kind: overlay.kind, overlayId: overlay.id, layerId: overlayLayerId, regions, visible, colorOpacity, baseOpacity});
      continue;
    }
    if (overlay.kind === "screen-overlay") {
      const image = document.createElement("img");
      image.className = "gis-kml-screen-overlay";
      image.dataset.overlayId = overlay.id;
      image.alt = overlay.name;
      image.src = dataUrl;
      image.style.cssText = screenOverlayCss(overlay, baseOpacity);
      map.getContainer().append(image);
      elements.push(image);
      presentations.push({kind: overlay.kind, overlayId: overlay.id, element: image, regions, visible, colorOpacity, baseOpacity});
    }
  }
  return {layerIds, sourceIds, elements, presentations};
}

function collectKmlOverlays(document) {
  const output = [];
  const visit = (children, regions, visible) => {
    for (const child of children ?? []) {
      const activeRegions = child.region ? [...regions, child.region] : regions;
      const activeVisible = visible && child.visibility !== false;
      if (String(child.kind).endsWith("-overlay")) output.push({overlay: child, regions: activeRegions, visible: activeVisible});
      if (child.kind === "folder") visit(child.children, activeRegions, activeVisible);
    }
  };
  visit(document?.children, document?.region ? [document.region] : [], document?.visibility !== false);
  return output;
}

export function refreshKmlRegionPresentation(state) {
  const map = state.map;
  if (!map) return;
  let inactive = 0, faded = 0;
  for (const [layerId, handle] of state.layerHandles) {
    const document = handle.kmlDocument ?? (layerId === "kml-places" ? state.kmlPlaces : null);
    if (!document) continue;
    const geojson = handle.kmlGeojson ? structuredClone(handle.kmlGeojson) : placesToGeojson(document);
    for (const feature of geojson.features) {
      const presentation = combinedKmlRegionPresentation(map, feature.properties.kmlRegions ?? []);
      feature.properties.kmlRegionActive = presentation.active;
      feature.properties.kmlRegionOpacity = presentation.opacity;
    }
    inactive += geojson.features.filter(({properties}) => properties.kmlRegionActive === false).length;
    faded += geojson.features.filter(({properties}) => properties.kmlRegionOpacity < 1).length;
    map.getSource(handle.sourceId)?.setData?.(geojson);
    for (const overlay of handle.overlayPresentations ?? []) {
      const presentation = combinedKmlRegionPresentation(map, overlay.regions);
      const active = handle.layerVisible !== false && overlay.visible && presentation.active;
      if (overlay.layerId && map.getLayer(overlay.layerId)) {
        map.setLayoutProperty(overlay.layerId, "visibility", active ? "visible" : "none");
        map.setPaintProperty(overlay.layerId, "raster-opacity", overlay.baseOpacity * presentation.opacity);
      }
      if (overlay.element) {
        overlay.element.hidden = !active;
        overlay.element.style.opacity = String(overlay.baseOpacity * presentation.opacity);
      }
    }
  }
  map.getContainer().dataset.kmlRegionInactive = String(inactive);
  map.getContainer().dataset.kmlRegionFaded = String(faded);
}

function combinedKmlRegionPresentation(map, regions) {
  let opacity = 1;
  for (const region of regions ?? []) {
    const current = kmlRegionLodPresentation(region, projectedRegionExtent(map, region));
    if (!current.active) return {active: false, opacity: 0};
    opacity = Math.min(opacity, current.opacity);
  }
  return {active: true, opacity};
}

function projectedRegionExtent(map, region) {
  const {north, south, east, west} = region.box;
  const westPoint = map.project([west, (north + south) / 2]);
  const eastPoint = map.project([east, (north + south) / 2]);
  let width = Math.abs(eastPoint.x - westPoint.x);
  if (east < west) {
    const worldWidth = Math.abs(map.project([180, 0]).x - map.project([-180, 0]).x);
    if (Number.isFinite(worldWidth) && worldWidth > 0) width = Math.max(0, worldWidth - width);
  }
  const northPoint = map.project([(west + east) / 2, north]);
  const southPoint = map.project([(west + east) / 2, south]);
  return Math.max(width, Math.abs(northPoint.y - southPoint.y));
}

function screenOverlayCss(overlay, opacity) {
  const position = (axis, value, units) => {
    if (units === "fraction") return `${axis}:${value * 100}%`;
    if (units === "insetPixels") return `${axis === "left" ? "right" : "top"}:${value}px`;
    return `${axis}:${value}px`;
  };
  const dimension = (axis, value, units) => {
    if (value === -1 || value === 0) return `${axis}:auto`;
    if (units === "fraction") return `${axis}:${value * 100}%`;
    if (units === "insetPixels") return `${axis}:calc(100% - ${value}px)`;
    return `${axis}:${value}px`;
  };
  const anchor = (value, units, sign) => units === "fraction" ? `${sign * value * 100}%` : `${sign * value}px`;
  return [
    "position:absolute", "pointer-events:none", `z-index:${100 + overlay.drawOrder}`,
    position("left", overlay.screenXY.x, overlay.screenXY.xunits),
    position("bottom", overlay.screenXY.y, overlay.screenXY.yunits),
    dimension("width", overlay.size.x, overlay.size.xunits),
    dimension("height", overlay.size.y, overlay.size.yunits),
    `transform:translate(${anchor(overlay.overlayXY.x, overlay.overlayXY.xunits, -1)},${anchor(overlay.overlayXY.y, overlay.overlayXY.yunits, 1)}) rotate(${-overlay.rotation}deg)`,
    `transform-origin:${overlay.rotationXY.x * 100}% ${(1 - overlay.rotationXY.y) * 100}%`,
    `opacity:${opacity}`,
    "max-width:100%", "max-height:100%"
  ].join(";");
}

function kmlColorOpacity(color) {
  return /^[0-9a-fA-F]{8}$/.test(color ?? "") ? Number.parseInt(color.slice(0, 2), 16) / 255 : 1;
}

function mapSafeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
}

function paintForLayer(layer, geojson) {
  if (validateOpacityMode(layer) !== "composite") return featurePaintForLayer(layer, geojson);
  return featurePaintForLayer({...layer, opacity: 1}, geojson).map(part => ({...part,
    paint: opacityPaint(part.type, part.paint, layer.opacity ?? 1, "composite")}));
}

function featurePaintForLayer(layer, geojson) {
  if (layer.geometryType === "GeometryCollection" && ["gpx", "ozi"].includes(layer.metadata?.source?.format)) {
    return ["Point", "LineString"].flatMap(type => featurePaintForLayer({...layer, geometryType: type}, geojson)
      .map(part => ({...part, id: `${part.id}-${type}`, filter: part.filter
        ? ["all", part.filter, ["==", ["geometry-type"], type]] : ["==", ["geometry-type"], type]})));
  }
  if (layer.sourceType === "kml-places") {
    return [
      {
        id: `${layer.layerId}-polygons`,
        type: "fill",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!=", ["get", "visibility"], false], ["!=", ["get", "kmlRegionActive"], false]],
        paint: {
          "fill-color": ["coalesce", ["get", "kmlColor"], layer.style?.fill ?? "#f59e0b"],
          "fill-opacity": ["*", ["coalesce", ["get", "kmlOpacity"], 0.35], ["coalesce", ["get", "kmlRegionOpacity"], 1], layer.opacity ?? 1],
          "fill-outline-color": ["coalesce", ["get", "kmlColor"], layer.style?.stroke ?? "#f59e0b"]
        }
      },
      {
        id: `${layer.layerId}-lines`,
        type: "line",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["!=", ["get", "visibility"], false], ["!=", ["get", "kmlRegionActive"], false]],
        paint: {
          "line-color": ["coalesce", ["get", "kmlColor"], layer.style?.stroke ?? "#f59e0b"],
          "line-width": ["coalesce", ["get", "kmlWidth"], layer.style?.strokeWidth ?? 3],
          "line-opacity": ["*", ["coalesce", ["get", "kmlOpacity"], 1], ["coalesce", ["get", "kmlRegionOpacity"], 1], layer.opacity ?? 1]
        }
      },
      {
        id: `${layer.layerId}-points`,
        type: "circle",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "visibility"], false], ["!=", ["get", "kmlRegionActive"], false]],
        paint: {
          "circle-radius": ["*", ["coalesce", ["get", "kmlScale"], 1], layer.style?.circleRadius ?? 6],
          "circle-color": ["coalesce", ["get", "kmlColor"], layer.style?.circleColor ?? "#fbbf24"],
          "circle-opacity": ["*", ["coalesce", ["get", "kmlOpacity"], 1], ["coalesce", ["get", "kmlRegionOpacity"], 1], layer.opacity ?? 1],
          "circle-stroke-color": "#451a03",
          "circle-stroke-width": 1.25
        }
      }
    ];
  }
  if (layer.geometryType === "Point" || layer.geometryType === "MultiPoint") {
    const useStatus = (layer.style?.renderer ?? (hasStatusField(geojson) ? "status" : "single")) === "status";
    const useCategory = layer.style?.renderer === "category";
    const useGraduated = layer.style?.renderer === "graduated";
    const color = useGraduated
      ? graduatedColorForLayer(layer, layer.style?.circleColor ?? "#f97316")
      : useStatus
      ? ["match", ["get", "status"], "verified", "#16a34a", "needs review", "#f59e0b", "draft", "#64748b", layer.style?.circleColor ?? "#f97316"]
      : useCategory
        ? categoryColorExpression(layer, geojson, layer.style?.circleColor ?? "#f97316")
      : layer.style?.circleColor ?? "#f97316";
    return [{
      id: `${layer.layerId}-points`,
      type: "circle",
      paint: {
        "circle-radius": layer.style?.circleRadius ?? 6,
        "circle-color": color,
        "circle-opacity": layer.opacity ?? 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.25
      }
    }, ...pointSymbolStyleParts(layer).map(part => ({...part, id: `${layer.layerId}-${part.id}`,
      paint: {"icon-opacity": (part.paint["icon-opacity"] ?? 1) * (layer.opacity ?? 1)}}))];
  }

  if (layer.geometryType === "Polygon" || layer.geometryType === "MultiPolygon") {
    const fill = layer.style?.renderer === "graduated"
      ? graduatedColorForLayer(layer, layer.style?.fill ?? "#22c55e")
      : layer.style?.renderer === "category"
      ? categoryColorExpression(layer, geojson, layer.style?.fill ?? "#22c55e")
      : layer.style?.fill ?? "#22c55e";
    if (layer.style?.polygonMode === "line") {
      return [{
        id: `${layer.layerId}-outline`,
        type: "line",
        paint: {
          "line-color": fill,
          "line-width": layer.style?.strokeWidth ?? 2,
          "line-opacity": layer.opacity ?? 1
        }
      }];
    }
    return [
      {
        id: `${layer.layerId}-fill`,
        type: "fill",
        paint: {
          "fill-color": fill,
          "fill-opacity": (layer.opacity ?? 1) * (layer.style?.fillOpacityFactor ?? 0.45)
        }
      },
      {
        id: `${layer.layerId}-outline`,
        type: "line",
        paint: {"line-color": layer.style?.stroke ?? "#15803d", "line-width": layer.style?.strokeWidth ?? 2, "line-opacity": layer.opacity ?? 1}
      }
    ];
  }

  const lineColor = layer.style?.renderer === "graduated"
    ? graduatedColorForLayer(layer, layer.style?.stroke ?? "#2563eb")
    : layer.style?.renderer === "category"
    ? categoryColorExpression(layer, geojson, layer.style?.stroke ?? "#2563eb")
    : layer.style?.stroke ?? "#2563eb";
  return [{
    id: `${layer.layerId}-lines`,
    type: "line",
    paint: {"line-color": lineColor, "line-width": layer.style?.strokeWidth ?? 3, "line-opacity": layer.opacity ?? 1}
  }];
}

function labelForLayer(layer, fonts = null, geojson = null) {
  const field = layer.labels?.field;
  if (!field) return null;
  if (layer.labels?.fontRef && !fonts?.canRender(layer, geojson)) return null;
  if (!layer.labels?.fontRef && fonts?.usesPinnedGlyphRoot) return null;
  const prefix = layer.labels?.prefix ?? "";
  const suffix = layer.labels?.suffix ?? "";
  return {
    id: `${layer.layerId}-labels`,
    type: "symbol",
    layout: {
      ...(layer.labels?.fontRef ? {"text-font": [fonts.fontStack]} : {}),
      "text-field": prefix || suffix
        ? ["concat", prefix, ["to-string", ["get", field]], suffix]
        : ["to-string", ["get", field]],
      "text-size": layer.labels?.size ?? 12,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-allow-overlap": layer.labels?.allowOverlap === true
    },
    paint: {
      "text-color": layer.labels?.color ?? "#111827",
      "text-halo-color": layer.labels?.haloColor ?? "#ffffff",
      "text-halo-width": layer.labels?.haloWidth ?? 1.2
    }
  };
}

function setLayerVisible(context, layer, visible) {
  layer.visible = visible;
  if(context.rendererAdapter.id === "cesium") {context.state.map.setLayerVisibility(layer.layerId,visible);return;}
  if (visible && ["governed-dataset", "geojson-archive"].includes(layer.sourceType)
    && !context.dataByLayerId.has(layer.layerId)) {
    void loadPersistedDatasetLayers(context);
  }
  // Resolve the blank-map glyph root before showing newly visible labels.
  // Hidden legacy labels must never appear under a pinned font's root.
  syncPinnedMapFonts(context);
  if (layer.sourceType === "external-feature-reference") {
    if (!visible) cancelLiveFeatureLayer(context, layer);
    else if (!context.dataByLayerId.has(layer.layerId)) {
      void loadLiveExternalFeatureLayer(context, layer, {announce: true});
    }
  }
  if (visible && !context.state.layerHandles.has(layer.layerId) && context.dataByLayerId.has(layer.layerId)) installCachedDatasetLayers(context);
  const handle = context.state.layerHandles.get(layer.layerId);
  if (!context.state.map || !handle) return;
  handle.layerVisible = visible;
  handle.cog?.setVisible(visible);
  for (const mapLayerId of handle.layerIds) {
    if (context.state.map.getLayer(mapLayerId)) context.state.map.setLayoutProperty(mapLayerId, "visibility", visible && !(handle.overviewFiltered && mapLayerId === handle.rasterOverviewId) ? "visible" : "none");
  }
  for (const element of handle.overlayElements ?? []) element.hidden = !visible;
  syncFeatureHalo(context);
  if (visible && layer.sourceType === "kml-places") refreshKmlRegionPresentation(context.state);
}

export function setLayerOpacity(state, layerId, opacity) {
  const handle = state.layerHandles.get(layerId);
  if (!state.map || !handle) return;
  handle.cog?.setOpacity(opacity);
  for (const overlay of handle.overlayPresentations ?? []) overlay.baseOpacity = overlay.colorOpacity * opacity;
  for (const mapLayerId of handle.paintLayerIds) {
    const layer = state.map.getLayer(mapLayerId);
    if (!layer) continue;
    if (handle.opacityMode === "composite" && ["fill", "line"].includes(layer.type)) {
      state.map.setPaintProperty(mapLayerId, `${layer.type}-opacity`, handle.compositePaint[mapLayerId][`${layer.type}-opacity`] ?? 1);
      state.map.setPaintProperty(mapLayerId, `${layer.type}-layer-opacity`, opacity);
      continue;
    }
    if (handle.boundStyle) {
      if (handle.clusterLayerIds?.includes(mapLayerId)) {
        state.map.setPaintProperty(mapLayerId, layer.type === "symbol" ? "icon-opacity" : "circle-opacity", opacity);
        if (layer.type === "circle") state.map.setPaintProperty(mapLayerId, "circle-stroke-opacity", opacity);
        continue;
      }
      const index = handle.paintLayerIds.indexOf(mapLayerId);
      const original = handle.boundStyle.parts[index];
      if (layer.type === "symbol") {
        for (const property of ["icon-opacity", "text-opacity"]) if (Object.hasOwn(original.paint, property)) {
          state.map.setPaintProperty(mapLayerId, property, (original.paint[property] ?? 1) * opacity);
        }
        continue;
      }
      state.map.setPaintProperty(mapLayerId, `${layer.type}-opacity`, (original.paint[`${layer.type}-opacity`] ?? 1) * opacity);
      if (layer.type === "circle") state.map.setPaintProperty(mapLayerId, "circle-stroke-opacity", (original.paint["circle-stroke-opacity"] ?? 1) * opacity);
      continue;
    }
    if (layer.type === "line") state.map.setPaintProperty(mapLayerId, "line-opacity", opacity);
    if (layer.type === "circle") {
      state.map.setPaintProperty(mapLayerId, "circle-opacity", opacity);
      if (handle.clusterLayerIds?.includes(mapLayerId)) state.map.setPaintProperty(mapLayerId, "circle-stroke-opacity", opacity);
    }
    if (layer.type === "symbol" && layer.layout?.["icon-image"]) state.map.setPaintProperty(mapLayerId, "icon-opacity", opacity);
    if (layer.type === "fill") {
      state.map.setPaintProperty(mapLayerId, "fill-opacity", opacity * (handle.fillOpacityFactor ?? 0.45));
    }
    if (layer.type === "raster") state.map.setPaintProperty(mapLayerId, "raster-opacity", opacity);
  }
  if (handle.kmlDocument || layerId === "kml-places") refreshKmlRegionPresentation(state);
}

function repaintLayer(context, layer) {
  const {state, dataByLayerId, datasets} = context;
  const handle = state.layerHandles.get(layer.layerId);
  if (!state.map || !handle) return;
  removeMapLayer(state, layer.layerId);
  addMapLayer(state, layer, dataByLayerId.get(layer.layerId), datasets);
  syncLayerOrder(context);
}

function moveLayer(context, layer, delta) {
  if (!layer) return;
  const next = reorderedLayerStack(context.layers, context.project?.layerTree, layer.layerId, delta);
  if (next.every((candidate, index) => candidate === context.layers[index])) return;
  replaceLayerOrder(context.layers, next);
  syncLayerOrder(context);
  context.render();
}

function projectLayerMoveState(context, layer) {
  return layerMoveState(context.layers, context.project?.layerTree, layer?.layerId);
}

function moveLayerGroup(context, groupId, delta) {
  if (![ -1, 1 ].includes(delta)) return;
  const siblings = findLayerGroupSiblings(context.project?.layerTree, groupId);
  if (!siblings) return;
  const index = siblings.findIndex((node) => node?.kind === "group" && node.id === groupId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= siblings.length || siblings[target]?.kind !== "group") return;
  [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
  replaceLayerOrder(
    context.layers,
    normalizeProjectLayerOrder(context.layers, context.project.layerTree)
  );
  syncLayerOrder(context);
  context.render();
}

function projectLayerGroupMoveState(context, groupId) {
  const siblings = findLayerGroupSiblings(context.project?.layerTree, groupId) ?? [];
  const index = siblings.findIndex((node) => node?.kind === "group" && node.id === groupId);
  return {
    canMoveUp: index > 0 && siblings[index - 1]?.kind === "group",
    canMoveDown: index >= 0 && index < siblings.length - 1 && siblings[index + 1]?.kind === "group"
  };
}

function findLayerGroupSiblings(nodes, groupId, depth = 0) {
  if (!Array.isArray(nodes) || depth > 8) return null;
  if (nodes.some((node) => node?.kind === "group" && node.id === groupId)) return nodes;
  for (const node of nodes) {
    if (node?.kind !== "group") continue;
    const found = findLayerGroupSiblings(node.children, groupId, depth + 1);
    if (found) return found;
  }
  return null;
}

function replaceLayerOrder(layers, ordered) {
  layers.splice(0, layers.length, ...ordered);
  layers.forEach((layer, order) => layer.order = order);
}

function syncLayerOrder(context) {
  const {state, layers} = context;
  if (!state.map) return;
  if(context.rendererAdapter.id === "cesium") {state.map.setLayerOrder([...layers].reverse().map(layer=>layer.layerId));return;}
  for(const id of orderedRenderLayerIds(layers,state.layerHandles)) {
    if(state.map.getLayer(id))state.map.moveLayer(id);
  }
  syncFeatureHalo(context);
}

function syncLabels(context, layer) {
  const {state} = context;
  const fontStatus = [...context.shell.querySelectorAll(".gis-map-font-status")]
    .find(element => element.dataset.fontLayerId === layer.layerId);
  if (fontStatus) fontStatus.textContent = mapFontStatusText(context, layer);
  const map = state.map;
  const handle = state.layerHandles.get(layer.layerId);
  if (!map || !handle) return;
  if (handle.labelLayerId && map.getLayer(handle.labelLayerId)) {
    map.removeLayer(handle.labelLayerId);
    handle.layerIds = handle.layerIds.filter((id) => id !== handle.labelLayerId);
    handle.labelLayerId = null;
  }
  const labelLayer = labelForLayer(layer, state.mapFontSession, context.dataByLayerId.get(layer.layerId));
  if (!labelLayer || !layer.labels?.enabled) return;
  handle.baseFilters??={};handle.baseFilters[labelLayer.id]=labelLayer.filter??null;
  map.addLayer({...labelLayer, ...mapFilterOptions(labelLayer.filter,layer.filter), source: handle.sourceId, layout: {...labelLayer.layout, visibility: layer.visible ? "visible" : "none"}});
  handle.labelLayerId = labelLayer.id;
  handle.layerIds.push(labelLayer.id);
  syncLayerOrder(context);
}

function syncPinnedMapFonts(context) {
  if (context.disposed || context.syncingMapFonts) return;
  const {state, layers} = context;
  const fonts = state.mapFontSession;
  if (!fonts) return;
  const hasKnownPinned = layers.some(layer => layer.visible !== false && isRegisteredMapFont(layer.labels?.fontRef) && layer.labels?.enabled);
  if (hasKnownPinned && fonts.available && fonts.phase === "unloaded") {
    void fonts.prepare().then(() => { if (!context.disposed) context.render(); })
      .catch(() => { if (!context.disposed) context.render(); });
  }
  const glyphRoot = state.map?.getStyle?.()?.glyphs;
  const mixedBlankFonts = (!glyphRoot || glyphRoot.startsWith("opengeo-font://"))
    && layers.some(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.field && !isRegisteredMapFont(layer.labels.fontRef));
  const failures = layers.filter(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.fontRef)
    .flatMap(layer => {
      const issue = !isRegisteredMapFont(layer.labels.fontRef) ? "unregistered"
        : !fonts.available ? "unavailable"
          : fonts.phase === "failed" ? "verification"
            : fonts.phase === "ready" && context.dataByLayerId.has(layer.layerId)
              ? (fonts.supportsRenderer(context.rendererAdapter.id) ? fonts.coverageError(layer, context.dataByLayerId.get(layer.layerId)) : "transport") ?? (mixedBlankFonts ? "mixed-legacy-fonts" : null) : null;
      return issue ? [`${layer.layerId}:${issue}`] : [];
    });
  const failureKey = failures.sort().join("|");
  if (failureKey && failureKey !== context.mapFontFailureNotice) {
    context.mapFontFailureNotice = failureKey;
    setStatus(context, "Labels unavailable — open Layer Properties.");
  } else if (!failureKey) context.mapFontFailureNotice = null;
  const map = state.map;
  if (!map?.isStyleLoaded?.()) return;
  context.syncingMapFonts = true;
  try {
    // Remove pinned symbol layers before a root glyph change could make
    // MapLibre render them with unspecified local fonts.
    const blankRoot = !map.getGlyphs?.() || map.getGlyphs().startsWith("opengeo-font://");
    const visibleLegacy = layers.some(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.field && !isRegisteredMapFont(layer.labels.fontRef));
    const visiblePinned = layers.some(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.field && isRegisteredMapFont(layer.labels.fontRef));
    for (const layer of layers) {
      const handle = state.layerHandles.get(layer.layerId);
      if (handle?.labelLayerId && map.getLayer(handle.labelLayerId)) {
        const suppress = layer.labels?.fontRef
          ? !fonts.supportsRenderer(context.rendererAdapter.id) || (blankRoot && visibleLegacy) || fonts.coverageError(layer, context.dataByLayerId.get(layer.layerId))
          : blankRoot && !visibleLegacy && visiblePinned && fonts.phase === "ready";
        if (suppress) {
          map.removeLayer(handle.labelLayerId);
          handle.layerIds = handle.layerIds.filter(id => id !== handle.labelLayerId);
          handle.labelLayerId = null;
        }
      }
    }
    fonts.configure(map, layers, context.rendererAdapter.id);
    for (const layer of layers) {
      if (!layer.labels?.enabled) continue;
      const handle = state.layerHandles.get(layer.layerId);
      if (handle && (!handle.labelLayerId || !map.getLayer(handle.labelLayerId))
        && (layer.labels.fontRef ? fonts.canRender(layer, context.dataByLayerId.get(layer.layerId)) : !fonts.usesPinnedGlyphRoot)) syncLabels(context, layer);
    }
  } finally { context.syncingMapFonts = false; }
}

function toggleProjection(context) {
  const {state} = context;
  if (state.flightSession) endFlightSimulation(context, {render: false, announce: false});
  const requested = state.globe ? "mercator" : "globe";
  const result = applyMapProjection(state.map, requested);
  state.globe = result.effective === "globe";
  state.projectionFallback = result.fallback;
  if (!state.globe && state.terrainEnabled) {
    applyOpenTerrain(state.map, false, {exaggeration: state.terrainExaggeration});
    state.terrainEnabled = false;
    state.terrainFallback = false;
    state.terrainFallbackReason = null;
    cancelTerrainTiming(state.globeTelemetry);
  }
  if (!state.globe) {
    if (state.openScene3dEnabled) applyOpenScene3d(state.map, false);
    state.openScene3dEnabled = false;
    state.openScene3dFallback = false;
    state.openScene3dFallbackReason = null;
    state.openScene3dBuildingFeatures = 0;
    state.openScene3dWoodlandFeatures = 0;
  }
  setStatus(
    context,
    result.fallback
      ? "Globe projection is unavailable; the accessible Mercator fallback remains active."
      : state.globe
        ? state.spatialBody.id === "earth"
          ? "Globe projection enabled. Current imagery is attributed; enable open terrain separately."
          : `${state.spatialBody.title} globe enabled with angular camera zoom; no physical eye-altitude claim is made.`
        : "Mercator projection enabled as the accessible 2D fallback."
  );
  context.render();
}

function toggleOpenScene3d(context) {
  if (context.rendererAdapter.id !== "maplibre") {setStatus(context, "Switch to MapLibre for terrain and 3D scene tools."); return;}
  const {state} = context;
  if (state.spatialBody.id !== "earth") {
    setStatus(context, `OpenGeo Studio's current 3D scene contains Earth data and is unavailable on ${state.spatialBody.title}.`);
    return;
  }
  if (!state.globe) {
    setStatus(context, "Enable the globe projection before enabling the open 3D scene.");
    return;
  }
  const enabling = !state.openScene3dEnabled;
  const activation = currentOpenScene3dActivation(state);
  const result = applyOpenScene3d(state.map, enabling, {globe: state.globe, activation});
  state.openScene3dEnabled = result.effective;
  state.openScene3dFallback = result.fallback;
  state.openScene3dFallbackReason = result.reason;
  if (result.effective && state.map) {
    state.map.easeTo({
      zoom: Math.max(state.map.getZoom(), OPEN_3D_SCENE_LIMITS.minimumDetailZoom + 0.25),
      pitch: Math.max(state.map.getPitch(), 55),
      duration: 350
    });
  }
  setStatus(
    context,
    result.fallback
      ? openScene3dGovernanceMessage(result.reason)
      : result.effective
        ? "Buildings and woodland canopy load directly from OpenFreeMap using the reviewed snapshot. Zoom in to see detail; individual trees are not modeled."
        : "Open 3D buildings and woodland canopy disabled."
  );
  context.render();
}

function toggleTerrain(context) {
  if (context.rendererAdapter.id !== "maplibre") {setStatus(context, "Switch to MapLibre for terrain and 3D scene tools."); return;}
  const {state} = context;
  if (state.spatialBody.id !== "earth") {
    setStatus(context, `OpenGeo Studio's current terrain source is Earth-only and is unavailable on ${state.spatialBody.title}.`);
    return;
  }
  if (!state.globe) {
    setStatus(context, "Enable the globe projection before enabling 3D terrain.");
    return;
  }
  const enabling = !state.terrainEnabled;
  if (!enabling && state.flightSession) endFlightSimulation(context, {render: false, announce: false});
  const activation = currentTerrainActivation(state);
  if (enabling) beginTerrainTiming(state.globeTelemetry);
  else cancelTerrainTiming(state.globeTelemetry);
  const result = applyOpenTerrain(
    state.map,
    enabling,
    {exaggeration: state.terrainExaggeration, activation}
  );
  state.terrainEnabled = result.effective;
  state.terrainExaggeration = result.exaggeration;
  state.terrainFallback = result.fallback;
  state.terrainFallbackReason = result.reason;
  if (result.fallback) cancelTerrainTiming(state.globeTelemetry);
  setStatus(
    context,
    result.fallback
      ? terrainGovernanceMessage({...activation, status: result.reason ?? activation.status})
      : state.terrainEnabled
        ? "Terrain loads directly from Mapterhorn. Your basemap and project layers stay in place; availability depends on the provider."
        : "3D terrain disabled; the attributed globe remains active."
  );
  context.render();
}

function updateProjectionPresentation(context) {
  const {shell, state} = context;
  for (const button of shell.querySelectorAll("[data-map-mode]")) {
    button.setAttribute("aria-pressed", String(Boolean(state[button.dataset.mapMode])));
  }
  const projection = state.globe ? "globe" : "mercator";
  shell.dataset.spatialBody = state.spatialBody.id;
  shell.dataset.projection = projection;
  shell.dataset.projectionFallback = state.projectionFallback ? "true" : "false";
  shell.dataset.terrain = state.terrainEnabled ? "enabled" : "disabled";
  shell.dataset.terrainFallback = state.terrainFallback ? "true" : "false";
  shell.dataset.terrainGovernance = state.terrainGovernanceStatus;
  shell.dataset.terrainOutage = state.terrainOutageGuard.snapshot().state;
  shell.dataset.openScene3d = state.openScene3dEnabled ? "enabled" : "disabled";
  shell.dataset.openScene3dFallback = state.openScene3dFallback ? "true" : "false";
  shell.dataset.openScene3dGovernance = state.openScene3dGovernanceStatus;
  shell.dataset.openScene3dOutage = state.openScene3dOutageGuard.snapshot().state;
  shell.dataset.openScene3dBuildings = String(state.openScene3dBuildingFeatures);
  shell.dataset.openScene3dWoodland = String(state.openScene3dWoodlandFeatures);
  const interactionSupport = globeInteractionSupport(state.map);
  shell.dataset.globeInteractions = globeInteractionSupportAccepted(interactionSupport)
    ? "enabled"
    : "unavailable";
  for (const [name, enabled] of Object.entries(interactionSupport)) {
    shell.dataset[`interaction${name[0].toUpperCase()}${name.slice(1)}`] = enabled ? "enabled" : "disabled";
  }
  const container = shell.querySelector(".gis-map");
  if (!container) return;
  container.dataset.projection = projection;
  container.dataset.terrain = state.terrainEnabled ? "enabled" : "disabled";
  container.dataset.openScene3d = state.openScene3dEnabled ? "enabled" : "disabled";
  container.setAttribute(
    "aria-label",
    state.globe
      ? `Interactive globe using attributed imagery; drag, orbit, wheel, keyboard, and two-finger touch navigation are enabled${state.terrainEnabled ? " and Mapterhorn open terrain" : "; 3D terrain is not enabled"}${state.openScene3dEnabled ? "; open buildings and woodland canopy are enabled; individual trees are not modeled" : "; open 3D buildings and vegetation are not enabled"}`
      : "Interactive two-dimensional Mercator map fallback"
  );
}

function recordOpenScene3dVisibleFeatures(state) {
  try {
    const buildings = state.map.querySourceFeatures(OPEN_3D_SCENE_SOURCE.sourceId, {sourceLayer: "building"});
    const woodland = state.map
      .querySourceFeatures(OPEN_3D_SCENE_SOURCE.sourceId, {sourceLayer: "landcover"})
      .filter((feature) => feature.properties?.class === "wood");
    state.openScene3dBuildingFeatures = Math.min(buildings.length, 100_000);
    state.openScene3dWoodlandFeatures = Math.min(woodland.length, 100_000);
  } catch {
    state.openScene3dBuildingFeatures = 0;
    state.openScene3dWoodlandFeatures = 0;
  }
}

function currentTerrainActivation(state) {
  const governance = evaluateTerrainGovernance({deploymentClass: state.terrainDeploymentClass});
  const decision = terrainActivationDecision(governance, state.terrainOutageGuard.snapshot());
  state.terrainGovernanceStatus = decision.status;
  return decision;
}

function currentOpenScene3dActivation(state) {
  const decision = terrainActivationDecision(
    evaluateOpenScene3dGovernance({deploymentClass: state.terrainDeploymentClass}),
    state.openScene3dOutageGuard.snapshot()
  );
  state.openScene3dGovernanceStatus = decision.status;
  return decision;
}

function terrainGovernanceLabel(reason) {
  switch (reason) {
    case "source-review-due": return "source review due";
    case "receipt-invalid": return "invalid source receipt";
    case "clock-invalid": return "unverified clock";
    case "source-outage": return "source outage cooldown";
    case "renderer-error":
    case "renderer-rejected": return "renderer fallback";
    default: return "governance unavailable";
  }
}

function openScene3dGovernanceLabel(reason) {
  switch (reason) {
    case "source-review-due": return "source review due";
    case "receipt-invalid": return "invalid source receipt";
    case "clock-invalid": return "unverified clock";
    case "source-outage": return "source outage cooldown";
    case "globe-required": return "globe required";
    case "renderer-error":
    case "renderer-rejected": return "renderer fallback";
    default: return "governance unavailable";
  }
}

function openScene3dGovernanceMessage(reason) {
  switch (reason) {
    case "fresh-upstream": return "Buildings load directly from OpenFreeMap. No API key or OpenGeo Studio-hosted copy is needed.";
    case "source-review-due": return "Buildings load directly from OpenFreeMap. Its recorded source check is due for review; this does not prevent viewing.";
    case "receipt-invalid": return "Open 3D content is disabled because its source audit receipt is invalid.";
    case "clock-invalid": return "Open 3D content is disabled because receipt freshness cannot be established from this clock.";
    case "source-outage": return "Buildings are temporarily unavailable. Your basemap and layers remain in place. Wait one minute, then retry Buildings.";
    case "globe-required": return "Enable the globe projection before enabling the open 3D scene.";
    default: return "Open 3D content is unavailable; the attributed globe remains active without buildings or vegetation canopy.";
  }
}

function updateGlobeTelemetryPresentation(context) {
  const {shell, state} = context;
  const usedHeapBytes = globalThis.performance?.memory?.usedJSHeapSize;
  const snapshot = globeTelemetrySnapshot(state.globeTelemetry, {usedHeapBytes});
  shell.dataset.frameSamples = String(snapshot.frameSamples);
  setFiniteDataset(shell, "frameP50Ms", snapshot.frameP50Ms);
  setFiniteDataset(shell, "frameP95Ms", snapshot.frameP95Ms);
  setFiniteDataset(shell, "mapLoadMs", snapshot.mapLoadMs);
  setFiniteDataset(shell, "terrainReadyMs", snapshot.terrainReadyMs);
  setFiniteDataset(shell, "heapMib", snapshot.heapMiB);
  if (snapshot.camera) {
    setFiniteDataset(shell, "cameraLongitude", snapshot.camera.longitude);
    setFiniteDataset(shell, "cameraLatitude", snapshot.camera.latitude);
    setFiniteDataset(shell, "cameraZoom", snapshot.camera.zoom);
    setFiniteDataset(shell, "cameraPitch", snapshot.camera.pitch);
    setFiniteDataset(shell, "cameraBearing", snapshot.camera.bearing);
  }
  const requiredChecks = [snapshot.acceptance.frameP95, snapshot.acceptance.mapLoad];
  if (state.terrainEnabled) requiredChecks.push(snapshot.acceptance.terrainReady);
  if (snapshot.acceptance.heap !== null) requiredChecks.push(snapshot.acceptance.heap);
  shell.dataset.performanceAccepted = snapshot.acceptance.enoughFrames
    && requiredChecks.every((value) => value === true)
    ? "true"
    : "false";

  const output = shell.querySelector(".gis-globe-metrics");
  if (!output) return;
  const frameText = snapshot.acceptance.enoughFrames
    ? `p95 ${snapshot.frameP95Ms} ms / ≤${GLOBE_TELEMETRY_LIMITS.maximumAcceptedFrameP95Ms}`
    : `${snapshot.frameSamples}/${GLOBE_TELEMETRY_LIMITS.minimumAcceptanceFrameSamples} frame samples`;
  const loadText = Number.isFinite(snapshot.mapLoadMs)
    ? `load ${snapshot.mapLoadMs} ms / ≤${GLOBE_TELEMETRY_LIMITS.maximumAcceptedMapLoadMs}`
    : "load pending";
  const terrainText = state.terrainEnabled
    ? Number.isFinite(snapshot.terrainReadyMs)
      ? `terrain ${snapshot.terrainReadyMs} ms / ≤${GLOBE_TELEMETRY_LIMITS.maximumAcceptedTerrainReadyMs}`
      : "terrain pending"
    : "terrain off";
  const heapText = Number.isFinite(snapshot.heapMiB)
    ? `heap ${snapshot.heapMiB} MiB / ≤${GLOBE_TELEMETRY_LIMITS.maximumAcceptedHeapMiB}`
    : "heap unavailable";
  output.textContent = `Local automation telemetry · ${frameText} · ${loadText} · ${terrainText} · ${heapText}`;
}

function setFiniteDataset(element, key, value) {
  if (Number.isFinite(value)) element.dataset[key] = String(value);
  else delete element.dataset[key];
}

function resetViewBearing(state) {
  state.map?.easeTo({bearing: 0, pitch: 0, duration: 350});
}

function fitVisibleLayers(map, layers, dataByLayerId) {
  if (!map) return;
  const bounds = workbenchRenderer(map).createBounds();
  for (const layer of layers.filter((candidate) => candidate.visible)) {
    const layerBounds = geojsonBounds(dataByLayerId.get(layer.layerId));
    if (layerBounds) bounds.extend(layerBounds[0]).extend(layerBounds[1]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, {padding: 56, maxZoom: 13, duration: 350});
}

function fitLayer(map, layer, dataByLayerId) {
  if (!layer) return;
  const bounds = geojsonBounds(dataByLayerId.get(layer.layerId));
  if (map && bounds) map.fitBounds(bounds, {padding: 64, maxZoom: 14, duration: 350});
}

function fitGeojson(map, geojson) {
  const bounds = geojsonBounds(geojson);
  if (map && bounds) map.fitBounds(bounds, {padding: 64, maxZoom: 14, duration: 350});
}

function syncQueryResultLayer(context, features) {
  const {state} = context;
  const map = state.map;
  if (!map) return;
  const sourceId = "opengeo-query-result-source";
  const layerIds = ["opengeo-query-result-fill", "opengeo-query-result-line", "opengeo-query-result-point"];
  const data = {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        opengeoQueryId: feature.id,
        opengeoQuerySelected: feature.id === state.querySelectedFeatureId
      }
    }))
  };
  const source = map.getSource(sourceId);
  if (source) {
    source.setData(data);
    return;
  }
  if (!features.length) return;
  try {
    map.addSource(sourceId, {type: "geojson", data});
  } catch (error) {
    if (error?.message !== "Style is not done loading.") throw error;
    map.once("style.load", () => syncQueryResultLayer(context, features));
    return;
  }
  map.addLayer({
    id: layerIds[0],
    type: "fill",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": ["case", ["==", ["get", "opengeoQuerySelected"], true], "#facc15", "#db2777"],
      "fill-opacity": 0.28,
      "fill-outline-color": "#831843"
    }
  });
  map.addLayer({
    id: layerIds[1],
    type: "line",
    source: sourceId,
    filter: ["!=", ["geometry-type"], "Point"],
    paint: {
      "line-color": ["case", ["==", ["get", "opengeoQuerySelected"], true], "#facc15", "#db2777"],
      "line-width": 5
    }
  });
  map.addLayer({
    id: layerIds[2],
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": ["case", ["==", ["get", "opengeoQuerySelected"], true], "#facc15", "#db2777"],
      "circle-radius": 8,
      "circle-stroke-color": "#831843",
      "circle-stroke-width": 2
    }
  });
  if (!state.queryResultHandlersBound) {
    state.queryResultHandlersBound = true;
    for (const id of layerIds) {
      map.on("click", id, (event) => {
        const featureId = event.features?.[0]?.properties?.opengeoQueryId;
        if (!featureId) return;
        state.querySelectedFeatureId = featureId;
        const index = state.queryResult?.features.findIndex(({id}) => id === featureId) ?? -1;
        state.selectedFeatureIndex = index >= 0 ? index : null;
        syncQueryResultLayer(context, state.queryResult?.features ?? []);
        context.render();
      });
    }
  }
}

function runTool(context, toolId) {
  const {state, dataByLayerId} = context;
  const layer = activeLayer(context);
  const geojson = dataByLayerId.get(layer?.layerId);

  if (toolId === "sql-workspace") {
    state.activePanel = "sql";
    return;
  }

  if (toolId === "vector-to-pmtiles") {
    state.activePanel='processing';state.activeToolId=toolId;state.rightOpen=true;
    setStatus(context,'Review the PMTiles conversion settings before queuing the job.');
    context.render();
    return;
  }

  if (["raster-to-cog", "assistant-plan"].includes(toolId)) {
    state.processingLog.unshift(`${toolTitle(toolId)} requires its durable server operation. No job was queued from this browser panel.`);
    return;
  }

  if (!layer || !geojson) {
    state.processingLog.unshift("The active layer has no browser geometry.");
    return;
  }

  if (["count", "bounds", "bbox-layer", "centroids", "geometric-centroids"].includes(toolId)) {
    runRegisteredBrowserTool(context, toolId, layer, geojson);
  }
  if (toolId === "filter-verified") setLayerFilter(context, layer, ["==", ["get", "status"], "verified"], "status = verified");
  if (toolId === "clear-filter") setLayerFilter(context, layer, null, "cleared");
}

function runRegisteredBrowserTool(context, toolId, layer, geojson) {
  const started = globalThis.performance?.now?.() ?? 0;
  try {
    const receipt = runBrowserProcessingTool({
      toolId,
      layerId: layer.layerId,
      layerTitle: layer.title,
      geojson
    });
    const outputLayerName = receipt.output.geojson
      ? addProcessingOutputLayer(context, layer, toolId, receipt.output.geojson)
      : null;
    context.state.processingLog.unshift(...receipt.logs);
    recordBrowserProcessingReceipt(context, receipt, started, outputLayerName ? [outputLayerName] : []);
  } catch (error) {
    context.state.processingLog.unshift(`${layer.title}: processing stopped safely (${error.code ?? "processing_failed"}).`);
  }
}

function runProcessingModel(context, model) {
  const layer = activeLayer(context);
  const geojson = context.dataByLayerId.get(layer?.layerId);
  if (!layer || !geojson) {
    context.state.processingLog.unshift("The active layer has no browser geometry for this model.");
    return;
  }
  const started = globalThis.performance?.now?.() ?? 0;
  try {
    const result = runBrowserProcessingModel({model, layerId: layer.layerId, layerTitle: layer.title, geojson});
    if (result.status !== "success") {
      context.state.processingLog.unshift(`${model.name || model.id}: model stopped safely (${result.error ?? result.status}).`);
      return;
    }
    let outputLayerName = null;
    const lastReceipt = result.steps.at(-1)?.receipt;
    if (lastReceipt?.output.geojson) {
      outputLayerName = addProcessingOutputLayer(context, layer, "model", lastReceipt.output.geojson, `${model.name || model.id} output`);
    }
    for (const [index, {receipt}] of result.steps.entries()) {
      context.state.processingLog.unshift(...receipt.logs);
      const isFinalStep = index === result.steps.length - 1;
      recordBrowserProcessingReceipt(
        context,
        receipt,
        started,
        isFinalStep && outputLayerName ? [outputLayerName] : []
      );
    }
  } catch (error) {
    context.state.processingLog.unshift(`${model.name || model.id}: model stopped safely (${error.code ?? "processing_model_failed"}).`);
  }
}

function addProcessingOutputLayer(context, sourceLayer, toolId, geojson, explicitTitle = null, outputStyle = null) {
  context.state.processingRunSequence += 1;
  const centroid = ["centroids", "geometric-centroids"].includes(toolId) || geojson.features.every(({geometry}) => geometry?.type === "Point");
  const title = explicitTitle ?? `${sourceLayer.title} ${toolId === "bbox-layer" ? "bounds" : toolId === "geometric-centroids" ? "planar centroids" : "centroids"}`;
  context.addLayer({
    layerId: `scratch_processing_${Date.now()}_${context.state.processingRunSequence}`,
    datasetId: null,
    title,
    sourceType: "geojson-object",
    geometryType: centroid ? "Point" : geojson.features.find(({geometry}) => geometry)?.geometry.type ?? "Polygon",
    visible: true,
    opacity: centroid ? 0.9 : 0.5,
    order: 999,
    style: outputStyle ?? (centroid
      ? {circleColor: "#ec4899", circleRadius: 6}
      : {fill: "#a855f7", stroke: "#7e22ce", strokeWidth: 2}),
    labels: {enabled: false, field: null}
  }, {...geojson, "opengeo:analysis": geojson["opengeo:analysis"] ?? {
    operation: toolId, sourceDatasetId: sourceLayer.datasetId ?? null,
    sourceLayerId: sourceLayer.layerId, sourceGeneration: sourceLayer.featureGeneration ?? null,
    persisted: false, crs: "CRS:84"
  }}, {panelAfterAdd: "processing"});
  return title;
}

function recordBrowserProcessingReceipt(context, receipt, started, outputLayerNames) {
  context.state.processingRunSequence += 1;
  const finished = globalThis.performance?.now?.() ?? started;
  const entry = portableProcessingHistoryEntry(receipt, {
    id: `opengeo-run-${Date.now()}-${context.state.processingRunSequence}`,
    durationMs: Math.max(0, finished - started),
    outputLayerNames
  });
  context.state.processingHistory = appendProcessingHistory(context.state.processingHistory, entry);
}

function setLayerFilter(context, layer, filter, label) {
  validateMapFilter(filter);
  layer.filter=structuredClone(filter);
  const handle = context.state.layerHandles.get(layer.layerId);
  if (!context.state.map || !handle) return;
  if (handle.clustered) {repaintLayer(context, layer);context.state.processingLog.unshift(`${layer.title}: map filter ${label}; display counts recomputed from matching points.`);return;}
  for (const mapLayerId of handle.layerIds) {
    if (mapLayerId === handle.rasterOverviewId) {
      handle.overviewFiltered = Boolean(filter);
      context.state.map.setLayoutProperty(mapLayerId, "visibility", layer.visible && !filter ? "visible" : "none");
    } else if (context.state.map.getLayer(mapLayerId)?.type !== "raster") {
      context.state.map.setFilter(mapLayerId, combineMapFilters(handle.baseFilters?.[mapLayerId],filter));
    }
  }
  context.state.processingLog.unshift(`${layer.title}: map filter ${label}.${handle.rasterOverviewId && filter ? " The class overview is hidden while filtering; zoom in to inspect matching individual records." : ""}`);
}

function clearAllFilters(context) {
  for (const layer of context.layers) setLayerFilter(context, layer, null, "cleared");
  setStatus(context, "All map filters cleared.");
}

function duplicateActiveLayer(context) {
  const layer = activeLayer(context);
  const geojson = context.dataByLayerId.get(layer?.layerId);
  if (!layer || !geojson) {
    setStatus(context, "Only local vector layers can be duplicated.");
    return;
  }
  context.addLayer({...cloneLayer(layer), layerId: `scratch_copy_${Date.now()}`, title: `${layer.title} copy`, order: 900}, structuredClone(geojson));
}

function removeLayer(context, layer = activeLayer(context)) {
  if (!layer) {
    setStatus(context, "Select a layer before removing it from the project.");
    return;
  }
  if (context.state.temporaryEdit?.layerId === layer.layerId) {
    cancelTemporaryEdit(context, {render: false, announce: false});
  }
  cancelLiveFeatureLayer(context, layer);
  context.layerArchiveControls.get(layer.layerId)?.dispose();
  context.layerArchiveControls.delete(layer.layerId);
  context.layerToolsOpen.delete(layer.layerId);
  context.layerArchiveModes.delete(layer.layerId);
  context.state.archiveTileSessions.get(layer.layerId)?.dispose();
  context.state.archiveTileSessions.delete(layer.layerId);
  removeMapLayer(context.state, layer.layerId);
  const index = context.layers.indexOf(layer);
  if (index >= 0) context.layers.splice(index, 1);
  context.dataByLayerId.delete(layer.layerId);
  const temporary = isTemporaryLayer(layer);
  if (temporary && context.state.temporaryPromotionLayerId === layer.layerId) {
    context.state.temporaryPromotionLayerId = null;
  }
  if (context.state.activeLayerId === layer.layerId) context.state.activeLayerId = context.layers[0]?.layerId ?? null;
  context.state.processingLog.unshift(`${layer.title}: removed from the browser project layer stack.`);
  if (temporary) persistTemporaryWork(context);
  setStatus(context, temporary
    ? `${layer.title} removed from temporary browser work. No authoritative dataset or map was changed.`
    : context.publicDemo
    ? `${layer.title} removed from this browser-only demo. Save locally to retain the change until the daily reset.`
    : `${layer.title} removed from this project. Save to persist ${projectS3Uri(context)}.`);
  context.render();
}

export function removeMapLayer(state, layerId) {
  if (state.featureHaloLayerId === layerId) clearFeatureHalo(state);
  const handle = state.layerHandles.get(layerId);
  if (!handle || !state.map) return;
  handle.cog?.dispose();
  handle.clusterCleanup?.();
  for (const {type, mapLayerId, handler} of handle.mapEventHandlers ?? []) {
    state.map.off(type, mapLayerId, handler);
  }
  for (const id of [...handle.layerIds].reverse()) if (state.map.getLayer(id)) state.map.removeLayer(id);
  for (const id of handle.imageIds ?? []) {
    const stillUsed = [...state.layerHandles.entries()].some(([otherId, other]) => otherId !== layerId && other.imageIds?.includes(id));
    if (!stillUsed && state.map.hasImage(id)) state.map.removeImage(id);
  }
  for (const id of handle.sourceIds ?? [handle.sourceId]) {
    const stillUsed = [...state.layerHandles.entries()].some(([otherLayerId, otherHandle]) => (
      otherLayerId !== layerId && (otherHandle.sourceIds ?? [otherHandle.sourceId]).includes(id)
    ));
    if (!stillUsed && state.map.getSource(id)) state.map.removeSource(id);
  }
  for (const element of handle.overlayElements ?? []) element.remove();
  state.layerHandles.delete(layerId);
}

function resetActiveStyle(context) {
  if (activeLayer(context)?.styleReference) { setStatus(context, "This Layer uses a pinned Style; inline style actions do not change it."); return; }
  const layer = activeLayer(context);
  if (!layer) return;
  layer.style = layer.geometryType?.includes("Point")
    ? {circleColor: "#f97316", circleRadius: 6}
    : layer.geometryType?.includes("Polygon")
      ? {fill: "#22c55e", stroke: "#15803d", strokeWidth: 2}
      : {stroke: "#2563eb", strokeWidth: 3};
  repaintLayer(context, layer);
  setStatus(context, `${layer.title} style reset.`);
}

function copyActiveStyle(context) {
  if (activeLayer(context)?.styleReference) { setStatus(context, "This Layer uses a pinned Style; inline style actions do not change it."); return; }
  const layer = activeLayer(context);
  if (!layer) {
    setStatus(context, "Select a layer before copying style.");
    return;
  }
  context.state.styleClipboard = {
    style: structuredClone(layer.style ?? {}),
    labels: structuredClone(layer.labels ?? {}),
    opacity: layer.opacity,
    opacityMode: layer.opacityMode ?? "feature"
  };
  setStatus(context, `${layer.title} style copied.`);
}

function pasteActiveStyle(context) {
  if (activeLayer(context)?.styleReference) { setStatus(context, "This Layer uses a pinned Style; inline style actions do not change it."); return; }
  const layer = activeLayer(context);
  const copied = context.state.styleClipboard;
  if (!layer || !copied) {
    setStatus(context, "Copy a layer style before pasting.");
    return;
  }
  if (copied.opacityMode === "composite" && !supportsCompositeOpacity(layer)) {setStatus(context, "Composite opacity requires a supported line or polygon Layer."); return;}
  layer.opacityMode = copied.opacityMode ?? "feature";
  layer.style = structuredClone(copied.style);
  layer.labels = structuredClone(copied.labels);
  layer.opacity = copied.opacity;
  repaintLayer(context, layer);
  setStatus(context, `${layer.title} style pasted.`);
  context.render();
}

function newWorkspaceProject(context) {
  stopCameraTourPlayback(context, {reset: false, render: false, announce: false});
  endFlightSimulation(context, {render: false, announce: false});
  cancelTemporaryEdit(context, {render: false, announce: false});
  for (const layer of [...context.layers]) removeMapLayer(context.state, layer.layerId);
  context.layers.splice(0);
  context.dataByLayerId.clear();
  context.state.activeLayerId = null;
  if (context.publicDemo) {
    context.localProjectRecord = null;
    const url = new URL(location.href);url.searchParams.delete("localProject");history.replaceState(null, "", url);
    context.state.browserCatalogSearch = "";
    context.browserCatalogPanel = null;
    context.state.activePanel = "catalog";
    context.state.rightOpen = true;
    context.project = {...context.project, title: "New Project", layerTree: []};
    context.project.extensions = {...context.project.extensions};
    delete context.project.extensions.opengeoPrintLayouts;
    context.onBrowserProjectCreated?.();
  }
  context.state.kmlPlaces = null;
  context.state.kmlInterchangeReport = null;
  context.state.cameraTour = null;
  context.state.cameraTourSelectedId = null;
  context.state.cameraTourElapsedMilliseconds = 0;
  context.state.mapAuthoring = null;
  context.state.mapAuthoringCreatedKmlPlaces = false;
  context.state.primaryAuthoringKind = null;
  context.state.authoringCoordinateDraft = null;
  context.state.overlayExtentDraft = null;
  context.state.measureMode = false;
  context.state.editingMeasurementId = null;
  context.state.measurePoints = [];
  context.state.measurements = [];
  context.state.selectedMeasurementId = null;
  syncMeasureLayer(context.state);
  setStatus(context, context.publicDemo
    ? "New Project ready. Choose Layers from the catalog, then Save locally to keep your work within Demo storage limits."
    : `New empty workspace project started in browser memory. Save target: ${projectS3Uri(context)}.`);
  context.render();
}

function togglePlugin(context, id) {
  const {state} = context;
  let capability;
  try {
    capability = extensionPolicy(id).capabilities[0];
  } catch {
    const decision = evaluateExtensionCapability(id, "plugin:enable");
    state.extensionAudit = recordExtensionAudit(state.extensionAudit, decision);
    setStatus(context, `Extension ${id} was denied because it is not registered.`);
    return;
  }
  const decision = evaluateExtensionCapability(id, capability);
  state.extensionAudit = recordExtensionAudit(state.extensionAudit, decision);
  if (!decision.allowed) {
    setStatus(context, `${id} was denied (${decision.reason}).`);
    return;
  }
  if (id === "time") {
    state.pluginState.delete(id);
    openHistoricalImageryPanel(context);
    return;
  }
  if (state.pluginState.has(id)) state.pluginState.delete(id);
  else state.pluginState.add(id);
  if (id === "catalog") state.activePanel = "catalog";
  if (id === "assistant") state.activePanel = "help";
  setStatus(context, `${PLUGINS.find(([pluginId]) => pluginId === id)?.[1] ?? id} ${state.pluginState.has(id) ? "enabled" : "disabled"}.`);
}

function syncGraticule(state) {
  const map = state.map;
  if (!map?.isStyleLoaded()) return;
  const sourceId = "opengeo-graticule-source";
  const layerId = "opengeo-graticule-lines";
  if (!state.graticule) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    return;
  }
  const bounds = map.getBounds?.();
  const data = mapGraticule(bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : undefined);
  if (map.getSource(sourceId)) map.getSource(sourceId).setData(data);
  else {
    map.addSource(sourceId, {type: "geojson", data});
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      paint: {"line-color": "#60a5fa", "line-opacity": 0.85, "line-width": 1.5, "line-dasharray": [4, 3]}
    });
  }
}

function addMeasurePoint(context, lngLat) {
  const {state} = context;
  const kind = measurementKindDefinition(state.measurementKind);
  if (state.measurePoints.length >= kind.maximumPoints) {
    setStatus(context, `${kind.label} uses at most ${kind.maximumPoints} ${kind.maximumPoints === 2 ? "points" : "vertices"}. Save, undo, or cancel the current measurement.`);
    return;
  }
  state.measurePoints.push([lngLat.lng, lngLat.lat]);
  syncMeasureLayer(state);
  setStatus(
    context,
    draftMeasurementFacts(state)
      ?? `${state.measurePoints.length} of ${kind.minimumLabel}. Continue on the map.`
  );
  context.render();
}

function syncMeasureLayer(state) {
  const map = state.map;
  if (!map?.isStyleLoaded()) return;
  const sourceId = "opengeo-measure-source";
  const fillId = "opengeo-measure-fill";
  const lineId = "opengeo-measure-line";
  const pointId = "opengeo-measure-points";
  if (map.getLayer(fillId)) map.removeLayer(fillId);
  if (map.getLayer(lineId)) map.removeLayer(lineId);
  if (map.getLayer(pointId)) map.removeLayer(pointId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  const visibleMeasurements = state.editingMeasurementId
    ? state.measurements.filter(({id}) => id !== state.editingMeasurementId)
    : state.measurements;
  const data = savedMeasurementGeojson(
    visibleMeasurements,
    state.measurePoints,
    state.measurementKind,
    state.spatialBody
  );
  if (!data.features.length) return;
  map.addSource(sourceId, {type: "geojson", data});
  map.addLayer({
    id: fillId,
    type: "fill",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": ["case", ["==", ["get", "kind"], "saved"], "#38bdf8", "#f97316"],
      "fill-opacity": ["case", ["==", ["get", "kind"], "saved"], 0.2, 0.16]
    }
  });
  map.addLayer({
    id: lineId,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": ["case", ["==", ["get", "kind"], "saved"], "#38bdf8", "#f97316"],
      "line-width": ["case", ["==", ["get", "kind"], "saved"], 4, 3]
    }
  });
  map.addLayer({
    id: pointId,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {"circle-color": "#f97316", "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5}
  });
}

function openMeasurementPanel(context) {
  const {state} = context;
  state.activePanel = "measure";
  state.rightOpen = true;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  setStatus(context, "Measurement tools opened. Choose line, path, polygon, or circle.");
  context.render();
}

function beginMeasurement(context, kind = "path") {
  const {state} = context;
  if (state.measurements.length >= PATH_MEASUREMENT_LIMITS.maximumMeasurements) {
    setStatus(context, `This map already contains the limit of ${PATH_MEASUREMENT_LIMITS.maximumMeasurements} saved measurements.`);
    return;
  }
  const definition = measurementKindDefinition(kind);
  cancelMapAuthoring(context, {render: false, announce: false});
  cancelQueryDrawing(context, {render: false, announce: false});
  cancelTemporaryEdit(context, {render: false, announce: false});
  state.measureMode = true;
  state.measurementKind = definition.id;
  state.editingMeasurementId = null;
  state.measurePoints = [];
  state.activePanel = "measure";
  state.rightOpen = true;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  syncMeasureLayer(state);
  setStatus(context, `${definition.label}: ${definition.instruction}`);
  context.render();
}

function editSavedMeasurement(context, measurement) {
  if(measurement.kind==="polygon-3d")return openPolygon3DMeasurementEditor(context, measurement);
  const {state} = context;
  if (!state.measurements.some(({id}) => id === measurement.id)) return;
  cancelMapAuthoring(context, {render: false, announce: false});
  cancelQueryDrawing(context, {render: false, announce: false});
  cancelTemporaryEdit(context, {render: false, announce: false});
  state.measureMode = true;
  state.measurementKind = measurement.kind === "polygon-area"
    ? "polygon"
    : measurement.kind === "circle-area"
      ? "circle"
      : "path";
  state.editingMeasurementId = measurement.id;
  state.selectedMeasurementId = measurement.id;
  state.measurePoints = measurement.kind === "circle-area"
    ? [[...measurement.center], [...measurement.radiusPoint]]
    : measurement.coordinates.map((coordinate) => [...coordinate]);
  state.activePanel = "measure";
  state.rightOpen = true;
  if (isMobileWorkbenchViewport()) state.leftOpen = false;
  syncMeasureLayer(state);
  setStatus(context, `${measurement.title}: edit the ${measurementKindDefinition(state.measurementKind).label.toLowerCase()} vertices, then update the measurement.`);
  context.render();
}

function stopMeasurement(context) {
  context.state.measureMode = false;
  context.state.editingMeasurementId = null;
  context.state.measurePoints = [];
  syncMeasureLayer(context.state);
  setStatus(context, "Measurement drawing stopped. Saved measurements remain with the map.");
  context.render();
}

function undoMeasurementPoint(context) {
  context.state.measurePoints.pop();
  syncMeasureLayer(context.state);
  setStatus(context, context.state.measurePoints.length
    ? `${context.state.measurePoints.length} measurement ${context.state.measurePoints.length === 1 ? "vertex" : "vertices"} remain.`
    : "Measurement draft cleared.");
  context.render();
}

function finishMeasurement(context) {
  const {state} = context;
  const kind = measurementKindDefinition(state.measurementKind);
  if (state.measurePoints.length < kind.minimumPoints) {
    setStatus(context, `Add ${kind.minimumLabel} before saving the measurement.`);
    return;
  }
  const terrainAvailable = kind.id === "path"
    && state.spatialBody.id === "earth"
    && state.terrainEnabled
    && typeof state.map?.queryTerrainElevation === "function";
  const elevationAt = terrainAvailable
    ? (coordinate) => state.map.queryTerrainElevation(
        {lng: coordinate[0], lat: coordinate[1]},
        {exaggerated: false}
      )
    : null;
  const terrainSource = terrainAvailable
    ? {
        sourceId: OPEN_TERRAIN_SOURCE.sourceId,
        provider: OPEN_TERRAIN_SOURCE.provider,
        queryMode: "renderer-unexaggerated-point-sample",
        termsUrl: OPEN_TERRAIN_SOURCE.termsUrl,
        observedAt: OPEN_TERRAIN_SOURCE.observedAt
      }
    : null;
  let measurement;
  const editingIndex = state.editingMeasurementId === null
    ? -1
    : state.measurements.findIndex(({id}) => id === state.editingMeasurementId);
  const existing = editingIndex >= 0 ? state.measurements[editingIndex] : null;
  try {
    const identity = {
      id: existing?.id ?? `measurement-${crypto.randomUUID()}`,
      title: existing?.title ?? `${kind.label} ${state.measurements.length + 1}`,
      spatialBody: state.spatialBody
    };
    measurement = kind.id === "polygon"
      ? createPolygonMeasurement({...identity, coordinates: state.measurePoints})
      : kind.id === "circle"
        ? createCircleMeasurement({
            ...identity,
            center: state.measurePoints[0],
            radiusPoint: state.measurePoints[1]
          })
        : createPathMeasurement({
            ...identity,
            coordinates: state.measurePoints,
            elevationAt,
            terrainSource
          });
  } catch {
    setStatus(context, "The measurement could not be saved. Check for duplicate, crossing, coincident, or out-of-range vertices.");
    return;
  }
  if (editingIndex >= 0) state.measurements.splice(editingIndex, 1, measurement);
  else state.measurements.push(measurement);
  state.selectedMeasurementId = measurement.id;
  state.measureMode = false;
  state.editingMeasurementId = null;
  state.measurePoints = [];
  state.activePanel = "measure";
  state.rightOpen = true;
  syncMeasureLayer(state);
  const profileMessage = measurement.kind !== "path-profile"
    ? ""
    : measurement.terrainProfile.status === "complete"
      ? ` Elevation profile saved from ${measurement.terrainProfile.source.provider}.`
      : measurement.terrainProfile.status === "partial"
        ? " A partial terrain profile was saved; unloaded samples remain explicit."
        : " No terrain profile was available; the 2D measurement remains valid.";
  setStatus(context, `${measurement.title} ${editingIndex >= 0 ? "updated" : "saved"}: ${measurementResultSummary(measurement)}.${profileMessage}`);
  context.render();
}

function draftMeasurementDistance(state) {
  let distance = 0;
  for (let index = 1; index < state.measurePoints.length; index += 1) {
    distance += spatialBodyDistanceMeters(
      state.measurePoints[index - 1],
      state.measurePoints[index],
      state.spatialBody
    );
  }
  return distance;
}

function draftMeasurementFacts(state) {
  const kind = measurementKindDefinition(state.measurementKind);
  if (state.measurePoints.length < kind.minimumPoints) return null;
  try {
    if (["line", "path"].includes(kind.id)) {
      return `${state.measurePoints.length} ${state.measurePoints.length === 2 ? "points" : "vertices"} · ${formatMeasurementDistance(draftMeasurementDistance(state))} on ${state.spatialBody.title}`;
    }
    if (kind.id === "polygon") {
      const metrics = polygonMeasurementMetrics(state.measurePoints, state.spatialBody);
      return `${state.measurePoints.length} vertices · ${formatMeasurementDistance(metrics.perimeterMeters)} perimeter · ${formatMeasurementArea(metrics.areaSquareMeters)}`;
    }
    const metrics = circleMeasurementMetrics(state.measurePoints[0], state.measurePoints[1], state.spatialBody);
    return `${formatMeasurementDistance(metrics.radiusMeters)} radius · ${formatMeasurementArea(metrics.areaSquareMeters)}`;
  } catch {
    return "Geometry needs another valid, non-crossing vertex";
  }
}

function measurementKindDefinition(kind) {
  return {
    line: {
      id: "line", label: "Line", minimumPoints: 2, maximumPoints: 2,
      minimumLabel: "2 points", instruction: "click a start and end point, then save the distance."
    },
    path: {
      id: "path", label: "Path + elevation", minimumPoints: 2,
      maximumPoints: PATH_MEASUREMENT_LIMITS.maximumVertices,
      minimumLabel: "at least 2 vertices", instruction: "click along the route, then save its distance and available elevation profile."
    },
    polygon: {
      id: "polygon", label: "Polygon area", minimumPoints: 3,
      maximumPoints: PATH_MEASUREMENT_LIMITS.maximumVertices,
      minimumLabel: "at least 3 vertices", instruction: "click the boundary in order without crossing edges, then save its perimeter and area."
    },
    circle: {
      id: "circle", label: "Circle area", minimumPoints: 2, maximumPoints: 2,
      minimumLabel: "a center and edge point", instruction: "click the center and one edge point, then save its radius, circumference, and area."
    }
  }[kind] ?? measurementKindDefinition("path");
}

function measurementResultSummary(measurement) {
  if (measurement.kind === "polygon-area") {
    return `${formatMeasurementDistance(measurement.perimeterMeters)} perimeter and ${formatMeasurementArea(measurement.areaSquareMeters)}`;
  }
  if (measurement.kind === "circle-area") {
    return `${formatMeasurementDistance(measurement.radiusMeters)} radius and ${formatMeasurementArea(measurement.areaSquareMeters)}`;
  }
  return formatMeasurementDistance(measurement.horizontalDistanceMeters);
}

function zoomToMeasurement(context, measurement) {
  context.state.selectedMeasurementId = measurement.id;
  const geometry = ["polygon-area", "polygon-3d"].includes(measurement.kind)
    ? {type: "Polygon", coordinates: [[...measurement.coordinates, measurement.coordinates[0]]]}
    : measurement.kind === "circle-area"
      ? {type: "Polygon", coordinates: [circlePolygonCoordinates(measurement)]}
      : {type: "LineString", coordinates: measurement.coordinates};
  const bounds = geojsonBounds({
    type: "Feature",
    geometry,
    properties: {}
  });
  if (bounds) context.state.map?.fitBounds(bounds, {padding: 80, maxZoom: 15, duration: 350});
  setStatus(context, `${measurement.title} fitted on the map.`);
  context.render();
}

function removeMeasurement(context, measurementId) {
  const index = context.state.measurements.findIndex(({id}) => id === measurementId);
  if (index < 0) return;
  const [removed] = context.state.measurements.splice(index, 1);
  context.state.selectedMeasurementId = context.state.measurements[index]?.id
    ?? context.state.measurements[index - 1]?.id
    ?? null;
  syncMeasureLayer(context.state);
  setStatus(context, `${removed.title} removed from this map.`);
  context.render();
}

function downloadMeasurementCsv(measurement) {
  const lines = ["distance_m,longitude,latitude,elevation_m"];
  for (const sample of measurement.terrainProfile.samples) {
    lines.push([
      sample.distanceMeters,
      sample.coordinate[0],
      sample.coordinate[1],
      sample.elevationMeters ?? ""
    ].join(","));
  }
  downloadBlob(`${slug(measurement.title)}-profile.csv`, `${lines.join("\n")}\n`, "text/csv;charset=utf-8");
}

function formatElevation(meters) {
  return `${Number(meters).toFixed(Math.abs(meters) >= 100 ? 0 : 1)} m`;
}

function formatGrade(percent) {
  return `${Number(percent).toFixed(Math.abs(percent) >= 100 ? 0 : 1)}% grade`;
}

function updateStatusbar(statusbar, context) {
  if (!statusbar) return;
  const {workspace, project, layers, state} = context;
  const visible = layers.filter((layer) => layer.visible).length;
  // Keep the disclosure and focused controls mounted while the pointer moves.
  let fields = statusbar.__opengeoFields;
  if (!fields) {
    fields = Object.fromEntries(["coords", "zoom", "bearing", "pitch", "layers", "loading", "message", "persistence", "body", "updated", "classification", "detailMessage"].map(key => {
      const field = textElement(key === "message" ? "strong" : "span", "");
      field.dataset.statusField = key;
      return [key, field];
    }));
    fields.loading.className = "gis-loading-disclosure";
    fields.loading.role = "status";
    fields.loading.ariaLive = "polite";
    fields.persistence.className = "gis-persistence-disclosure";
    const details = document.createElement("details");
    details.className = "gis-status-details";
    const panel = document.createElement("div");
    panel.className = "gis-status-details-panel";
    fields.projection = document.createElement("div");
    const telemetry = textElement("span", "Globe performance sampling…");
    telemetry.className = "gis-globe-metrics";
    telemetry.ariaLabel = "Local globe performance telemetry";
    panel.append(fields.persistence, fields.body, fields.projection, fields.updated, fields.classification, fields.detailMessage, telemetry);
    details.append(textElement("summary", "Map details"), panel);
    statusbar.replaceChildren(fields.coords, fields.zoom, fields.bearing, fields.pitch, fields.layers, fields.loading, fields.message, details);
    statusbar.__opengeoFields = fields;
  }
  const loading = browserLoadingSummary({
    loadingDatasetLayerIds: context.loadingDatasetLayerIds,
    liveFeatureRequests: context.liveFeatureRequests,
    layers,
    basemapActivationState: state.basemapActivationState
  });
  const values = {
    coords: `Coords: ${state.coordinateText}`,
    zoom: `Zoom: ${state.map?.getZoom().toFixed(2) ?? "—"}`,
    bearing: `Bearing: ${state.map?.getBearing().toFixed(1) ?? "—"}°`,
    pitch: `Tilt: ${state.map?.getPitch().toFixed(1) ?? "—"}°`,
    layers: `${visible}/${layers.length} layers`,
    loading: state.mapInitializationFailed ? "Map graphics unavailable."
      : !state.map ? "Starting map…"
      : !state.map.isStyleLoaded() ? "Loading background map…"
      : layers.some(layer => layer.visible !== false && context.failedDatasetLayerIds.has(layer.layerId))
        ? "Some selected layers could not load. Turn them off and on to retry." : loading.message,
    message: state.statusMessage,
    persistence: context.landingMode ? "Browser draft · not saved to your account" : context.publicDemo ? "browser-only draft" : context.persistenceMode === "fixture" ? "fixture · memory only" : "Project map · use Save to keep changes",
    body: state.spatialBody.title,
    updated: `Updated: ${project?.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : "not saved"}`,
    classification: `Classification: ${workspace?.classification ?? "unclassified"}`,
    detailMessage: state.statusMessage
  };
  for (const [key, value] of Object.entries(values)) {
    if (fields[key].textContent !== value) fields[key].textContent = value;
    fields[key].title = value;
  }
  fields.loading.dataset.pending = `${loading.pending}`;
  fields.loading.dataset.failed = `${loading.failed}`;
  fields.projection.replaceChildren(projectionDisclosure(context));
}

function setStatus(context, message) {
  context.state.statusMessage = message;
  context.state.activeMenu = null;
  updateStatusbar(context.shell.querySelector(".gis-statusbar"), context);
}

function openAddSource(context, sourceId) {
  const source = addSource(sourceId);
  context.state.activeAddSource = sourceId;
  context.state.activePanel = "add";
  context.state.rightOpen = true;
  setStatus(context, `${source?.[1] ?? "Data source"} source selected.`);
  context.render();
}

function revealProjectControl(selector) {
  const target = document.querySelector(selector);
  const details = target?.closest("details");
  if (details) details.open = true;
  target?.scrollIntoView({behavior: "smooth", block: "start"});
}

async function layerFromFile(file) {
  const id = `scratch_${slug(file.name)}_${Date.now()}`;
  let geojson;
  let sourceFormat;
  let interchangeReport = null;
  let source = null;
  if (/\.gpx$/i.test(file.name)) {
    const {readGpxFile} = await import("../lib/gpxImport.js");
    const parsed = await readGpxFile(file);geojson = parsed.geojson;source = parsed.source;
    sourceFormat = "gpx";interchangeReport = parsed.report;
  } else if (/\.(nmea|nme)$/i.test(file.name)) {
    const {readNmeaFile} = await import("../lib/nmeaImport.js");
    const parsed = await readNmeaFile(file);geojson = parsed.geojson;source = parsed.source;
    sourceFormat = "nmea";interchangeReport = parsed.report;
  } else if (/\.(wpt|plt|rte|pnt|evt)$/i.test(file.name)) {
    const {readOziFile} = await import("../lib/oziImport.js");
    const parsed = await readOziFile(file);geojson = parsed.geojson;source = parsed.source;
    sourceFormat = "ozi";interchangeReport = parsed.report;
  } else {
    const parsed = await readSpatialInterchangeFile(file);
    geojson = parsed.geojson;
    sourceFormat = parsed.source.format;
    interchangeReport = parsed.report;
  }
  if (geojson?.type !== "FeatureCollection") throw new Error("Expected a GeoJSON FeatureCollection or coordinate CSV.");
  const geometryTypes = [...new Set(geojson.features.map(feature => feature.geometry?.type).filter(Boolean))];
  const geometryType = geometryTypes.length > 1 ? "GeometryCollection" : geometryTypes[0] ?? "Point";
  return {
    geojson,
    source,
    layer: {
      layerId: id,
      datasetId: id,
      title: file.name.replace(/\.[^.]+$/, ""),
      sourceType: ["gpx", "nmea", "ozi"].includes(sourceFormat) ? "geojson-object" : `${sourceFormat}-object`,
      geometryType,
      visible: true,
      opacity: 0.9,
      order: 900,
      style: {...(sourceFormat === "ozi" ? {renderer: "single"} : {}), circleColor: "#06b6d4", circleRadius: 6, stroke: "#06b6d4", strokeWidth: 3, fill: "#06b6d4"},
      labels: {enabled: false, field: null},
      ...(source ? {metadata: {source: structuredClone(source), normalized: {crs: "OGC:CRS84", featureCount: geojson.features.length}, curated: {}, inferred: {}}} : {}),
      ...(interchangeReport ? {interchange: interchangeReport} : {})
    }
  };
}

async function openGpsLayer(context, file) {
  const format = /\.gpx$/i.test(file.name) ? "gpx" : /\.(nmea|nme)$/i.test(file.name) ? "nmea" : "ozi";
  const label = format === "ozi" ? "OziExplorer" : format.toUpperCase();
  const review = browserLayerReviewForProject(context);
  try {
    if (context.state.spatialBody.id !== "earth") throw new Error(`${label} uses Earth coordinates. Switch this map to Earth before opening it.`);
    const {layer, geojson, source} = await layerFromFile(file);
    review({layer, geojson, source, onAdd: async (reviewed, data) => {
      if (context.publicDemo) {
        context.addLayer(reviewed, data);rememberBrowserLayer(context, {layer: reviewed, geojson: data});
        fitLayer(context.state.map, reviewed, context.dataByLayerId);
        setStatus(context, `${reviewed.title} added. Save on this device to retain the map and original ${label}.`);
      } else {
        const entry = createTemporaryUpload({fileName: file.name, format, geojson: data, byteLength: source.bytes, metadata: reviewed.metadata});
        entry.layer.title = reviewed.title;entry.layer.geometryType = reviewed.geometryType;
        entry.layer.style = structuredClone(reviewed.style);
        context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});
        persistTemporaryWork(context);fitLayer(context.state.map, entry.layer, context.dataByLayerId);
        setStatus(context, `${reviewed.title} opened as temporary browser data. The original ${label} is retained here; account Save excludes temporary data.`);
      }
    }});
  } catch (error) {setStatus(context, `${label} could not open: ${error.message}`);}
}

async function openDelimitedLayer(context, file) {
  const project = context.project;
  const isCurrent = () => !context.disposed && context.shell.isConnected && context.project === project;
  const review = browserLayerReviewForProject(context);
  try {
    if (context.state.spatialBody.id !== "earth") throw new Error("Delimited Earth coordinates require an Earth map.");
    const {DelimitedTextImport} = await import("./DelimitedTextImport.js");
    if (!isCurrent()) return;
    await DelimitedTextImport({file, shell: context.shell, isCurrent, maximumFeatures: context.publicDemo ? 5000 : 1000, onReview: ({geojson, source, report, labelField, style, pointPresentation}) => {
      const id = `local_${crypto.randomUUID()}`, layer = {layerId: id, datasetId: id, title: file.name.replace(/\.[^.]+$/, "").slice(0, 160) || "Imported points", sourceType: "geojson-object", geometryType: "Point", visible: true, opacity: 0.9, order: 900,
        style, labels: {enabled: Boolean(labelField), field: labelField},
        metadata: {source: structuredClone(source), normalized: {crs: "OGC:CRS84", featureCount: geojson.features.length, elevationUnit: report.elevations ? "meter" : null, verticalDatum: report.mapping.verticalDatum}, curated: {pointPresentation}, inferred: {}}, interchange: report};
      review({layer, geojson, source, onAdd: async (reviewed, data) => {
        if (context.publicDemo) {
          context.addLayer(reviewed, data);rememberBrowserLayer(context, {layer: reviewed, geojson: data});fitLayer(context.state.map, reviewed, context.dataByLayerId);
          setStatus(context, `${reviewed.title} added. Save on this device to retain the map, mapping and original file.`);
        } else {
          const entry = createTemporaryUpload({fileName: file.name, format: "delimited-text", geojson: data, byteLength: source.bytes, metadata: reviewed.metadata});
          entry.layer.title = reviewed.title;entry.layer.style = structuredClone(reviewed.style);entry.layer.labels = structuredClone(reviewed.labels);
          context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});persistTemporaryWork(context);fitLayer(context.state.map, entry.layer, context.dataByLayerId);
          setStatus(context, `${reviewed.title} opened as temporary browser data. Account Save excludes these points and their original file.`);
        }
      }});
    }});
  } catch (error) {setStatus(context, `Delimited file could not open: ${error.message}`);}
}


const KML_CONTEXT_FIELDS = ["kmlInterchangeReport", "kmlNetworkLinkState", "kmlNetworkLinkApprovals",
  "kmlNetworkLinkDocuments", "kmlNetworkLinkInFlight", "kmlNetworkLinkTimers", "kmlNetworkLinkRegionActive",
  "kmlNetworkLinkRequestCount", "kmlNetworkLinkLastConditional", "selectedKmlPlaceId", "kmlMetadataDrafts"];

function editingKmlLayerId(context) {
  return context.state.kmlEditingLayerId ?? "kml-places";
}

function syncKmlLayerContext(context) {
  if (!context.publicDemo) return;
  const {state, layers} = context;
  const selected = layers.find(layer => layer.layerId === state.activeLayerId && layer.sourceType === "kml-places");
  const target = selected ?? layers.find(layer => layer.layerId === state.kmlEditingLayerId && layer.sourceType === "kml-places")
    ?? layers.find(layer => layer.sourceType === "kml-places");
  for (const id of state.kmlLayerRuntimes?.keys() ?? []) {
    if (!layers.some(layer => layer.layerId === id)) state.kmlLayerRuntimes.delete(id);
  }
  if ((target?.layerId ?? null) === (state.kmlEditingLayerId ?? null)) return;
  closeShapeEditor(context);
  closeImageOverlayEditor(context);
  for (const controller of state.kmlNetworkLinkInFlight.values()) controller.abort();
  for (const timer of state.kmlNetworkLinkTimers.values()) clearTimeout(timer);
  state.kmlNetworkLinkInFlight.clear();
  state.kmlNetworkLinkTimers.clear();
  const runtimes = state.kmlLayerRuntimes ??= new Map();
  if (state.kmlEditingLayerId) runtimes.set(state.kmlEditingLayerId,
    Object.fromEntries(KML_CONTEXT_FIELDS.map(key => [key, state[key]])));
  for (const id of runtimes.keys()) if (!layers.some(layer => layer.layerId === id)) runtimes.delete(id);
  state.kmlContextEpoch = (state.kmlContextEpoch ?? 0) + 1;
  state.kmlEditingLayerId = target?.layerId ?? null;
  state.kmlPlaces = target?.kmlDocument ?? null;
  const runtime = target && runtimes.get(target.layerId);
  Object.assign(state, runtime ?? {
    kmlInterchangeReport: target?.kmlInterchangeReport ?? emptyKmlReport(),
    kmlNetworkLinkState: target?.kmlNetworkLinkState ?? {schemaVersion: "1.0.0", receipts: []},
    kmlNetworkLinkApprovals: new Map(), kmlNetworkLinkDocuments: new Map(),
    kmlNetworkLinkInFlight: new Map(), kmlNetworkLinkTimers: new Map(), kmlNetworkLinkRegionActive: new Map(),
    kmlNetworkLinkRequestCount: 0, kmlNetworkLinkLastConditional: null,
    selectedKmlPlaceId: null, kmlMetadataDrafts: new Map()
  });
  state.mapAuthoringCreatedKmlPlaces = false;
  updateKmlPresentation(context.shell, state);
}

function kmlLayerForSave(context, layer) {
  const runtime = editingKmlLayerId(context) === layer.layerId ? context.state
    : context.state.kmlLayerRuntimes?.get(layer.layerId) ?? layer;
  return {kmlDocument: placesForSave(layer.kmlDocument),
    kmlInterchangeReport: kmlReportForSave(runtime.kmlInterchangeReport),
    kmlNetworkLinkState: kmlNetworkLinkStateForSave(runtime.kmlNetworkLinkState)};
}

async function importKmlPlaces(context, file, parsed = null, reviewedLayer = null) {
  parsed ??= await parseKmlFile(file);
  if (context.publicDemo) {
    const layer = {...(reviewedLayer ?? kmlPlacesLayer(parsed.document.name)),
      layerId: context.layers.some(layer => layer.layerId === "kml-places") ? `kml_${crypto.randomUUID()}` : "kml-places",
      kmlDocument: parsed.document, kmlInterchangeReport: parsed.report};
    context.addLayer(layer, parsed.geojson);
    rememberBrowserLayer(context, {layer, geojson: parsed.geojson, kml: parsed});
    fitLayer(context.state.map, layer, context.dataByLayerId);
    context.state.kmlContentsOpen = true;
    setStatus(context, `Added ${layer.title}. Existing Layers remain in this Project; Save locally to retain the changes.`);
    context.render();
    return;
  }
  closeShapeEditor(context);
  closeImageOverlayEditor(context);
  context.state.kmlMetadataDrafts?.clear();
  const existing = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
  if (existing) {
    removeMapLayer(context.state, existing.layerId);
    context.layers.splice(context.layers.indexOf(existing), 1);
    context.dataByLayerId.delete(existing.layerId);
  }
  context.state.kmlPlaces = parsed.document;
  context.state.mapAuthoringCreatedKmlPlaces = false;
  context.state.kmlInterchangeReport = parsed.report;
  for (const controller of context.state.kmlNetworkLinkInFlight.values()) controller.abort();
  context.state.kmlNetworkLinkInFlight.clear();
  context.state.kmlNetworkLinkApprovals.clear();
  context.state.kmlNetworkLinkDocuments.clear();
  context.state.kmlNetworkLinkState = {schemaVersion: "1.0.0", receipts: []};
  context.state.kmlNetworkLinkRequestCount = 0;
  context.state.kmlNetworkLinkLastConditional = null;
  context.state.leftPanelMode = "layers";
  context.state.kmlContentsOpen = true;
  updateKmlPresentation(context.shell, context.state);
  const layer = reviewedLayer ?? kmlPlacesLayer(parsed.document.name);
  layer.kmlDocument = parsed.document;
  context.addLayer(layer, parsed.geojson);
  if (context.publicDemo) rememberBrowserLayer(context, {layer, geojson: parsed.geojson, kml: parsed});
  fitLayer(context.state.map, layer, context.dataByLayerId);
  context.state.leftPanelMode = "layers";
  setStatus(
    context,
    `Imported ${parsed.source.format.toUpperCase()} as a map layer: ${parsed.geojson.features.length} supported features and ${parsed.report.counts.omitted} declared losses. Save or Save As to persist the bounded source and its style metadata.`
  );
  context.render();
}

function kmlPlacesLayer(title, datasetId = "kml-places") {
  return {
    layerId: "kml-places",
    datasetId,
    title,
    sourceType: "kml-places",
    geometryType: "Mixed",
    visible: true,
    opacity: 0.9,
    order: 900,
    style: {
      circleColor: "#fbbf24",
      circleRadius: 6,
      stroke: "#f59e0b",
      strokeWidth: 3,
      fill: "#f59e0b"
    },
    labels: {enabled: true, field: "name", color: "#fef3c7", haloColor: "#451a03", haloWidth: 1.5}
  };
}

function emptyKmlReport() {
  return {result: "pass", counts: {preserved: 0, normalized: 0, omitted: 0}, entries: []};
}

function applyKmlPlacesDocument(context, document, status) {
  context.state.kmlPlaces = document;
  pruneKmlNetworkLinkRuntime(context.state, document);
  const geojson = combinedKmlGeojson(context.state);
  context.state.kmlInterchangeReport ??= emptyKmlReport();
  updateKmlPresentation(context.shell, context.state);
  context.shell.dataset.kmlAuthoring = "changed";
  const layer = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
  if (layer) {
    layer.title = layer.metadata?.curated?.title ?? document.name;
    layer.kmlDocument = document;
    layer.kmlInterchangeReport = context.state.kmlInterchangeReport;
    context.dataByLayerId.set(layer.layerId, geojson);
    if (context.state.map?.isStyleLoaded()) repaintLayer(context, layer);
  } else {
    context.addLayer({...kmlPlacesLayer(document.name), kmlDocument: document, kmlInterchangeReport: context.state.kmlInterchangeReport}, geojson);
  }
  context.state.leftPanelMode = "layers";
  context.state.kmlContentsOpen = true;
  setStatus(context, status);
  context.render();
}

function pruneKmlNetworkLinkRuntime(state, document) {
  const links = new Map();
  const visit = (children) => {
    for (const child of children ?? []) {
      if (child.kind === "network-link") links.set(child.id, child.link.href);
      if (child.kind === "folder") visit(child.children);
    }
  };
  visit(document?.children);
  const invalid = (id, sourceHref = null) => !links.has(id)
    || (sourceHref !== null && links.get(id) !== sourceHref);
  for (const [id, controller] of state.kmlNetworkLinkInFlight) if (invalid(id)) {
    controller.abort();
    state.kmlNetworkLinkInFlight.delete(id);
  }
  for (const [key, timer] of state.kmlNetworkLinkTimers) if (invalid(String(key).split(":", 1)[0])) {
    clearTimeout(timer);
    state.kmlNetworkLinkTimers.delete(key);
  }
  for (const [id, approval] of state.kmlNetworkLinkApprovals) if (invalid(id, approval.href)) {
    state.kmlNetworkLinkApprovals.delete(id);
  }
  for (const [id, linked] of state.kmlNetworkLinkDocuments) if (invalid(id, linked.sourceHref)) {
    state.kmlNetworkLinkDocuments.delete(id);
  }
  state.kmlNetworkLinkState = {
    schemaVersion: "1.0.0",
    receipts: state.kmlNetworkLinkState.receipts.filter(({linkId, sourceHref}) => !invalid(linkId, sourceHref))
  };
}

function defaultAuthoredKmlStyle(kind, color) {
  if (!/^[0-9a-fA-F]{8}$/.test(color)) throw Object.assign(new Error("places_style_color_invalid"), {code: "places_style_color_invalid"});
  if (kind === "Point") return {icon: {color, scale: 1}};
  if (kind === "LineString") return {line: {color, width: 3}};
  return {line: {color, width: 2}, polygon: {color, fill: true, outline: true}};
}

function kmlContainerOptions(document, excludedId = null) {
  const options = [];
  const visit = (container, depth, blocked) => {
    const nextBlocked = blocked || container.id === excludedId;
    if (!nextBlocked) options.push([container.id, `${"— ".repeat(depth)}${container.name}`]);
    for (const child of container.children ?? []) if (child.kind === "folder") visit(child, depth + 1, nextBlocked);
  };
  visit(document, 0, false);
  return options;
}

function findKmlPlaceForUi(container, id) {
  if (!id) return null;
  if (container.id === id) return container;
  for (const child of container.children ?? []) {
    if (child.id === id) return child;
    if (child.kind === "folder") {
      const nested = findKmlPlaceForUi(child, id);
      if (nested) return nested;
    }
  }
  return null;
}

function findKmlParentForUi(container, id) {
  for (const child of container.children ?? []) {
    if (child.id === id) return container;
    if (child.kind === "folder") {
      const nested = findKmlParentForUi(child, id);
      if (nested) return nested;
    }
  }
  return null;
}

function findNewestKmlPlace(previous, next) {
  const known = new Set();
  const collect = (children) => {
    for (const child of children ?? []) {
      known.add(child.id);
      if (child.kind === "folder") collect(child.children);
    }
  };
  collect(previous?.children);
  let created = null;
  const locate = (children) => {
    for (const child of children ?? []) {
      if (!known.has(child.id)) return child;
      if (child.kind === "folder") {
        const nested = locate(child.children);
        if (nested) return nested;
      }
    }
    return null;
  };
  created = locate(next?.children);
  return created;
}

function countPlaces(document) {
  const counts = {folders: 0, placemarks: 0, overlays: 0, networkLinks: 0};
  const visit = (children) => {
    for (const child of children ?? []) {
      if (child.kind === "folder") {
        counts.folders += 1;
        visit(child.children);
      } else if (child.kind === "placemark") {
        counts.placemarks += 1;
      } else if (String(child.kind).endsWith("-overlay")) {
        counts.overlays += 1;
      } else if (child.kind === "network-link") {
        counts.networkLinks += 1;
      }
    }
  };
  visit(document?.children);
  return counts;
}

function kmlResourceBytes(document) {
  return (document?.resources ?? []).reduce((sum, resource) => sum + (Number(resource.byteLength) || 0), 0);
}

function updateKmlPresentation(shell, state) {
  if (!state.kmlPlaces) {
    for (const key of ["kmlImport", "kmlFolders", "kmlPlacemarks", "kmlOverlays", "kmlNetworkLinks", "kmlLinkedFeatures", "kmlNetworkRequests", "kmlNetworkConditional", "kmlNetworkReceipts", "kmlLosses", "kmlSharedStyles", "kmlSchemas", "kmlResources", "kmlResourceBytes"]) {
      delete shell.dataset[key];
    }
    return;
  }
  const counts = countPlaces(state.kmlPlaces);
  shell.dataset.kmlImport = state.kmlInterchangeReport?.result ?? "restored";
  shell.dataset.kmlFolders = String(counts.folders);
  shell.dataset.kmlPlacemarks = String(counts.placemarks);
  shell.dataset.kmlOverlays = String(counts.overlays);
  shell.dataset.kmlNetworkLinks = String(counts.networkLinks);
  shell.dataset.kmlLinkedFeatures = String(linkedNetworkLinkFeatureCount(state));
  shell.dataset.kmlNetworkRequests = String(state.kmlNetworkLinkRequestCount);
  shell.dataset.kmlNetworkConditional = state.kmlNetworkLinkLastConditional === null
    ? "none"
    : String(state.kmlNetworkLinkLastConditional);
  shell.dataset.kmlNetworkReceipts = String(state.kmlNetworkLinkState.receipts.length);
  shell.dataset.kmlLosses = String(state.kmlInterchangeReport?.counts?.omitted ?? 0);
  shell.dataset.kmlSharedStyles = String(state.kmlPlaces.styles?.length ?? 0);
  shell.dataset.kmlSchemas = String(state.kmlPlaces.schemas?.length ?? 0);
  shell.dataset.kmlResources = String(state.kmlPlaces.resources?.length ?? 0);
  shell.dataset.kmlResourceBytes = String(kmlResourceBytes(state.kmlPlaces));
}

function zoomToKmlPlace(context, place) {
  const geojson = context.dataByLayerId.get(editingKmlLayerId(context));
  const feature = geojson?.features?.find(({id}) => id === place.id);
  if (!feature) return;
  const bounds = geojsonBounds(feature);
  if (bounds) context.state.map?.fitBounds(bounds, {padding: 90, maxZoom: 16, duration: 350});
  if (feature.geometry?.type === "Point") {
    context.state.map?.easeTo({center: feature.geometry.coordinates.slice(0, 2), zoom: 15, duration: 350});
  }
  setStatus(context, `Flying to ${place.name}.`);
}

function showFeaturePopup(map, event, dataset) {
  const feature = event.features?.[0];
  if (!feature) return;
  const content = accessibleFeaturePopup({
    title: dataset?.title ?? "Feature",
    properties: feature.properties
  });
  const popup = workbenchRenderer(map).createPopup({maxWidth: "340px"})
    .setLngLat(event.lngLat)
    .setDOMContent(content)
    .addTo(map);
  queueMicrotask(() => content.focus());
  return popup;
}

function zoomToFeature(context, layer, feature) {
  const bounds = geojsonBounds(feature);
  if (bounds) context.state.map?.fitBounds(bounds, {padding: 80, maxZoom: 15, duration: 350});
  if (feature.geometry?.type === "Point") {
    const content = accessibleFeaturePopup({
      title: featureTitle(feature, layer),
      properties: feature.properties
    });
    context.rendererAdapter.createPopup({maxWidth: "320px"})
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(content)
      .addTo(context.state.map);
    queueMicrotask(() => content.focus());
  }
}

function applyLocalDraft({
  workspace,
  project,
  layers,
  state,
  publicDemo = false,
  landingMode = false,
  draftScopeId = null,
  presentationOnly = false,
  dataByLayerId = new Map()
}) {
  if (!workspace?.workspaceId || typeof localStorage === "undefined") return;
  try {
    const key = draftStorageKey(workspace, publicDemo, draftScopeId);
    const draft = upgradeMapDefinition(JSON.parse(localStorage.getItem(key) ?? "null"));
    if (publicDemo && !landingMode && draft?.demoDate !== demoDateKey()) {
      return;
    }
    if (!Array.isArray(draft?.layers) || draft.layers.length > 64) return;
    if (publicDemo && project && draft.extensions?.opengeoPrintLayouts) {
      const layouts = draft.extensions.opengeoPrintLayouts;
      project.extensions = {...project.extensions,
        opengeoPrintLayouts: projectPrintLayouts({id: layouts.projectId, definition: draft})};
    }
    // The upgraded draft has already validated this token-free preference.
    // Preserve server/Project extensions that are unrelated to renderer choice.
    if (!presentationOnly && project && draft.extensions?.opengeoRenderer) {
      project.extensions = {...project.extensions,
        opengeoRenderer: structuredClone(draft.extensions.opengeoRenderer)};
    }
    if (publicDemo) {
      const savedIds = new Set(draft.layers.map(({layerId}) => layerId));
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        if (!savedIds.has(layers[index].layerId)) {
          dataByLayerId.delete(layers[index].layerId);
          layers.splice(index, 1);
        }
      }
    }
    if (project && Array.isArray(draft.layerTree)) {
      const authorizedIds = new Set(layers.map(layer => layer.layerId));
      const retainReferences = nodes => nodes.flatMap(node => node.kind === "group"
        ? [{...node, children: retainReferences(node.children)}]
        : publicDemo || authorizedIds.has(node.layerId) ? [node] : []);
      project.layerTree = retainReferences(orderedProjectLayerTree(draft.layerTree, layers));
      state.openLayerTreeGroupIds = initialOpenLayerTreeGroupIds(project.layerTree);
    }
    if (publicDemo && project) {
      if (typeof draft.title === "string") {project.title = draft.title; project.browserDraftRestored = true;}
    }
    const draftById = new Map(draft.layers.map((layer) => [layer.layerId, layer]));
    for (const layer of layers) {
      const saved = draftById.get(layer.layerId);
      if (!saved) continue;
      if (presentationOnly && (saved.datasetId !== layer.datasetId
        || (saved.datasetVersionId ?? null) !== (layer.datasetVersionId ?? null)
        || (saved.sourceVersion ?? null) !== (layer.sourceVersion ?? null))) continue;
      if (publicDemo && saved.metadata) layer.metadata = structuredClone(saved.metadata);
      if (publicDemo && saved.kmlDocument) Object.assign(layer, {kmlDocument: placesForProject({kmlPlaces: saved.kmlDocument}), kmlInterchangeReport: kmlReportForProject(saved), kmlNetworkLinkState: kmlNetworkLinkStateForProject(saved)});
      layer.visible = saved.visible;
      layer.opacity = saved.opacity;
      const mergedStyle = {...layer.style, ...saved.style};
      layer.style = ["Point", "MultiPoint"].includes(layer.geometryType) && hasPointSymbolStyle(mergedStyle)
        ? normalizePointSymbolStyle(mergedStyle) : mergedStyle;
      layer.labels = {...layer.labels, ...saved.labels};
      if (saved.styleReference) layer.styleReference = structuredClone(saved.styleReference);
      else if (draft.styleBindingsRecorded === true) delete layer.styleReference;
    }
    if (presentationOnly) {
      state.restoredMapViews = Array.isArray(draft.mapViews) && draft.mapViews.length <= 8
        ? draft.mapViews.map(view => normalizeMapView(view)) : null;
      replaceLayerOrder(layers, restoreSavedLayerOrder(layers, draft.layers));
      return;
    }
    if (publicDemo) {
      const existingIds = new Set(layers.map(({layerId}) => layerId));
      for (const saved of draft.layers) {
        if (!existingIds.has(saved.layerId)) {
          const restored = restoreDemoLayer(saved);
          if (!restored) continue;
          layers.push(restored);
          existingIds.add(restored.layerId);
        }
        const kml = layers.find(layer => layer.layerId === saved.layerId)?.kmlDocument;
        if (kml) dataByLayerId.set(saved.layerId, placesToGeojson(kml));
        if (saved.geojson?.type === "FeatureCollection" && Array.isArray(saved.geojson.features)) {
          dataByLayerId.set(saved.layerId, saved.geojson);
        }
      }
      state.activeLayerId = layers.some(({layerId}) => layerId === draft.activeLayerId)
        ? draft.activeLayerId
        : layers[0]?.layerId ?? null;
    }
    state.colorMode = preferredWorkbenchColorMode();
    state.currentBasemapId = visibleBasemap(draft);
    state.basemapOpacity = savedBasemapOpacity(draft);
    state.spatialBody = spatialBodyForProject(draft);
    state.measurements = normalizeSavedMeasurements(draft.measurements, {spatialBody: state.spatialBody});
    state.selectedMeasurementId = state.measurements[0]?.id ?? null;
    state.editingMeasurementId = null;
    state.customBasemaps = projectBasemapChoices(draft);
    state.historicalImagery = historicalImageryForProject(draft);
    state.historicalAvailability = reviewedHistoricalDates(state.historicalImagery.sourceId);
    state.historicalAvailabilityStatus = "reviewed-capability-receipt";
    state.historicalAvailabilityMessage = "Showing the last reviewed provider time-domain dates. Visible pixels can still contain gaps or clouds.";
    state.cameraTour = cameraTourForProject(draft);
    state.cameraTourSelectedId = state.cameraTour?.keyframes?.[0]?.id ?? null;
    state.cameraTourElapsedMilliseconds = 0;
    if (["globe", "mercator"].includes(draft.projection)) {
      state.globe = normalizeProjection(draft.projection) === "globe";
    }
    const terrain = terrainForProject(draft);
    state.terrainEnabled = state.spatialBody.id === "earth" && terrain.enabled;
    state.terrainExaggeration = terrain.exaggeration;
    state.openScene3dEnabled = state.spatialBody.id === "earth" && openScene3dForProject(draft).enabled;
    const draftPlaces = placesForProject(draft);
    if (draftPlaces && !draft.kmlLayerDocuments) {
      state.kmlPlaces = draftPlaces;
      state.kmlInterchangeReport = kmlReportForProject(draft);
      const kmlLayer = layers.find(({layerId}) => layerId === "kml-places")
        ?? kmlPlacesLayer(draftPlaces.name);
      if (!layers.includes(kmlLayer)) layers.push(kmlLayer);
      kmlLayer.kmlDocument = draftPlaces;
      kmlLayer.kmlInterchangeReport = kmlReportForProject(draft);
      kmlLayer.kmlNetworkLinkState = kmlNetworkLinkStateForProject(draft);
      dataByLayerId.set(kmlLayer.layerId, placesToGeojson(draftPlaces));
    }
    state.kmlNetworkLinkState = kmlNetworkLinkStateForProject(draft);
    state.processingModels = normalizeProcessingModels(draft.models);
    state.processingHistory = normalizeProcessingHistory(draft.processingHistory);
    state.activeProcessingModelId = state.processingModels.some(({id}) => id === draft.activeProcessingModelId)
      ? draft.activeProcessingModelId
      : state.processingModels[0]?.id ?? null;
    const draftPortal = portalConfigurationForProject(draft);
    if (draftPortal) {
      state.portalConfiguration = draftPortal;
      state.portalConversionReport = portalReportForProject(draft);
      state.portalExtensions = portalExtensionForProject(draft);
    }
    state.restoredMapViews = Array.isArray(draft.mapViews) && draft.mapViews.length <= 8
      ? draft.mapViews.map((view) => normalizeMapView(view))
      : null;
    replaceLayerOrder(layers, restoreSavedLayerOrder(layers, draft.layers));
  } catch {
    // Server project records remain authoritative when local drafts are invalid.
  }
}

function restoreTemporaryLayers(context) {
  const storage = browserLocalStorage();
  if (!storage) return;
  const key = temporaryContextStorageKey(context);
  const restored = restoreTemporaryWork(storage.getItem(key), {
    workspaceId: context.workspace?.workspaceId,
    scopeId: temporaryWorkScope(context)
  });
  for (const {layer, geojson} of restored.entries) {
    if (context.layers.some(({layerId}) => layerId === layer.layerId)) continue;
    context.layers.unshift(layer);
    context.dataByLayerId.set(layer.layerId, geojson);
  }
  context.layers.forEach((layer, order) => layer.order = order);
  if (restored.entries.length && !context.state.activeLayerId) {
    context.state.activeLayerId = restored.entries[0].layer.layerId;
  }
  if (restored.expired || restored.rejected) {
    if (restored.entries.length) persistTemporaryWork(context);
    else storage.removeItem(key);
    context.state.temporaryWorkMessage = [
      restored.expired ? `${restored.expired} expired temporary ${restored.expired === 1 ? "layer was" : "layers were"} removed.` : null,
      restored.rejected ? `${restored.rejected} invalid temporary ${restored.rejected === 1 ? "entry was" : "entries were"} rejected.` : null
    ].filter(Boolean).join(" ");
  }
}

function persistTemporaryWork(context) {
  const storage = browserLocalStorage();
  if (!storage) return false;
  const temporaryLayers = context.layers.filter(isTemporaryLayer);
  const key = temporaryContextStorageKey(context);
  try {
    if (!temporaryLayers.length) {
      storage.removeItem(key);
      return true;
    }
    storage.setItem(key, serializeTemporaryWork({
      workspaceId: context.workspace?.workspaceId,
      scopeId: temporaryWorkScope(context),
      layers: temporaryLayers,
      dataByLayerId: context.dataByLayerId
    }));
    return true;
  } catch (error) {
    context.state.temporaryWorkMessage = `Temporary work could not be saved (${error?.code ?? "browser_storage_unavailable"}).`;
    return false;
  }
}

function clearTemporaryLayers(context) {
  cancelTemporaryEdit(context, {render: false, announce: false});
  const temporaryLayers = context.layers.filter(isTemporaryLayer);
  for (const layer of temporaryLayers) {
    removeMapLayer(context.state, layer.layerId);
    const index = context.layers.indexOf(layer);
    if (index >= 0) context.layers.splice(index, 1);
    context.dataByLayerId.delete(layer.layerId);
  }
  context.state.temporaryPromotionLayerId = null;
  if (!context.layers.some(({layerId}) => layerId === context.state.activeLayerId)) {
    context.state.activeLayerId = context.layers[0]?.layerId ?? null;
  }
  browserLocalStorage()?.removeItem(temporaryContextStorageKey(context));
  context.state.temporaryWorkMessage = `${temporaryLayers.length} temporary ${temporaryLayers.length === 1 ? "layer" : "layers"} removed. No authoritative data changed.`;
  setStatus(context, context.state.temporaryWorkMessage);
  context.render();
}

function temporaryContextStorageKey(context) {
  return temporaryWorkStorageKey(context.workspace?.workspaceId, temporaryWorkScope(context));
}

function temporaryWorkScope(context) {
  return context.draftScopeId
    ?? context.project?.mapId
    ?? context.project?.projectId
    ?? context.workspace?.workspaceId
    ?? "default";
}

function readBrowserDraft(key) {
  try {
    return browserLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function browserLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createLocalDraft(context) {
  const {workspace, layers, state} = context;
  const persistentLayers = layers.filter((layer) => !isTemporaryLayer(layer));
  for (const layer of persistentLayers) {
    if (Object.hasOwn(layer.labels ?? {}, "fontRef")) validateMapFontRef(layer.labels.fontRef);
    validateManagedDisplayReference(layer);
  }
  const savedAt = new Date().toISOString();
  const persistence = context.localProjectRecord
    ? {mode: "browser-personal", uploaded: false, published: false}
    : context.landingMode
    ? {mode: "browser-draft", uploaded: false, published: false}
    : context.publicDemo
    ? {mode: "browser-only-demo", resets: "daily", uploaded: false, published: false}
    : {
        provider: context.storage.provider,
        bucket: context.storage.bucket,
        key: projectObjectKey(context)
      };
  const draft = {
    schemaVersion: mapDefinitionVersionForLayers(persistentLayers, state.measurements ?? []),
    ...(context.publicDemo ? {title: context.project?.title ?? "Browser Project"} : {}),
    styleBindingsRecorded: true,
    workspaceId: workspace.workspaceId,
    tenantId: workspace.tenantId,
    ...(context.publicDemo && !context.landingMode && !context.localProjectRecord ? {demoDate: demoDateKey()} : {}),
    colorMode: state.colorMode,
    spatialBody: structuredClone(state.spatialBody),
    projection: state.globe ? "globe" : "mercator",
    terrain: terrainForSave(state.terrainEnabled, context.project?.terrain),
    openScene3d: openScene3dForSave(state.openScene3dEnabled),
    ...(context.publicDemo ? {kmlLayerDocuments: true} : {}),
    kmlPlaces: placesForSave(state.kmlPlaces),
    kmlInterchangeReport: kmlReportForSave(state.kmlInterchangeReport),
    kmlNetworkLinkState: kmlNetworkLinkStateForSave(state.kmlNetworkLinkState),
    ...(state.portalConfiguration ? {portal: normalizePortalConfiguration(state.portalConfiguration)} : {}),
    extensions: mapExtensionsForSave(context),
    mapViews: mapViewsForSave(state.map, context.project?.mapViews),
    basemaps: basemapsForSave(context),
    bookmarks: context.project?.bookmarks ?? [],
    ...(Array.isArray(context.project?.layerTree)
      ? {layerTree: orderedProjectLayerTree(context.project.layerTree, persistentLayers)}
      : {}),
    activeLayerId: persistentLayers.some(({layerId}) => layerId === state.activeLayerId)
      ? state.activeLayerId
      : persistentLayers[0]?.layerId ?? null,
    activeProcessingModelId: state.activeProcessingModelId ?? null,
    models: structuredClone(state.processingModels ?? []),
    processingHistory: structuredClone(state.processingHistory ?? []),
    measurements: structuredClone(state.measurements ?? []),
    layers: persistentLayers.map((layer) => ({
      layerId: layer.layerId,
      datasetId: layer.datasetId,
      title: layer.title,
      sourceType: layer.sourceType,
      sourceVersion: layer.sourceVersion,
      datasetVersionId: layer.datasetVersionId,
      ...(layer.managedDisplayId ? {managedDisplayId: layer.managedDisplayId} : {}),
      objectId: layer.objectId,
      sourceUrl: layer.sourceUrl ?? layer.tileUrl,
      ...(context.publicDemo && layer.tileUrl ? {tileUrl: layer.tileUrl} : {}),
      sourceConfiguration: layer.sourceConfiguration,
      ...(context.publicDemo ? {browserCatalogId: layer.browserCatalogId, browserDraftData: layer.browserDraftData} : {}),
      ...(context.publicDemo && layer.metadata ? {metadata: structuredClone(layer.metadata)} : {}),
      ...(context.publicDemo && layer.sourceType === "kml-places" ? kmlLayerForSave(context, layer) : {}),
      sourceLayer: layer.sourceLayer,
      sharedSourceId: layer.sharedSourceId,
      portalCatalogSource: layer.portalCatalogSource,
      ...(context.publicDemo && layer.fixtureSource === true ? {fixtureSource: true} : {}),
      attribution: layer.attribution,
      tileSize: layer.tileSize,
      scheme: layer.scheme,
      minZoom: layer.minZoom,
      maxZoom: layer.maxZoom,
      geometryType: layer.geometryType,
      bbox: layer.bbox,
      visible: layer.visible,
      opacity: layer.opacity,
      ...(layer.opacityMode ? {opacityMode: validateOpacityMode(layer)} : {}),
      ...(layer.pointClustering ? {pointClustering: {...validatePointClustering(layer.pointClustering)}} : {}),
      order: layer.order,
      ...(layer.filter?{filter:structuredClone(validateMapFilter(layer.filter))}:{}),
      style: ["Point", "MultiPoint"].includes(layer.geometryType) && hasPointSymbolStyle(layer.style) ? normalizePointSymbolStyle(layer.style) : layer.style,
      ...(layer.styleReference ? {styleReference: structuredClone(validateLayerStyleReference(layer.styleReference))} : {}),
      labels: layer.labels,
      ...(context.publicDemo
        && layer.browserDraftData !== false
        && context.dataByLayerId.get(layer.layerId)
        ? {geojson: context.dataByLayerId.get(layer.layerId)}
        : {})
    })),
    updatedAt: savedAt,
    updatedBy: "browser-session",
    persistence
  };
  return draft;
}

function localDraftSignature(context, definition = createLocalDraft(context)) {
  const {updatedAt, updatedBy, activeLayerId, activeProcessingModelId, persistence, demoDate, ...draft} = definition;
  return JSON.stringify(draft, (key, value) => typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1e6) / 1e6 : value);
}

function saveLocalDraft(context) {
  const {workspace} = context;
  if (!workspace?.workspaceId || typeof localStorage === "undefined") return;
  const serialized = JSON.stringify(createLocalDraft(context), null, 2);
  if (context.publicDemo && serialized.length > 2_000_000) {
    setStatus(context, "This demo project is too large for the 2 MB browser-only draft. Export it instead or open Studio to persist governed data.");
    return;
  }
  try {
    localStorage.setItem(
      draftStorageKey(workspace, context.publicDemo, context.draftScopeId),
      serialized
    );
  } catch {
    setStatus(context, "The browser could not save this local draft. Export the project before leaving the page.");
    return;
  }
  setStatus(context, context.landingMode
    ? "Local scratch map saved in this browser. It never changes a shared project."
    : context.publicDemo
      ? "Browser-only demo draft saved. It resets daily and never changes published or private data."
    : `Browser draft saved. Server persistence target: ${projectS3Uri(context)}.`);
  context.localDraftBaseline = localDraftSignature(context);
  return true;
}

function resetPublicDemo(context) {
  if (!context.publicDemo) return;
  clearBrowserLayerCatalog(browserLocalStorage());
  try {
    localStorage.removeItem(draftStorageKey(context.workspace, true, context.draftScopeId));
  } catch {
    // Reloading still restores the checked-in public demo when storage is unavailable.
  }
  location.reload();
}

function draftStorageKey(workspace, publicDemo = false, scopeId = null) {
  const workspaceId = draftStorageSegment(workspace?.workspaceId, "default");
  if (!publicDemo) {
    if (scopeId == null) return `opengeo.project.${workspaceId}`;
    const scope = draftStorageSegment(scopeId, null);
    if (!scope) throw new Error("Invalid browser draft scope");
    return `opengeo.project.${workspaceId}.${scope}`;
  }
  const scope = draftStorageSegment(scopeId, workspaceId);
  return `opengeo.public-demo.${workspaceId}.${scope}`;
}

function draftStorageSegment(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : fallback;
}

function demoDateKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function restoreDemoLayer(value) {
  if (!value || typeof value !== "object"
    || typeof value.layerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.layerId)
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 240
    || typeof value.sourceType !== "string" || value.sourceType.length > 80) {
    return null;
  }
  return cloneLayer({
    layerId: value.layerId,
    datasetId: typeof value.datasetId === "string" ? value.datasetId : value.layerId,
    title: value.title.trim(),
    sourceType: value.sourceType,
    sourceVersion: value.sourceVersion,
    ...(value.filter?{filter:structuredClone(validateMapFilter(value.filter))}:{}),
    browserCatalogId: typeof value.browserCatalogId === "string" ? value.browserCatalogId : undefined,
    browserDraftData: value.browserDraftData !== false,
    ...(value.metadata && typeof value.metadata === "object" ? {metadata: structuredClone(value.metadata)} : {}),
    ...(value.sourceType === "kml-places" ? {kmlDocument: placesForProject({kmlPlaces: value.kmlDocument}), kmlInterchangeReport: kmlReportForProject(value), kmlNetworkLinkState: kmlNetworkLinkStateForProject(value)} : {}),
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : undefined,
    tileUrl: typeof value.tileUrl === "string" ? value.tileUrl : undefined,
    sourceConfiguration: value.sourceConfiguration && typeof value.sourceConfiguration === "object"
      ? structuredClone(value.sourceConfiguration)
      : undefined,
    sourceLayer: typeof value.sourceLayer === "string" ? value.sourceLayer : undefined,
    sharedSourceId: typeof value.sharedSourceId === "string" ? value.sharedSourceId : undefined,
    portalCatalogSource: typeof value.portalCatalogSource === "string" ? value.portalCatalogSource : undefined,
    fixtureSource: value.fixtureSource === true,
    governedSource: false,
    attribution: typeof value.attribution === "string" ? value.attribution : undefined,
    tileSize: Number.isInteger(value.tileSize) ? value.tileSize : undefined,
    scheme: value.scheme === "tms" ? "tms" : "xyz",
    minZoom: Number.isInteger(value.minZoom) ? value.minZoom : undefined,
    maxZoom: Number.isInteger(value.maxZoom) ? value.maxZoom : undefined,
    geometryType: typeof value.geometryType === "string" ? value.geometryType : "Geometry",
    bbox: Array.isArray(value.bbox) ? [...value.bbox] : undefined,
    visible: value.visible !== false,
    ...(value.opacityMode ? {opacityMode: validateOpacityMode(value)} : {}),
    ...(value.pointClustering ? {pointClustering: {...validatePointClustering(value.pointClustering)}} : {}),
    opacity: Number.isFinite(value.opacity) ? Math.max(0, Math.min(1, value.opacity)) : 1,
    order: Number.isFinite(value.order) ? value.order : 500,
    style: value.style && typeof value.style === "object" ? structuredClone(value.style) : {},
    labels: value.labels && typeof value.labels === "object"
      ? structuredClone(value.labels)
      : {enabled: false, field: null}
  });
}

export function currentProjectDefinition(context) {
  const {layers, state} = context;
  const persistentLayers = layers.filter((layer) => !isTemporaryLayer(layer));
  for (const layer of persistentLayers) {
    if (Object.hasOwn(layer.labels ?? {}, "fontRef")) validateMapFontRef(layer.labels.fontRef);
    validateManagedDisplayReference(layer);
  }
  for (const layer of persistentLayers) cogDisplayOptions(layer);
  return {
    ...(context.publicDemo ? {title: context.project?.title ?? "Browser Project"} : {}),
    schemaVersion: mapDefinitionVersionForLayers(persistentLayers, state.measurements ?? []),
    mapViews: mapViewsForSave(state.map, context.project?.mapViews),
    basemaps: basemapsForSave(context),
    bookmarks: context.project?.bookmarks ?? [],
    ...(Array.isArray(context.project?.layerTree)
      ? {layerTree: orderedProjectLayerTree(context.project.layerTree, persistentLayers)}
      : {}),
    activeLayerId: persistentLayers.some(({layerId}) => layerId === state.activeLayerId)
      ? state.activeLayerId
      : persistentLayers[0]?.layerId ?? null,
    activeProcessingModelId: state.activeProcessingModelId ?? null,
    models: structuredClone(state.processingModels ?? []),
    processingHistory: structuredClone(state.processingHistory ?? []),
    measurements: structuredClone(state.measurements ?? []),
    spatialBody: structuredClone(state.spatialBody ?? spatialBodyDefinition()),
    projection: state.globe ? "globe" : "mercator",
    terrain: terrainForSave(state.terrainEnabled, context.project?.terrain),
    openScene3d: openScene3dForSave(state.openScene3dEnabled),
    ...(context.publicDemo ? {kmlLayerDocuments: true} : {}),
    kmlPlaces: placesForSave(state.kmlPlaces),
    kmlInterchangeReport: kmlReportForSave(state.kmlInterchangeReport),
    kmlNetworkLinkState: kmlNetworkLinkStateForSave(state.kmlNetworkLinkState),
    ...(state.portalConfiguration ? {portal: normalizePortalConfiguration(state.portalConfiguration)} : {}),
    extensions: mapExtensionsForSave(context),
    colorMode: state.colorMode,
    layers: persistentLayers.map((layer) => ({
      layerId: layer.layerId,
      datasetId: layer.datasetId,
      title: layer.title,
      sourceType: layer.sourceType,
      sourceVersion: layer.sourceVersion,
      datasetVersionId: layer.datasetVersionId,
      ...(layer.managedDisplayId ? {managedDisplayId: layer.managedDisplayId} : {}),
      objectId: layer.objectId,
      sourceUrl: layer.sourceUrl ?? layer.tileUrl,
      sourceConfiguration: layer.sourceConfiguration,
      ...(context.publicDemo ? {
        browserCatalogId: layer.browserCatalogId, browserDraftData: layer.browserDraftData,
        ...(layer.tileUrl ? {tileUrl: layer.tileUrl} : {}),
        ...(layer.metadata ? {metadata: structuredClone(layer.metadata)} : {}),
        ...(layer.browserDraftData !== false && context.dataByLayerId.has(layer.layerId) && layer.sourceType !== "kml-places" ? {geojson: context.dataByLayerId.get(layer.layerId)} : {}),
        ...(layer.sourceType === "kml-places" ? kmlLayerForSave(context, layer) : {})
      } : {}),
      sourceLayer: layer.sourceLayer,
      sharedSourceId: layer.sharedSourceId,
      portalCatalogSource: layer.portalCatalogSource,
      geometryType: layer.geometryType,
      bbox: layer.bbox,
      visible: layer.visible,
      opacity: layer.opacity,
      ...(layer.opacityMode ? {opacityMode: validateOpacityMode(layer)} : {}),
      ...(layer.pointClustering ? {pointClustering: {...validatePointClustering(layer.pointClustering)}} : {}),
      order: layer.order,
      ...(layer.filter?{filter:structuredClone(validateMapFilter(layer.filter))}:{}),
      style: ["Point", "MultiPoint"].includes(layer.geometryType) && hasPointSymbolStyle(layer.style) ? normalizePointSymbolStyle(layer.style) : layer.style,
      ...(layer.styleReference ? {styleReference: structuredClone(validateLayerStyleReference(layer.styleReference))} : {}),
      labels: layer.labels
    }))
  };
}

function mapExtensionsForSave(context) {
  const extensions = context.project?.extensions && typeof context.project.extensions === "object"
    ? structuredClone(context.project.extensions)
    : {};
  if (context.rendererPreference) extensions.opengeoRenderer = {id:context.rendererPreference};
  if (Object.hasOwn(extensions, "opengeoRenderer")) validateRendererPreference(extensions.opengeoRenderer);
  if (context.state.portalConfiguration) {
    extensions.geomoose = {
      ...(extensions.geomoose && typeof extensions.geomoose === "object" ? extensions.geomoose : {}),
      ...(context.state.portalExtensions ?? {}),
      schemaVersion: "1.0.0",
      upstream: context.state.portalConfiguration.upstream ?? null,
      ...(context.state.portalConversionReport ? {conversionReport: structuredClone(context.state.portalConversionReport)} : {})
    };
  }
  if (context.state.historicalImagery?.enabled
    || context.state.historicalImagery?.sunlight?.enabled
    || context.project?.extensions?.historicalImagery) {
    extensions.historicalImagery = historicalImageryForSave(context.state.historicalImagery);
  }
  if (context.state.cameraTour || context.project?.extensions?.cameraTour) {
    extensions.cameraTour = cameraTourForSave(context.state.cameraTour);
  }
  return extensions;
}

function portalReportForProject(project) {
  const report = project?.extensions?.geomoose?.conversionReport;
  return report && typeof report === "object" ? structuredClone(report) : null;
}

function portalExtensionForProject(project) {
  const extension = project?.extensions?.geomoose;
  if (!extension || typeof extension !== "object") return {};
  const copy = structuredClone(extension);
  delete copy.conversionReport;
  return copy;
}

async function saveAuthoritativeProject(context) {
  if (!canPersist(context)) {
    setStatus(context, "Your current role cannot update this map.");
    return;
  }
  context.shell.dataset.saveState = "saving";
  setStatus(context, "Saving authoritative map…");
  try {
    const saved = await context.saveProject(currentProjectDefinition(context));
    context.serverMapVersion = saved.version;
    context.savedProjectOrigin = saved.definition ? {id: saved.id, version: saved.version, definition: structuredClone(saved.definition)} : null;
    if (context.project) context.project.updatedAt = saved.updatedAt;
    context.onProjectSaved?.(saved);
    context.shell.dataset.saveState = "saved";
    const prefix = context.persistenceMode === "fixture" ? "Fixture save simulated" : "Authoritative map saved";
    setStatus(context, `${prefix} at version ${saved.version}.`);
  } catch (error) {
    if (error?.code === "map_style_reference_unavailable") {
      context.shell.dataset.saveState = "error";
      setStatus(context, "A selected Style is no longer available for this map. Your changes are still here. Check the Layer’s Style access or select an available version, then save again.");
      return;
    }
    if (error?.code === "map_version_conflict" || error?.status === 409) {
      context.shell.dataset.saveState = "conflict";
      const version = error.currentVersion ? ` Server version is ${error.currentVersion}.` : "";
      setStatus(context, `Save conflict.${version} Reload before applying your changes again.`);
      return;
    }
    context.shell.dataset.saveState = "error";
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Map save failed safely.${request}`);
  }
}

function canPersist(context) {
  return typeof context.saveProject === "function"
    && ["admin", "owner", "editor"].includes(context.role);
}

function canSaveAs(context) {
  return typeof context.saveProjectAs === "function"
    && ["admin", "owner", "editor"].includes(context.role);
}

function openBasemapChooser(context) {
  closeCompetingCompactSurfaces(context, "basemap");
  context.state.basemapChooserOpen = true;
  context.state.basemapChooserViewport = null;
  context.state.basemapChooserReturnFocus = document.activeElement;
  context.state.basemapCatalogMessage = null;
  context.state.basemapGovernanceSubjectId = null;
  context.state.activeMenu = null;
  context.shell.dataset.basemapChooserState = "open";
  setStatus(context, "Basemap chooser opened.");
  context.render();
}

function closeBasemapChooser(context) {
  const previousFocus = context.state.basemapChooserReturnFocus;
  const returnToBackground = Boolean(previousFocus?.closest?.(".gis-basemap-tree-row"));
  context.state.basemapChooserOpen = false;
  context.state.basemapChooserReturnFocus = null;
  context.state.basemapCatalogMessage = null;
  context.shell.dataset.basemapChooserState = "closed";
  context.render();
  const returnTarget = previousFocus instanceof HTMLElement && previousFocus.isConnected
    ? previousFocus
    : returnToBackground
      ? context.shell.querySelector(".gis-basemap-tree-row > button")
      : context.shell.querySelector('[aria-label="Change basemap"]');
  if (returnTarget instanceof HTMLElement) returnTarget.focus();
}

function setWorkbenchModalBackground(context, inert) {
  for (const child of context.shell.children) {
    if (child === context.modalLayer) continue;
    child.inert = inert;
    child.setAttribute("aria-hidden", String(inert));
  }
}

function renderBasemapChooser(layer, context) {
  const backdrop = document.createElement("div");
  backdrop.className = "gis-basemap-modal-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "gis-basemap-dialog";
  dialog.role = "dialog";
  dialog.ariaModal = "true";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", "gis-basemap-dialog-title");
  dialog.setAttribute("aria-describedby", "gis-basemap-dialog-description");

  const header = document.createElement("header");
  header.className = "gis-basemap-dialog-header";
  const identity = document.createElement("div");
  const title = textElement("h2", "Change basemap");
  title.id = "gis-basemap-dialog-title";
  const description = textElement(
    "p",
    "Choose imagery or a street map, then add your data. Terrain and buildings are separate view options."
  );
  description.id = "gis-basemap-dialog-description";
  identity.append(title, description);
  const close = iconButton("Close basemap chooser", "×", () => closeBasemapChooser(context));
  close.classList.add("gis-basemap-dialog-close");
  header.append(identity, close);

  const body = document.createElement("div");
  body.className = "gis-basemap-dialog-body";
  const catalog = buildBasemapCatalog(
    allBasemaps(context),
    context.basemapConnectionBindings,
    context.state.selectedBasemapConnectionBindingId,
    context.sources,
    context.state.currentBasemapId,
    {
      spatialBodyId: context.state.spatialBody.id,
      layerCount: context.layers.length
    }
  );
  const feedback = basemapChooserFeedback(context);

  if (!context.esriBasemapOptions || context.esriBasemapOptionsBody !== context.state.spatialBody.id) {
    context.esriBasemapOptionsBody = context.state.spatialBody.id;
    context.esriBasemapOptions = EsriBasemapOptions({
      session: context.esriBasemapSession,
      selectBasemap: (choice) => selectBasemapChoice(context, choice),
      enabled: context.state.spatialBody.id === "earth"
    });
  }
  const history = actionButton("Explore imagery by date", () => {
    closeBasemapChooser(context);
    openHistoricalImageryPanel(context);
  });
  history.disabled = context.state.spatialBody.id !== "earth";
  history.classList.add("gis-basemap-history-link");
  body.append(history);
  for (const group of catalog) {
    const section = basemapCatalogGroup(context, group);
    body.append(section);
    if (group.groupId === "key-free-imagery") {
      const esri = document.createElement("button");
      esri.type = "button";
      esri.className = "gis-basemap-card";
      esri.dataset.catalogId = "esri-imagery-options";
      esri.append(basemapPreview({preview: "usgs-imagery"}), textElement("strong", "Esri World Imagery"), textElement("span", "Satellite and aerial imagery. Public endpoint or ArcGIS API key."), textElement("small", "Set up imagery → review access, then apply"));
      esri.addEventListener("click", () => {
        context.esriBasemapOptions.open = true;
        context.esriBasemapOptions.scrollIntoView({block: "start"});
        context.esriBasemapOptions.querySelector('input[type="checkbox"]')?.focus({preventScroll: true});
      });
      section.querySelector(".gis-basemap-choice-grid").prepend(esri);
      body.append(context.esriBasemapOptions);
    }
    if (group.groupId === "key-free-terrain-relief") body.append(openTerrainCatalogControl(context));
  }
  // Keep in-progress configuration intact when asynchronous map feedback rerenders the dialog.
  if (!body.contains(context.esriBasemapOptions)) body.prepend(context.esriBasemapOptions);
  body.append(customStyleBasemap(context));

  const sources = document.createElement("details");
  sources.className = "gis-basemap-catalog-group gis-basemap-source-tools";
  sources.open = context.state.basemapSourceToolsOpen;
  const sourcesSummary = document.createElement("summary");
  sourcesSummary.append(
    textElement("strong", "Public and project sources"),
    textElement("span", "Governed regional XYZ and PMTiles registration")
  );
  sources.append(
    sourcesSummary,
    regionalBasemapSourceStudio(context),
    pmtilesBasemapStudio(context)
  );
  sources.addEventListener("toggle", () => {
    context.state.basemapSourceToolsOpen = sources.open;
  });
  body.append(sources);

  const footer = document.createElement("footer");
  footer.className = "gis-basemap-dialog-footer";
  const opacity = rangeInput("Basemap opacity", {
    min: 0,
    max: 1,
    step: 0.05,
    value: context.state.basemapOpacity,
    onInput: (value) => {
      context.state.basemapOpacity = value;
      setBasemapOpacity(context.state);
      feedback.textContent = `Basemap opacity set to ${Math.round(value * 100)}%. Save the map to persist it.`;
    }
  });
  const current = activeBasemap(context);
  const summary = compactKeyValues({
    "Current": current?.title ?? "Blank canvas",
    "Body": context.state.spatialBody.title,
    "Project connections": basemapConnectionSummary(context),
    "Catalog status": current?.governance
      ? `${basemapGovernanceLabel(current.governance)} · observed ${current.governance.observation.observedAt}`
      : "Project-managed source"
  });
  const sourceDetails = document.createElement("details");
  sourceDetails.className = "gis-basemap-catalog-group";
  sourceDetails.dataset.catalogGroup = "current-background";
  sourceDetails.append(textElement("summary", "Current background details"), summary);
  body.append(sourceDetails);
  const currentLabel = textElement("span", `Current: ${current?.title ?? "Blank canvas"}`);
  currentLabel.dataset.basemapCurrent = "true";
  footer.append(currentLabel, opacity, actionButton("Done", () => closeBasemapChooser(context)));
  dialog.append(header, body, feedback, footer);
  backdrop.append(dialog);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) closeBasemapChooser(context);
  });
  dialog.addEventListener("keydown", (event) => trapModalKeyboard(event, dialog, () => closeBasemapChooser(context)));
  layer.append(backdrop);
  const viewport = context.state.basemapChooserViewport;
  for (const group of body.querySelectorAll("[data-catalog-group]")) {
    if (viewport?.groups?.has(group.dataset.catalogGroup)) group.open = viewport.groups.get(group.dataset.catalogGroup);
  }
  queueMicrotask(() => {
    const previous = viewport?.focus;
    const target = previous?.isConnected ? previous : viewport?.catalogId
      ? body.querySelector(`[data-catalog-id="${CSS.escape(viewport.catalogId)}"]`) : null;
    (target ?? dialog).focus({preventScroll: true});
    body.scrollTop = viewport?.scrollTop ?? 0;
  });
}

function basemapCatalogGroup(context, group) {
  const disclosure = document.createElement("details");
  disclosure.className = "gis-basemap-catalog-group";
  disclosure.dataset.catalogGroup = group.groupId;
  disclosure.open = group.open === true;
  const summary = document.createElement("summary");
  summary.append(textElement("strong", group.title), textElement("span", group.description));
  const choices = document.createElement("div");
  choices.className = "gis-basemap-choice-grid";
  if (group.connections?.length) {
    const connection = document.createElement("select");
    connection.ariaLabel = `${group.title.split(" ·")[0]} project connection`;
    for (const record of group.connections) {
      const choice = document.createElement("option");
      choice.value = record.bindingId;
      choice.textContent = `${record.title} · ${record.status}`;
      connection.append(choice);
    }
    connection.value = group.selectedBindingId ?? "";
    connection.addEventListener("change", () => {
      context.state.selectedBasemapConnectionBindingId = connection.value;
      context.state.basemapCatalogMessage = `${group.title.split(" ·")[0]} project connection changed. Choose a basemap to resolve it.`;
      context.render();
    });
    const field = document.createElement("label");
    field.className = "gis-basemap-connection-choice";
    field.append(textElement("span", "Project connection"), connection);
    disclosure.append(summary, field);
  } else {
    disclosure.append(summary);
  }
  if (group.setupHref && !group.connections?.some(({status, credentialReady}) => (
    status === "configured" && credentialReady
  ))) {
    const setup = document.createElement("a");
    setup.className = "gis-basemap-setup-link";
    setup.href = group.setupHref;
    setup.textContent = `Configure ${group.title.split(" ·")[0]}`;
    disclosure.append(setup);
  }
  for (const choice of group.choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gis-basemap-card";
    button.dataset.catalogId = choice.catalogId;
    button.dataset.availability = choice.availability;
    if (choice.governance?.lifecycle) button.dataset.lifecycle = choice.governance.lifecycle;
    if (choice.governance?.observation?.status) button.dataset.health = choice.governance.observation.status;
    if (choice.access) button.dataset.access = choice.access.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    const available = selectableBasemap([group], choice.catalogId);
    const active = choice.basemapId === context.state.currentBasemapId;
    const checking = context.state.basemapActivationState === "loading"
      && choice.catalogId === context.state.basemapActivationCandidateId;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-busy", String(checking));
    button.disabled = context.state.basemapActivationState === "loading";
    button.classList.toggle("active", active);
    if (!available) {
      button.dataset.unavailable = "true";
      button.setAttribute("aria-label", `${choice.title} unavailable — inspect requirements`);
    }
    const governanceBadge = choice.governanceLabel
      ? textElement("small", choice.governanceLabel)
      : null;
    governanceBadge?.classList.add("gis-basemap-governance-badge");
    const reviewedFacts = choice.sourceReview
      ? textElement("span", `${choice.coverage} · zoom ${choice.zoom}`)
      : null;
    reviewedFacts?.classList.add("gis-basemap-reviewed-facts");
    if (choice.sourceReview) {
      button.title = `${choice.sourceReview.provider}. ${choice.serviceLevel}. Reviewed ${choice.reviewedAt}. Terms: ${choice.termsUrl}`;
    }
    button.append(
      basemapPreview(choice),
      textElement("strong", choice.title),
      textElement("span", choice.description ?? choice.reason),
      textElement("small", available ? choice.source : availabilityLabel(choice.availability)),
      ...(reviewedFacts ? [reviewedFacts] : []),
      ...(governanceBadge ? [governanceBadge] : [])
    );
    button.addEventListener("click", () => {
      if (!available) {
        const message = unavailableBasemapMessage(choice);
        context.state.basemapGovernanceSubjectId = ["retired", "operator-disabled"].includes(choice.availability)
          ? choice.basemapId
          : null;
        context.state.basemapCatalogMessage = message;
        setStatus(context, message);
        context.render();
        return;
      }
      void selectBasemapChoice(context, available);
    });
    choices.append(button);
  }
  disclosure.append(choices);
  return disclosure;
}

function openTerrainCatalogControl(context) {
  const disclosure = document.createElement("details");
  disclosure.className = "gis-basemap-catalog-group gis-open-terrain-catalog";
  disclosure.dataset.catalogGroup = "open-terrain";
  disclosure.open = false;
  const summary = document.createElement("summary");
  summary.append(
    textElement("strong", "3D terrain · optional"),
    textElement("span", "Elevation beneath your imagery, not a different basemap.")
  );
  const choices = document.createElement("div");
  choices.className = "gis-basemap-choice-grid";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-button gis-terrain-card";
  button.dataset.catalogId = "mapterhorn-open-terrain";
  button.dataset.access = "no-api-key";
  button.setAttribute("aria-pressed", String(context.state.terrainEnabled));
  button.setAttribute(
    "aria-label",
    context.state.terrainEnabled ? "Disable open 3D terrain" : "Enable open 3D terrain"
  );
  button.title = `Mapterhorn. ${OPEN_TERRAIN_SOURCE.availability}. Reviewed ${OPEN_TERRAIN_SOURCE.observedAt}. Terms: ${OPEN_TERRAIN_SOURCE.termsUrl}`;
  const activation = currentTerrainActivation(context.state);
  button.textContent = context.state.terrainEnabled ? "Turn off Mapterhorn terrain" : "Enable Mapterhorn terrain";
  button.disabled = !context.state.terrainEnabled && (!activation.allowed || context.state.spatialBody.id !== "earth");
  const explanation = textElement("p", button.disabled
    ? context.state.spatialBody.id !== "earth" ? "Terrain is available for Earth maps only." : terrainGovernanceMessage(activation)
    : "Adds elevation and enables Globe. Tilt the camera to see relief; imagery and data stay in place.");
  button.addEventListener("click", () => {
    if (context.state.terrainEnabled) {
      toggleTerrain(context);
      context.state.basemapCatalogMessage = context.state.statusMessage;
      context.render();
      return;
    }
    if (!context.state.globe) toggleProjection(context);
    if (context.state.globe) toggleTerrain(context);
    context.state.basemapCatalogMessage = context.state.statusMessage;
    context.render();
  });
  choices.append(button, explanation);
  disclosure.append(summary, choices);
  return disclosure;
}

function basemapChooserFeedback(context) {
  const state = context.state;
  const container = document.createElement("section");
  container.className = "gis-basemap-dialog-feedback";
  container.dataset.activationState = state.basemapActivationState;
  container.ariaBusy = String(state.basemapActivationState === "loading");
  const message = textElement(
    "p",
    state.basemapCatalogMessage
      ?? state.basemapActivationMessage
      ?? "Your data stays in place when you change the background."
  );
  message.role = "status";
  message.ariaLive = "polite";
  container.append(message);
  if (state.basemapActivationState === "loading") {
    const progress = document.createElement("progress");
    progress.removeAttribute("value");
    progress.setAttribute("aria-label", `Checking ${state.basemapActivationCandidateTitle}`);
    container.append(progress);
  }
  if (state.basemapActivationState === "failed" && state.basemapActivationRetryChoice) {
    const actions = document.createElement("div");
    actions.className = "gis-basemap-activation-actions";
    actions.append(
      actionButton(`Retry ${state.basemapActivationCandidateTitle}`, () => {
        void selectBasemapChoice(context, state.basemapActivationRetryChoice);
      }),
      actionButton(`Keep ${activeBasemap(context)?.title ?? "current map"}`, () => retainCurrentBasemap(context))
    );
    if (state.currentBasemapId !== "blank") {
      actions.append(actionButton("Use blank canvas", () => {
        const blank = BASEMAPS.find(({basemapId}) => basemapId === "blank");
        if (blank) void selectBasemapChoice(context, blank);
      }));
    }
    container.append(actions);
  }
  const governanceSubject = allBasemaps(context)
    .find(({basemapId}) => basemapId === state.basemapGovernanceSubjectId);
  const replacement = basemapReplacement(governanceSubject, allBasemaps(context));
  if (governanceSubject && replacement) {
    const actions = document.createElement("div");
    actions.className = "gis-basemap-activation-actions gis-basemap-governance-actions";
    actions.append(
      actionButton(`Use ${replacement.title} instead`, () => {
        void selectBasemapChoice(context, replacement);
      }),
      actionButton("Keep exact saved selection", () => {
        state.basemapGovernanceSubjectId = null;
        const retained = `${governanceSubject.title} remains the exact saved selection. No project map was changed.`;
        state.basemapCatalogMessage = retained;
        setStatus(context, retained);
        context.render();
      })
    );
    container.append(actions);
  }
  return container;
}

async function selectBasemapChoice(context, choice) {
  const attempt = beginBasemapActivation(context, choice);
  let selected = allBasemaps(context).find(({basemapId}) => basemapId === choice.basemapId)
    ?? choice;
  if (["protomaps", "carto"].includes(choice.provider)) {
    const runtime = await resolveConnectedBasemap(context, choice);
    if (attempt !== context.state.basemapActivationAttempt) return false;
    if (!runtime) {
      failBasemapActivation(context, attempt, "connection");
      return false;
    }
    selected = runtime;
  } else if (choice.kind === "governed-raster") {
    selected = governedBasemapCandidate(choice);
  } else if (choice.kind === "planetary-blank") {
    selected = planetaryBlankCandidate(context, choice);
    if (!selected) {
      failBasemapActivation(context, attempt, "render");
      return false;
    }
  }
  if (!canSwitchBasemap(context, selected)) {
    failBasemapActivation(context, attempt, "render");
    return false;
  }
  const staged = await stageBasemapCandidate(context, selected, attempt);
  if (attempt !== context.state.basemapActivationAttempt || staged.code === "superseded") return false;
  if (!staged.ok) {
    failBasemapActivation(context, attempt, staged.code);
    return false;
  }
  return commitBasemapActivation(context, attempt, selected, choice);
}

function governedBasemapCandidate(choice) {
  return {
    basemapId: choice.basemapId,
    title: choice.title,
    section: "Regional",
    kind: "governed-raster",
    description: choice.description,
    datasetId: choice.datasetId,
    sourceType: choice.sourceType,
    sourceVersion: choice.sourceVersion,
    sourceUrl: choice.sourceUrl,
    sourceConfiguration: structuredClone(choice.sourceConfiguration),
    url: choice.sourceUrl,
    tileSize: choice.tileSize,
    scheme: choice.scheme,
    minZoom: choice.minZoom,
    maxZoom: choice.maxZoom,
    attribution: choice.attribution
  };
}

function planetaryBlankCandidate(context, choice) {
  if (!["moon", "mars"].includes(choice.spatialBodyId)) return null;
  const body = spatialBodyDefinition(choice.spatialBodyId);
  return {
    basemapId: `planetary-blank-${body.id}`,
    title: choice.title,
    section: body.id === "moon" ? "The Moon" : body.title,
    kind: "planetary-blank",
    spatialBodyId: body.id,
    description: `${body.title} angular coordinates with no network imagery.`,
    attribution: `No imagery · ${body.title} angular canvas`
  };
}

function basemapConnectionSummary(context) {
  const compatible = context.basemapConnectionBindings.filter(({connection}) => (
    connection?.provider === "protomaps"
    && connection?.status === "configured"
    && connection?.credentialReady
  ));
  if (compatible.length) return `${compatible.length} configured`;
  if (context.basemapConnectionBindings.length) {
    return `0 configured · ${context.basemapConnectionBindings.length} attached`;
  }
  if (context.connectionBindings.length) return `0 compatible · ${context.connectionBindings.length} dataset-only`;
  return "None attached";
}

function availabilityLabel(availability) {
  return ({
    "retired": "Retired · explicit replacement available",
    "operator-disabled": "Operator disabled · saved selection retained",
    "connection-required": "Connection required",
    "source-required": "Governed source required",
    "source-review-required": "Source review required",
    "coordinate-transform-required": "Coordinate transform required",
    "body-contract-required": "Spatial-body support required",
    "empty-project-required": "Empty project required"
  })[availability] ?? "Unavailable";
}

function trapModalKeyboard(event, dialog, close) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary'
  )].filter((element) => !element.closest("details:not([open])"));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openSaveAsDialog(context, imported = null) {
  if (context.disposed || !canSaveAs(context)) {
    setStatus(context, "Your current role cannot create a new authoritative map.");
    return;
  }
  closeCompetingCompactSurfaces(context, "save-as");
  context.state.saveAsOpen = true;
  context.state.saveAsImport = imported ? structuredClone(imported) : null;
  context.state.saveAsReturnFocus = document.activeElement;
  context.shell.dataset.saveAsState = "open";
  context.render();
}

function openPreservationDialog(context, source, returnFocusKey = null) {
  closeCompetingCompactSurfaces(context, "preservation");
  const [west, south, east, north] = authoringMapExtent(context);
  context.state.preservationReturnFocus = document.activeElement;
  context.state.preservationReturnFocusKey = returnFocusKey
    ?? document.activeElement?.dataset?.preservationReturnFocus
    ?? null;
  context.state.preservationDialog = {
    source,
    phase: "choice",
    scope: preservationScopeForSource(source, [west, south, east, north]),
    estimate: null,
    job: null,
    destinationName: `${source.name} protected copy`,
    destinationClassification: "internal",
    rightsBasis: "",
    attribution: source.configuration?.attribution ?? source.name,
    rightsConfirmed: false,
    estimateAccepted: false,
    message: null
  };
  context.shell.dataset.preservationDialogState = "choice";
  context.render();
}

function preservationScopeForSource(source, bounds) {
  if (source.sourceType === "wms") {
    return {kind: "bounded_image", bounds, width: 1600, height: 900};
  }
  if (source.sourceType === "pmtiles") return {kind: "exact_object"};
  const pageSize = source.configuration?.pageSize ?? 1_000;
  return {
    kind: "bounded_features",
    bounds,
    maximumFeatures: Math.min(10_000, pageSize * 64, 50_000),
    pageSize
  };
}

function closePreservationDialog(context) {
  const previousFocus = context.state.preservationReturnFocus;
  const previousFocusKey = context.state.preservationReturnFocusKey;
  context.state.preservationDialog = null;
  context.state.preservationReturnFocus = null;
  context.state.preservationReturnFocusKey = null;
  context.shell.dataset.preservationDialogState = "closed";
  context.render();
  const stableInitiator = previousFocusKey
    ? context.shell.querySelector(`[data-preservation-return-focus="${previousFocusKey}"]`)
    : null;
  const fallback = isMobileWorkbenchViewport()
    ? context.shell.querySelector('.gis-mobile-command[data-primary-command="more"]')
    : context.shell.querySelector('.gis-primary-command[data-primary-command="add-data"]');
  const returnTarget = stableInitiator
    ?? (previousFocus instanceof HTMLElement
      && previousFocus !== document.body
      && previousFocus.isConnected
      ? previousFocus
      : fallback);
  if (returnTarget instanceof HTMLElement) queueMicrotask(() => returnTarget.focus());
}

function openMobileCommandSheet(context) {
  closeCompetingCompactSurfaces(context, "mobile-commands");
  context.state.mobileCommandSheetOpen = true;
  context.state.mobileCommandReturnFocus = document.activeElement;
  context.state.activeMenu = null;
  context.render();
}

function closeMobileCommandSheet(context) {
  const previousFocus = context.state.mobileCommandReturnFocus;
  context.state.mobileCommandSheetOpen = false;
  context.state.mobileCommandReturnFocus = null;
  context.render();
  const fallback = context.shell.querySelector('.gis-mobile-command[data-primary-command="more"]');
  const returnTarget = previousFocus instanceof HTMLElement && previousFocus.isConnected
    ? previousFocus
    : fallback;
  if (returnTarget instanceof HTMLElement) returnTarget.focus();
}

function closeCompetingCompactSurfaces(context, keep) {
  const {state} = context;
  state.activeMenu = null;
  if (isMobileWorkbenchViewport()) {
    if (keep !== "left-drawer") state.leftOpen = false;
    if (keep !== "right-drawer") state.rightOpen = false;
  }
  if (keep !== "mobile-commands") {
    state.mobileCommandSheetOpen = false;
    state.mobileCommandReturnFocus = null;
  }
  if (keep !== "save-as") {
    state.saveAsOpen = false;
    state.saveAsReturnFocus = null;
    state.saveAsImport = null;
  }
  if (keep !== "basemap") {
    state.basemapChooserOpen = false;
    state.basemapChooserReturnFocus = null;
  }
  if (keep !== "preservation") {
    state.preservationDialog = null;
    state.preservationReturnFocus = null;
    state.preservationReturnFocusKey = null;
  }
}

function renderMobileCommandSheet(layer, context) {
  const backdrop = document.createElement("div");
  backdrop.className = "gis-mobile-command-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "gis-mobile-command-sheet";
  dialog.role = "dialog";
  dialog.ariaModal = "true";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", "gis-mobile-command-title");
  dialog.setAttribute("aria-describedby", "gis-mobile-command-description");

  const header = document.createElement("header");
  const identity = document.createElement("div");
  const title = textElement("h2", "Actions");
  title.id = "gis-mobile-command-title";
  const description = textElement(
    "p",
    "Start or save a project, add data, change layer order, or open a complete command category."
  );
  description.id = "gis-mobile-command-description";
  identity.append(title, description);
  header.append(identity, iconButton("Close actions", "×", () => closeMobileCommandSheet(context)));

  const categories = document.createElement("div");
  categories.className = "gis-mobile-command-categories";
  const essentials = document.createElement("section");
  essentials.className = "gis-mobile-command-essentials";
  essentials.setAttribute("aria-labelledby", "gis-mobile-essential-title");
  const essentialsTitle = textElement("h3", "Project and map");
  essentialsTitle.id = "gis-mobile-essential-title";
  const essentialsGrid = document.createElement("div");
  essentialsGrid.className = "gis-mobile-command-essential-grid";
  for (const command of workbenchCommandRegistry(context).filter(({sheet}) => sheet)) {
    const button = commandButton({
      ...command,
      action: () => {
        context.state.mobileCommandSheetOpen = false;
        context.state.mobileCommandReturnFocus = null;
        command.action();
      }
    });
    button.classList.add("gis-mobile-essential-command");
    essentialsGrid.append(button);
  }
  essentials.append(essentialsTitle, essentialsGrid);
  categories.append(essentials);
  const destinations = context.demoSurface
    ? demoNavigationItems()
    : studioNavigationItems(fixtureAdapterKind(context.persistenceMode))
      .filter(item => ["home", "projects", "data", "styles", "collections", "publishing"].includes(item.id));
  const browse = document.createElement("nav");
  browse.className = "gis-mobile-command-navigation";
  browse.ariaLabel = "Browse OpenGeo Studio";
  browse.append(textElement("h3", "Browse"));
  for (const item of destinations) browse.append(navLink(item.label, item.href));
  categories.append(browse);
  for (const menu of toolbarMenus(context).filter(({id}) => id !== "more")) {
    const category = document.createElement("details");
    category.className = "gis-mobile-command-category";
    category.dataset.mobileCommandCategory = menu.id;
    category.open = false;
    const summary = document.createElement("summary");
    summary.append(textElement("strong", menu.label));
    category.append(summary);
    for (const section of menu.sections) {
      const group = document.createElement("div");
      group.className = "gis-menu-section";
      for (const item of section) group.append(item.render(context));
      category.append(group);
    }
    categories.append(category);
  }

  dialog.append(header, categories);
  backdrop.append(dialog);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) closeMobileCommandSheet(context);
  });
  dialog.addEventListener("keydown", (event) => (
    trapModalKeyboard(event, dialog, () => closeMobileCommandSheet(context))
  ));
  layer.append(backdrop);
  queueMicrotask(() => dialog.focus());
}

function renderPreservationDialog(layer, context) {
  const model = context.state.preservationDialog;
  if (!model) return;
  const backdrop = document.createElement("div");
  backdrop.className = "gis-basemap-modal-backdrop gis-preservation-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "gis-basemap-dialog gis-preservation-dialog";
  dialog.role = "dialog";
  dialog.ariaModal = "true";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", "gis-preservation-title");
  dialog.setAttribute("aria-describedby", "gis-preservation-description");

  const header = document.createElement("header");
  header.className = "gis-basemap-dialog-header";
  const identity = document.createElement("div");
  const title = textElement("h2", "Keep a protected copy?");
  title.id = "gis-preservation-title";
  const description = textElement(
    "p",
    `${model.source.name} is saved as live source revision ${model.source.versionNumber}. You can also archive a bounded, immutable copy in this project.`
  );
  description.id = "gis-preservation-description";
  identity.append(title, description);
  const close = iconButton("Close protected copy dialog", "×", () => closePreservationDialog(context));
  close.classList.add("gis-basemap-dialog-close");
  close.disabled = ["estimating", "submitting", "cancelling"].includes(model.phase);
  header.append(identity, close);

  const body = document.createElement("div");
  body.className = "gis-basemap-dialog-body gis-preservation-body";
  const live = document.createElement("div");
  live.className = "gis-callout gis-preservation-live";
  live.append(
    textElement("strong", "Live connection saved"),
    textElement("span", "Maps keep the exact source revision. A protected copy creates a separate managed dataset with source lineage; it does not replace the live connection.")
  );
  body.append(live);

  if (["choice", "estimating", "error"].includes(model.phase)) {
    body.append(preservationScopeEditor(model));
  }
  if (["review", "submitting"].includes(model.phase)) {
    body.append(preservationEstimateReview(model));
  }
  if (["queued", "cancelling"].includes(model.phase)) {
    body.append(preservationQueuedResult(model));
  }
  if (model.message) {
    const feedback = textElement("p", model.message);
    feedback.className = "gis-preservation-feedback";
    feedback.ariaLive = "polite";
    body.append(feedback);
  }

  const footer = document.createElement("footer");
  footer.className = "gis-basemap-dialog-footer gis-preservation-actions";
  if (["choice", "error"].includes(model.phase)) {
    footer.append(
      actionButton("Keep live connection only", () => {
        setStatus(context, `${model.source.name} remains connected at revision ${model.source.versionNumber}; no source bytes were copied.`);
        closePreservationDialog(context);
      }),
      actionButton("Review protected copy", () => void estimatePreservationCopy(context))
    );
  } else if (model.phase === "review") {
    footer.append(
      actionButton("Back", () => {
        model.phase = "choice";
        model.message = null;
        context.shell.dataset.preservationDialogState = "choice";
        context.render();
      }),
      actionButton("Create protected copy", () => void submitPreservationCopy(context))
    );
  } else if (model.phase === "queued") {
    if (model.job?.cancellable && typeof context.cancelProtectedCopy === "function") {
      footer.append(actionButton("Cancel queued copy", () => void cancelPreservationCopy(context)));
    }
    footer.append(actionButton("Done", () => closePreservationDialog(context)));
  } else {
    const busy = actionButton(model.phase === "estimating" ? "Reviewing estimate…" : model.phase === "submitting" ? "Creating copy…" : "Cancelling…", () => {});
    busy.disabled = true;
    footer.append(busy);
  }

  dialog.append(header, body, footer);
  backdrop.append(dialog);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop && !["estimating", "submitting", "cancelling"].includes(model.phase)) {
      closePreservationDialog(context);
    }
  });
  dialog.addEventListener("keydown", (event) => trapModalKeyboard(
    event,
    dialog,
    () => {
      if (!["estimating", "submitting", "cancelling"].includes(model.phase)) {
        closePreservationDialog(context);
      }
    }
  ));
  layer.append(backdrop);
  queueMicrotask(() => dialog.focus());
}

function preservationScopeEditor(model) {
  const featureSource = ["arcgis", "wfs"].includes(model.source.sourceType);
  const section = editorSection(
    model.source.sourceType === "wms"
      ? "One bounded WMS image"
      : featureSource ? "Bounded GeoJSON feature copy" : "Exact PMTiles object",
    model.source.sourceType === "wms"
      ? "The archive is one PNG of the current map extent, not a complete WMS mirror or tile pyramid."
      : featureSource
      ? "The archive contains only the selected source revision, visible WGS84 extent, fields, geometry type, and explicit feature/request limits."
      : "The executor copies the exact public PMTiles object and records its checksum and source revision."
  );
  if (model.source.sourceType === "wms") {
    const bounds = textInput("WGS84 bounds · west, south, east, north", model.scope.bounds.join(", "));
    const width = textInput("Output width", String(model.scope.width));
    const height = textInput("Output height", String(model.scope.height));
    const update = () => {
      model.scope = {
        kind: "bounded_image",
        bounds: bounds.input.value.split(",").map((value) => Number(value.trim())),
        width: Number(width.input.value),
        height: Number(height.input.value)
      };
    };
    for (const input of [bounds.input, width.input, height.input]) input.addEventListener("input", update);
    section.append(bounds.wrapper, width.wrapper, height.wrapper);
  } else if (featureSource) {
    const bounds = textInput("WGS84 bounds · west, south, east, north", model.scope.bounds.join(", "));
    const maximumFeatures = textInput("Maximum features · up to 50000", String(model.scope.maximumFeatures));
    const pageSize = textInput(
      `Page size · up to ${model.source.sourceType === "wfs" ? "1000" : "2000"}`,
      String(model.scope.pageSize)
    );
    const update = () => {
      model.scope = {
        kind: "bounded_features",
        bounds: bounds.input.value.split(",").map((value) => Number(value.trim())),
        maximumFeatures: Number(maximumFeatures.input.value),
        pageSize: Number(pageSize.input.value)
      };
    };
    for (const input of [bounds.input, maximumFeatures.input, pageSize.input]) {
      input.addEventListener("input", update);
    }
    section.append(bounds.wrapper, maximumFeatures.wrapper, pageSize.wrapper);
  }
  return section;
}

function preservationEstimateReview(model) {
  const estimate = model.estimate;
  const largeCapture = estimate.maximumOutputBytes > 1_000_000_000;
  const section = editorSection(
    "Review archive limits and rights",
    "OpenGeo Studio will start isolated capacity only after this confirmation. The durable project, source revision, output, and lineage remain after compute closes."
  );
  section.append(compactKeyValues({
    "Capture": estimate.copyMethod === "bounded_map_capture"
      ? "One bounded PNG"
      : estimate.copyMethod === "bounded_feature_capture"
      ? "Bounded GeoJSON features"
      : "Exact PMTiles object",
    "Requests": String(estimate.maximumRequests),
    "Maximum output": formatBytes(estimate.maximumOutputBytes),
    "Estimated request/storage cost": `$${estimate.estimatedCostUsd.toFixed(6)}`,
    "Estimate expires": new Date(estimate.expiresAt).toLocaleTimeString()
  }));
  const costNote = document.createElement("p");
  costNote.textContent = `${largeCapture ? "Large capture: the planned maximum exceeds 1 GB (1,000,000,000 bytes). Review this volume before transfer. " : ""}Provider charges are unknown and may apply. Ongoing storage and downloads can incur additional charges; the displayed estimate is not a total bill. Only the selected capture scope will be copied.`;
  section.append(costNote);
  const name = textInput("Protected dataset name", model.destinationName);
  const classification = selectInput("Classification", model.destinationClassification, [
    ["internal", "Internal"],
    ["public", "Public"],
    ["confidential", "Confidential"],
    ["restricted", "Restricted"]
  ]);
  const basis = textAreaInput("Rights basis", model.rightsBasis, "Public-data terms, license, or permission");
  const attribution = textInput("Attribution", model.attribution);
  const rights = checkField("I confirm that this project may retain these source bytes.", model.rightsConfirmed, (checked) => {
    model.rightsConfirmed = checked;
  });
  const accepted = checkField(`${largeCapture ? "I reviewed this capture over 1 GB and potential provider, storage and download charges. " : ""}I accept the bounded request, byte, and cost limits shown above.`, model.estimateAccepted, (checked) => {
    model.estimateAccepted = checked;
  });
  name.input.addEventListener("input", () => { model.destinationName = name.input.value; });
  classification.input.addEventListener("change", () => { model.destinationClassification = classification.input.value; });
  basis.input.addEventListener("input", () => { model.rightsBasis = basis.input.value; });
  attribution.input.addEventListener("input", () => { model.attribution = attribution.input.value; });
  section.append(name.wrapper, classification.wrapper, basis.wrapper, attribution.wrapper, rights, accepted);
  return section;
}

function preservationQueuedResult(model) {
  const section = editorSection(
    "Protected copy queued",
    "The request is durable. Isolated source-copy capacity starts on demand, writes an immutable S3 object version, hands it to ordinary ingestion, records lineage, and returns to zero request compute."
  );
  section.append(compactKeyValues({
    "Job": model.job.jobId,
    "State": model.job.state,
    "Managed dataset": model.job.destinationDatasetId,
    "Source revision": String(model.job.sourceRevisionNumber),
    "Archive path": "Server assigned"
  }));
  return section;
}

async function estimatePreservationCopy(context) {
  const model = context.state.preservationDialog;
  if (!model) return;
  model.phase = "estimating";
  model.message = null;
  context.shell.dataset.preservationDialogState = model.phase;
  context.render();
  try {
    model.estimate = await context.estimateProtectedCopy(model.source, model.scope);
    if (!Number.isSafeInteger(model.estimate.maximumOutputBytes) || model.estimate.maximumOutputBytes < 0) {
      throw Object.assign(Error("Capture volume is unknown"), {code: "capture_volume_unknown"});
    }
    model.phase = "review";
  } catch (error) {
    model.phase = "error";
    model.message = `The bounded estimate could not be created (${error?.code ?? "invalid_scope"}). No copy job was queued.`;
  }
  context.shell.dataset.preservationDialogState = model.phase;
  context.render();
}

async function submitPreservationCopy(context) {
  const model = context.state.preservationDialog;
  if (!model?.estimate) return;
  if (!model.rightsConfirmed || !model.estimateAccepted
    || !model.rightsBasis.trim() || !model.attribution.trim() || !model.destinationName.trim()) {
    model.message = "Complete the dataset name, rights basis, attribution, and both confirmations.";
    context.render();
    return;
  }
  model.phase = "submitting";
  model.message = null;
  context.shell.dataset.preservationDialogState = model.phase;
  context.render();
  try {
    model.job = await context.requestProtectedCopy(model.source, {
      idempotencyKey: crypto.randomUUID(),
      estimate: {
        estimateId: model.estimate.estimateId,
        estimateChecksumSha256: model.estimate.estimateChecksumSha256,
        accepted: true
      },
      rights: {
        confirmed: true,
        basis: model.rightsBasis.trim(),
        attribution: model.attribution.trim()
      },
      destination: {
        name: model.destinationName.trim(),
        description: `Protected copy of ${model.source.name} revision ${model.source.versionNumber}`,
        classification: model.destinationClassification
      }
    });
    replaceDurableJob(context.protectedCopyJobs, model.job);
    model.phase = "queued";
    setStatus(context, `${model.destinationName} is queued as a durable protected copy.`);
  } catch (error) {
    model.phase = "review";
    model.message = `The protected copy was not accepted by this deployment (${error?.code ?? "copy_unavailable"}). Retry uses the same server-sealed estimate; no browser storage path was accepted.`;
  }
  context.shell.dataset.preservationDialogState = model.phase;
  context.render();
}

async function cancelPreservationCopy(context) {
  const model = context.state.preservationDialog;
  if (!model?.job?.cancellable || typeof context.cancelProtectedCopy !== "function") return;
  model.phase = "cancelling";
  context.render();
  try {
    model.job = await context.cancelProtectedCopy(model.source, model.job.jobId);
    replaceDurableJob(context.protectedCopyJobs, model.job);
    setStatus(context, `${model.destinationName} protected-copy request was cancelled before execution.`);
    closePreservationDialog(context);
  } catch (error) {
    model.phase = "queued";
    model.message = `Cancellation was not accepted (${error?.code ?? "job_not_cancellable"}). Refresh job state before retrying.`;
    context.render();
  }
}

function renderModalLayer(layer, context) {
  const chooser = layer.querySelector(".gis-basemap-dialog-body");
  if (chooser && context.state.basemapChooserOpen) {
    context.state.basemapChooserViewport = {
      scrollTop: chooser.scrollTop,
      groups: new Map([...chooser.querySelectorAll("[data-catalog-group]")].map(group => [group.dataset.catalogGroup, group.open])),
      focus: document.activeElement,
      catalogId: document.activeElement?.closest?.("[data-catalog-id]")?.dataset.catalogId
    };
  }
  layer.replaceChildren();
  const modalOpen = context.state.saveAsOpen
    || context.state.basemapChooserOpen
    || context.state.mobileCommandSheetOpen
    || context.state.preservationDialog !== null;
  setWorkbenchModalBackground(context, modalOpen);
  if (!modalOpen) return;
  if (context.state.preservationDialog !== null) {
    renderPreservationDialog(layer, context);
    return;
  }
  if (context.state.mobileCommandSheetOpen) {
    renderMobileCommandSheet(layer, context);
    return;
  }
  if (!context.state.saveAsOpen) {
    renderBasemapChooser(layer, context);
    return;
  }
  const dialog = document.createElement("div");
  dialog.className = "gis-save-as-dialog";
  dialog.role = "dialog";
  dialog.ariaModal = "true";
  dialog.setAttribute("aria-labelledby", "gis-save-as-title");
  const form = document.createElement("form");
  const imported = context.state.saveAsImport;
  const title = textElement("h2", imported ? "Create map from snapshot" : "Save map as");
  title.id = "gis-save-as-title";
  const name = document.createElement("input");
  name.type = "text";
  name.required = true;
  name.maxLength = 200;
  name.ariaLabel = "New map name";
  name.value = imported?.created?.name ?? imported?.name ?? `${context.startBlank ? "Untitled map" : context.project?.name ?? context.workspace?.title ?? "Map"} copy`;
  const feedback = textElement(
    "p",
    imported
      ? "Creates a separate map here after checking current Layer and Style access. Your working map stays unchanged. Linked files, old history and access are not imported."
      : "A new map record will be created. The current map and version will not be changed."
  );
  feedback.className = "gis-save-as-feedback";
  feedback.ariaLive = "polite";
  const actions = document.createElement("div");
  actions.className = "gis-save-as-actions";
  const close = () => {
    const previousFocus = context.state.saveAsReturnFocus;
    context.state.saveAsOpen = false;
    context.state.saveAsReturnFocus = null;
    context.state.saveAsImport = null;
    context.render();
    const fallback = context.shell.querySelector(isMobileWorkbenchViewport()
      ? '.gis-mobile-command[data-primary-command="more"]'
      : ".gis-save-as-command");
    const returnTarget = previousFocus instanceof HTMLElement && previousFocus.isConnected
      ? previousFocus
      : fallback;
    if (returnTarget instanceof HTMLElement) returnTarget.focus();
  };
  const cancel = actionButton("Cancel", close);
  const submit = actionButton("Create new map", () => {});
  submit.type = "submit";
  actions.append(cancel, submit);
  const showCreatedMap = (created) => {
    name.disabled = true;
    cancel.disabled = false;
    feedback.textContent = `Created ${created.name} at version ${created.version}. Open it when you are ready to load its layers.`;
    const open = document.createElement("a");
    open.className = "platform-button";
    open.textContent = "Open created map";
    open.href = compositionHref(created.id, {adapterKind: context.persistenceMode});
    actions.replaceChildren(actionButton("Close", close), open);
  };
  if (imported?.created) showCreatedMap(imported.created);
  form.append(title, fieldWrap("New map name", name), feedback, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || imported?.created || context.disposed || !canSaveAs(context)) return;
    const mapName = name.value.trim();
    if (!mapName) return name.focus();
    submit.disabled = true;
    cancel.disabled = true;
    name.disabled = true;
    feedback.textContent = "Creating a separate authoritative map…";
    context.shell.dataset.saveAsState = "saving";
    try {
      if (imported && (!imported.creationKey || imported.requestName !== mapName)) {
        imported.creationKey = crypto.randomUUID();
        imported.requestName = mapName;
      }
      const created = await context.saveProjectAs({
        name: mapName,
        definition: imported ? structuredClone(imported.definition) : currentProjectDefinition(context),
        ...(imported ? {creationKey: imported.creationKey} : {})
      });
      if (context.disposed || !context.state.saveAsOpen
        || imported && context.state.saveAsImport !== imported) return;
      context.shell.dataset.saveAsState = "saved";
      if (imported) {
        imported.created = {id: created.id, name: created.name, version: created.version};
        showCreatedMap(imported.created);
        return;
      }
      feedback.textContent = `Created ${created.name} at version ${created.version}. Opening the new map…`;
      location.href = compositionHref(created.id, {adapterKind: context.persistenceMode});
    } catch (error) {
      context.shell.dataset.saveAsState = "error";
      const request = error?.requestId ? ` Request ${error.requestId}.` : "";
      feedback.textContent = imported && error?.code === "map_dataset_not_linked"
        ? "This workspace is missing a linked Layer. Link the referenced Layer in Catalog before trying again. Your working map is unchanged."
        : imported && error?.code === "map_style_reference_unavailable"
          ? "A referenced Style is unavailable. Check its access before trying again. Your working map is unchanged."
          : `Save As failed safely (${error?.code ?? "unexpected_error"}).${request}`;
      submit.disabled = false;
      cancel.disabled = false;
      name.disabled = false;
      name.focus();
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (cancel.disabled) return;
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [name, cancel, submit].filter((element) => !element.disabled);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.append(form);
  layer.append(dialog);
  queueMicrotask(() => name.select());
}

function openProjectFile(context) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.xml,.wmc,.cml,.gpx,.nmea,.nme,.wpt,.plt,.csv,.tsv,.txt,application/gpx+xml,text/csv,text/tab-separated-values,text/plain,application/json,application/xml,text/xml";
  input.className = "opengeo-project-file-input";
  input.hidden = true;
  input.oncancel = () => input.remove();
  input.onchange = async () => {
    const file = input.files?.[0];
    const reviewGeneration = context.projectFileReviewGeneration = (context.projectFileReviewGeneration ?? 0) + 1;
    try {
      if (!file) return;
      if (/\.(gpx|nmea|nme|wpt|plt|rte|pnt|evt)$/i.test(file.name)) {await openGpsLayer(context, file);return;}
      if (/\.(csv|tsv|txt)$/i.test(file.name)) {await openDelimitedLayer(context, file);return;}
      if (file.size > BROWSER_PROJECT_FILE_BYTES) throw new TypeError("Project file exceeds the 2 MB open limit.");
      const sourceText = await file.text();
      if (context.disposed || context.projectFileReviewGeneration !== reviewGeneration) return;
      const format = identifyProjectFileFormat(sourceText);
      if (format === "opengeo-browser") {
        if (context.publicDemo) reviewBrowserProjectFile(context, file, sourceText);
        else showProjectFileReview(context, {
          file, format: "OpenGeo Studio browser Project",
          description: "This file can reopen in the browser workbench. Importing it as a managed Project with governed data and access is still in development."
        });
        return;
      }
      if (format === "opengeo-managed") {
        const raw = JSON.parse(sourceText);
        if (raw.schemaVersion !== "opengeo.project-version.1.0.0") {
          showProjectFileReview(context, {
            file, format: "OpenGeo Studio managed Project",
            description: "This file is not a saved snapshot. Open its saved Project from Projects."
          });
          return;
        }
        const snapshot = readSavedProjectVersionFile(sourceText);
        if (snapshot.definition.schemaVersion === "opengeo.map-definition.1.6.0") upgradeMapDefinition(snapshot.definition);
        const supported = ["opengeo.map-definition.1.3.0", "opengeo.map-definition.1.4.0", "opengeo.map-definition.1.6.0"].includes(snapshot.definition.schemaVersion);
        showProjectFileReview(context, {
          file, format: "OpenGeo Studio managed Project snapshot",
          inspected: `Saved version ${snapshot.version} · ${Array.isArray(snapshot.definition.layers) ? snapshot.definition.layers.length : 0} Layer references`,
          description: supported
            ? "Create a separate map in this workspace. Current Layer and Style access will be checked; linked files, old history and access are not imported."
            : "This snapshot uses an older definition format. Upgrading it for import is still in development.",
          canOpen: supported && !context.publicDemo && canSaveAs(context),
          openLabel: "Create a new map…",
          conversionReport: false,
          onOpen: supported ? () => openSaveAsDialog(context, {
            definition: snapshot.definition,
            name: String(snapshot.project?.name ?? file.name.replace(/(?:\.opengeo-project)?\.json$/i, "")).trim().slice(0, 200) || "Imported map"
          }) : null
        });
        return;
      }
      const conversion = format === "geolibre" ? importGeoLibreProject(sourceText)
        : format === "geomoose" ? importGeoMooseMapbook(sourceText)
        : importWebMapContext(sourceText);
      const label = {geolibre: "GeoLibre Project", geomoose: "GeoMoose mapbook", wmc: "OGC Web Map Context"}[format];
      if (format === "geolibre") {
        context.pendingGeoLibreImport = conversion;
        context.pendingGeoLibreSource = {sourceText, filename: file.name};
        if (conversion.map.definition.extensions?.geolibre?.project?.metadata?.opengeo?.handoff) {
          if (typeof context.reviewGeoLibreReturn !== "function") throw Error("Open this return file in its saved OpenGeo Project to review the results.");
          setStatus(context, "Checking the opened Project revision and comparing GeoLibre results…");
          const result = await context.reviewGeoLibreReturn({conversion});
          if (context.disposed || context.projectFileReviewGeneration !== reviewGeneration) return;
          context.pendingGeoLibreImport = result.conversion;
          context.lastConversionReport = result.conversion.report;
          showGeoLibreReturnReview(context, file, result, sourceText);
          setStatus(context, "GeoLibre results are ready for review. No results have been saved.");
          return;
        }
      } else if (format === "geomoose") {
        context.pendingGeoMooseImport = conversion;
        context.pendingGeoMooseSource = {sourceText, filename: file.name};
      } else {
        context.pendingWebMapContextImport = conversion;
        context.pendingWebMapContextSource = {sourceText, filename: file.name};
      }
      context.lastConversionReport = conversion.report;
      const summary = conversion.report.summary;
      const inspected = format === "geomoose"
        ? `${conversion.map.definition.portal.sources.length} sources · ${countPortalNodes(conversion.map.definition.portal.catalog)} catalog entries · ${summary.rejected} sensitive fields removed.`
        : `${conversion.map.definition.layers.length} map layers · ${summary.unsupported} unsupported mappings · ${summary.rejected} sensitive fields removed.`;
      const canOpen = format === "geolibre" ? canPersist(context) && typeof context.applyGeoLibreImport === "function"
        : format === "wmc" ? context.publicDemo || typeof context.registerSource === "function" : true;
      showProjectFileReview(context, {
        file, format: label, inspected,
        description: format === "geomoose"
          ? "Opening adds portal configuration to this working OpenGeo Studio Project. Save the map to keep it."
          : format === "wmc"
            ? "Opening adds compatible map layers. In a saved Project, this may register governed sources before you save the map."
            : "Opening imports compatible layers into this saved OpenGeo Studio Project. Review the conversion report before continuing.",
        canOpen,
        onOpen: () => format === "geolibre" ? void applyInspectedGeoLibreProject(context)
          : format === "geomoose" ? applyInspectedGeoMooseMapbook(context)
          : void applyInspectedWebMapContext(context)
      });
    } catch (error) {
      setStatus(context, `Project file could not open: ${error?.message ?? "unsupported_file"}`);
    } finally {input.remove();}
  };
  context.shell.append(input);
  input.click();
}

function showProjectFileReview(context, {file, format, description, inspected = null, canOpen = false, onOpen = null,
  openLabel = "Open in this Project", conversionReport = Boolean(context.lastConversionReport)}) {
  const dialog = document.createElement("dialog");
  dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Review Project file");
  dialog.append(textElement("h2", "Open Project file"),
    textElement("p", `${file.name} · ${format}`),
    ...(inspected ? [textElement("p", inspected)] : []),
    textElement("p", description));
  const actions = document.createElement("div");
  actions.className = "platform-actions";
  actions.append(actionButton("Cancel", () => closeProjectFileDialog(dialog)));
  if (conversionReport && onOpen) {
    actions.append(actionButton("Download conversion report", () => downloadConversionReport(context)));
  }
  if (onOpen) {
    const open = actionButton(openLabel, () => {
      closeProjectFileDialog(dialog);
      onOpen();
    });
    open.disabled = !canOpen;
    if (!canOpen) open.title = "Open this file in a saved Project with the required edit access";
    actions.append(open);
  }
  dialog.append(actions);
  dialog.oncancel = () => dialog.remove();
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.open = true;
}

function openProjectExportDialog(context) {
  const dialog = document.createElement("dialog");
  dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Save as or export Project");
  dialog.append(textElement("h2", "Save as or export"),
    textElement("p", context.publicDemo
      ? "Download this browser Project or export it in another supported format. Opening a file is reviewed before it replaces your browser draft."
      : "Save a new map in this OpenGeo Studio Project, or download a file for another application. Review the conversion report for preserved and unsupported fields."));
  const label = document.createElement("label");
  label.textContent = "File format";
  const format = document.createElement("select");
  format.ariaLabel = "Project export format";
  const savedVersionAvailable = !context.publicDemo && context.savedProjectOrigin?.id
    && typeof context.styleAdapter?.listCompositionVersions === "function"
    && typeof context.styleAdapter?.getCompositionVersion === "function";
  const choices = [
    ...(context.publicDemo ? [["opengeo", "OpenGeo Studio Project (.opengeo-project.json)"]] : []),
    ...(savedVersionAvailable ? [["opengeo-saved", "OpenGeo Studio Project — saved version (.opengeo-project.json)"]] : []),
    ["geolibre", "GeoLibre Project (.geolibre.json)"],
    ["geomoose", "GeoMoose mapbook (.mapbook.xml)"],
    ["wmc", "OGC Web Map Context (.wmc)"],
    ["png", "Current map image (.png)"],
    ["jpeg", "Current map JPEG (.jpg)"],
    ["html", "Interactive map (.html)"]
  ];
  for (const [value, name] of choices) {
    const option = textElement("option", name); option.value = value; format.append(option);
  }
  label.append(format);
  const formatNote = textElement("p", "JPEG uses a white background for transparent areas.");
  formatNote.className = "platform-note";
  const versionDetails = document.createElement("div");
  let versionExport = null;
  const showVersionSelection = () => {
    formatNote.hidden = format.value !== "jpeg";
    versionDetails.hidden = format.value !== "opengeo-saved";
    if (format.value === "opengeo-saved" && !versionExport) {
      const origin = context.savedProjectOrigin;
      versionExport = ProjectVersionExport({adapter: context.styleAdapter, compositionId: origin.id,
        currentVersion: origin.version, isCurrent: () => !context.disposed && dialog.isConnected && dialog.open
          && context.savedProjectOrigin?.id === origin.id && context.savedProjectOrigin?.version === origin.version});
      versionDetails.append(versionExport);
    }
  };
  format.addEventListener("change", showVersionSelection);
  showVersionSelection();
  const feedback = textElement("p", ""); feedback.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.className = "platform-actions";
  const close = () => closeProjectFileDialog(dialog);
  if (!context.publicDemo && canSaveAs(context)) {
    actions.append(actionButton("Save a new OpenGeo Studio map", () => {close(); openSaveAsDialog(context);}));
  }
  if (!context.publicDemo && context.savedProjectOrigin && typeof context.prepareGeoLibreHandoff === "function") {
    actions.append(actionButton("Open in GeoLibre…", () => {close(); openGeoLibreHandoff(context);}));
  }
  const exportFile = actionButton("Export file", async () => {
    exportFile.disabled = true; format.disabled = true;
    feedback.textContent = format.value === "opengeo-saved" ? "Reading saved Project version…" : "Preparing export…";
    try {
      const action = {
        opengeo: () => downloadProject(context),
        "opengeo-saved": async () => {
          const retained = await versionExport.readSelected();
          downloadBlob(`${slug(context.project?.name ?? "project")}-v${retained.version}.opengeo-project.json`,
            savedProjectVersionFile(context.savedProjectOrigin.id, retained), "application/json");
        },
        geolibre: () => downloadGeoLibreProject(context),
        geomoose: () => downloadGeoMooseMapbook(context),
        wmc: () => downloadWebMapContext(context),
        png: () => exportCurrentMapImage(context, "png"),
        jpeg: () => exportCurrentMapImage(context, "jpeg"),
        html: () => exportInteractiveMap(context)
      }[format.value];
      await action();
      report.disabled = !context.lastConversionReport;
      feedback.textContent = format.value === "opengeo-saved"
        ? "Saved Project version downloaded. This file contains its definition and recorded change."
        : "Export requested. Check the map status for the result.";
    } catch (error) {
      feedback.textContent = [403, 404].includes(error?.status)
        ? "Saved version is unavailable. Check Project access."
        : error?.message ?? "Project file could not export. Try again.";
    } finally {exportFile.disabled = false; format.disabled = false;}
  });
  actions.append(exportFile);
  if (context.publicDemo) actions.append(actionButton("Publish with OpenGeo…", () => {close();exportInteractiveMap(context, "offline", "publication");}));
  const report = actionButton("Download conversion report", () => downloadConversionReport(context));
  report.disabled = !context.lastConversionReport;
  actions.append(report);
  if (context.lastImportRecovery) actions.append(actionButton("Download import recovery report", () => downloadImportRecoveryReport(context)));
  actions.append(actionButton("Close", close));
  dialog.append(label, formatNote, versionDetails, actions, feedback);
  dialog.oncancel = () => dialog.remove();
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.open = true;
}

function closeProjectFileDialog(dialog) {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.open = false;
  dialog.remove();
}

function openBrowserProjectFile(context) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".opengeo-project.json,.json,application/json";
  input.className = "opengeo-project-file-input"; input.hidden = true;
  input.oncancel = () => input.remove();
  input.onchange = async () => {
    const file = input.files?.[0];
    try {
      if (!file) return;
      if (file.size > BROWSER_PROJECT_FILE_BYTES) throw Error("Project file exceeds the 2 MB browser limit.");
      reviewBrowserProjectFile(context, file, await file.text());
    } catch (error) {setStatus(context, `Project could not open: ${error.message}`);}
    finally {input.remove();}
  };
  document.body.append(input); input.click();
}

function reviewBrowserProjectFile(context, file, sourceText) {
  const draft = readBrowserProjectFile(sourceText, {catalog: context.browserCatalog});
  // Check restoration before offering a mutation: unsupported Layers are never silently skipped.
  if (draft.layers.some(layer => !restoreDemoLayer(layer))) throw Error("This Project contains a Layer that cannot be restored in Demo.");
  const dialog = document.createElement("dialog"); dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Review Project file");
  dialog.append(textElement("h2", "Open Project file"),
    textElement("p", `${file.name} · OpenGeo Studio browser Project · ${draft.layers.length} Layers. Opening replaces this browser draft. Export the current Project first if you want to keep it.`),
    textElement("p", "Files stay in this browser and follow Demo's daily reset. Referenced services may load when the map opens."));
  const status = textElement("p", ""); status.setAttribute("role", "status");
  dialog.oncancel = () => dialog.remove();
  dialog.append(actionButton("Export current Project", () => downloadProject(context)),
    actionButton("Cancel", () => closeProjectFileDialog(dialog)), actionButton("Open in this Project", () => {
      try {
        const storage = browserLocalStorage();
        if (!storage) throw Error("Browser storage is unavailable. The current Project is unchanged.");
        const serialized = JSON.stringify({...draft, demoDate: demoDateKey()});
        if (new TextEncoder().encode(serialized).length > BROWSER_PROJECT_FILE_BYTES) throw Error("The normalized Project exceeds the browser storage limit.");
        storage.setItem(draftStorageKey(context.workspace, true, context.draftScopeId), serialized);
        location.reload();
      } catch (error) {status.textContent = error.message;}
    }), status);
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.open = true;
}

function downloadProject(context) {
  const definition = currentProjectDefinition(context);
  const payload = {
    workspaceId: context.workspace?.workspaceId,
    tenantId: context.workspace?.tenantId,
    ...definition,
    updatedAt: new Date().toISOString(),
    updatedBy: "browser-session",
    persistence: context.publicDemo
      ? {mode: "browser-only-demo", uploaded: false, published: false}
      : {
          provider: context.storage.provider,
          bucket: context.storage.bucket,
          prefix: context.storage.prefix,
          key: projectObjectKey(context),
          uri: projectS3Uri(context)
        }
  };
  downloadBlob(`${slug(context.project?.name ?? context.workspace?.title ?? "workspace")}.opengeo-project.json`, JSON.stringify(payload, null, 2), "application/json");
}

function inspectGeoLibreProject(context) {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.className = "geolibre-project-input";
  input.accept = ".geolibre.json,.json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return input.remove();
    try {
      const sourceText = await file.text();
      const result = importGeoLibreProject(sourceText);
      context.pendingGeoLibreImport = result;
      context.pendingGeoLibreSource = {sourceText, filename: file.name};
      context.lastConversionReport = result.report;
      const summary = result.report.summary;
      setStatus(
        context,
        `GeoLibre project inspected offline: ${result.map.definition.layers.length} mapped layers, ${result.records.externalSources.length} governed source candidates, ${summary.unsupported} unsupported, ${summary.rejected} sensitive fields removed. Nothing was persisted.`
      );
    } catch (error) {
      setStatus(context, `GeoLibre inspection failed safely: ${error.message}`);
    } finally {
      input.remove();
    }
  }, {once: true});
  context.shell.append(input);
  input.click();
}

function inspectGeoMooseMapbook(context) {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.className = "geomoose-mapbook-input";
  input.accept = ".xml,.mapbook.xml,application/xml,text/xml";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return input.remove();
    try {
      const sourceText = await file.text();
      const result = importGeoMooseMapbook(sourceText);
      context.pendingGeoMooseImport = result;
      context.pendingGeoMooseSource = {sourceText, filename: file.name};
      context.lastConversionReport = result.report;
      const portal = result.map.definition.portal;
      setStatus(
        context,
        `GeoMoose mapbook inspected offline: ${portal.sources.length} sources, ${countPortalNodes(portal.catalog)} catalog entries, ${countPortalNodes(portal.tools)} tools, and ${result.report.summary.rejected} credential-like fields removed. Nothing was persisted.`
      );
    } catch (error) {
      setStatus(context, `GeoMoose mapbook inspection failed safely (${error?.code ?? "invalid_mapbook"}).`);
    } finally {
      input.remove();
    }
  }, {once: true});
  context.shell.append(input);
  input.click();
}

function inspectWebMapContext(context) {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.className = "web-map-context-input";
  input.accept = ".wmc,.cml,.xml,application/xml,text/xml";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return input.remove();
    try {
      const sourceText = await file.text();
      const result = importWebMapContext(sourceText);
      context.pendingWebMapContextImport = result;
      context.pendingWebMapContextSource = {sourceText, filename: file.name};
      context.lastConversionReport = result.report;
      const summary = result.report.summary;
      setStatus(
        context,
        `Web Map Context inspected offline: ${result.map.definition.layers.length} WMS layers, ${result.records.externalSources.length} governed source candidates, ${summary.unsupported} unsupported mappings, and ${summary.rejected} sensitive references removed. Nothing was persisted.`
      );
    } catch (error) {
      setStatus(context, `Web Map Context inspection failed safely (${error?.code ?? "invalid_wmc"}).`);
    } finally {
      input.remove();
    }
  }, {once: true});
  context.shell.append(input);
  input.click();
}

async function applyInspectedWebMapContext(context) {
  const conversion = context.pendingWebMapContextImport;
  if (!conversion?.map?.definition) {
    setStatus(context, "Inspect an OGC Web Map Context 1.1 document before opening it.");
    return;
  }
  const directLayers = conversion.map.definition.layers.filter(({sourceType}) => sourceType === "wms-raster");
  if (context.publicDemo) {
    for (const layer of [...conversion.map.definition.layers].reverse()) {
      if (context.layers.some(({layerId}) => layerId === layer.layerId)) continue;
      context.addLayer({...structuredClone(layer), fixtureSource: true, governedSource: false}, null);
    }
    openWebMapContextExtent(context, conversion);
    context.lastConversionReport = conversion.report;
    setStatus(
      context,
      `${directLayers.length} WMC layers opened in this browser-only demo. Inspectable unsupported references remain hidden, and no shared record was changed.`
    );
    return;
  }
  if (typeof context.registerSource !== "function") {
    setStatus(context, "A persistent project connection and editor role are required to apply WMC sources.");
    return;
  }
  const registrationByRef = new Map(conversion.records.externalSources.map((record) => [record.importRef, record]));
  const governableLayers = directLayers.filter((layer) => registrationByRef.has(layer.layerId));
  if (!governableLayers.length) {
    setStatus(context, "This WMC has no directly governable HTTPS Web Mercator WMS layers. Review the conversion report and register compatible sources individually.");
    return;
  }
  const registered = [];
  setStatus(context, `Registering ${governableLayers.length} governed WMS source revisions. The map remains unchanged until registration completes.`);
  try {
    for (const layer of [...governableLayers].reverse()) {
      const candidate = registrationByRef.get(layer.layerId);
      if (!candidate) continue;
      const {importRef: _importRef, ...registration} = candidate;
      const source = await context.registerSource(registration);
      context.sources.push(source);
      registered.push({layer, source});
    }
  } catch (error) {
    context.lastImportRecovery = {
      format: "ogc-wmc-1.1",
      sourceFile: context.pendingWebMapContextSource?.filename ?? null,
      registeredDatasetIds: registered.map(({source}) => source.datasetId),
      unresolvedLayerIds: governableLayers.filter((layer) => !registered.some(({layer: item}) => item.layerId === layer.layerId)).map(({layerId}) => layerId),
      instruction: "Review the registered source revisions, then re-inspect the exact WMC document before retrying. The project map was not changed."
    };
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `WMC source registration stopped without changing the map.${request} Download the recovery report before retrying.`);
    return;
  }
  for (const {layer, source} of registered) {
    const governed = layerFromExternalSource(source);
    context.addLayer({
      ...governed,
      title: layer.title,
      visible: layer.visible,
      opacity: layer.opacity,
      ...(layer.opacityMode ? {opacityMode: validateOpacityMode(layer)} : {}),
      order: layer.order,
      wmcDocumentIndex: layer.wmcDocumentIndex
    }, null);
  }
  openWebMapContextExtent(context, conversion);
  context.lastConversionReport = conversion.report;
  setStatus(context, `${registered.length} governed WMC source revisions are now in the working map. Choose Save authoritative map to persist the composition.`);
}

function openWebMapContextExtent(context, conversion) {
  const bounds = conversion?.map?.definition?.mapViews?.[0]?.bbox;
  if (!context.state.map || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return;
  context.state.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {padding: 24, duration: 0});
}

function applyInspectedGeoMooseMapbook(context) {
  const conversion = context.pendingGeoMooseImport;
  if (!conversion?.map?.definition?.portal) {
    setStatus(context, "Inspect a GeoMoose 3.15.2 mapbook before applying its portal configuration.");
    return;
  }
  context.state.portalConfiguration = normalizePortalConfiguration(conversion.map.definition.portal);
  context.state.portalConversionReport = structuredClone(conversion.report);
  context.state.portalExtensions = portalExtensionForProject(conversion.map.definition);
  context.state.colorMode = context.state.portalConfiguration.theme.colorMode;
  context.state.leftPanelMode = "layers";
  context.state.portalConfigurationOpen = true;
  context.state.leftOpen = true;
  context.lastConversionReport = conversion.report;
  context.render();
  setStatus(
    context,
    context.publicDemo
      ? "GeoMoose portal configuration is running in this browser. Save locally to retain it through reload, then review the field-level report."
      : "GeoMoose portal configuration is running standalone. Choose Save to version it in the authoritative map record."
  );
}

async function applyInspectedGeoLibreProject(context) {
  if (!context.pendingGeoLibreImport || !context.pendingGeoLibreSource) {
    setStatus(context, "Inspect a GeoLibre project before starting a governed import.");
    return;
  }
  if (typeof context.applyGeoLibreImport !== "function") {
    setStatus(context, "A persistent API-backed project and editor role are required for governed import.");
    return;
  }
  context.shell.dataset.importState = "running";
  setStatus(context, "Registering governed sources and uploading embedded GeoJSON. The target map is unchanged until atomic finalization.");
  try {
    const result = await context.applyGeoLibreImport({
      conversion: context.pendingGeoLibreImport,
      sourceText: context.pendingGeoLibreSource.sourceText,
      filename: context.pendingGeoLibreSource.filename
    });
    context.shell.dataset.importState = "completed";
    setStatus(context, `GeoLibre import ${result.operation.importId} completed at map version ${result.operation.finalMapVersion}.`);
  } catch (error) {
    context.shell.dataset.importState = "recovery";
    context.lastImportRecovery = error.importRecovery ?? {
      importId: null,
      unresolvedImportRefs: [],
      instruction: "Re-inspect the exact source project and retry."
    };
    const operation = context.lastImportRecovery.importId
      ? ` Operation ${context.lastImportRecovery.importId}.`
      : "";
    const request = error?.requestId ? ` Request ${error.requestId}.` : "";
    setStatus(context, `Governed import stopped without changing the map.${operation}${request} Download the recovery report before retrying.`);
  }
}

function openGeoLibreHandoff(context) {
  const origin = context.savedProjectOrigin;
  if (!origin || typeof context.prepareGeoLibreHandoff !== "function") return;
  const dialog = document.createElement("dialog");
  dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Open in GeoLibre");
  dialog.append(textElement("h2", "Open in GeoLibre"),
    textElement("p", `Open saved revision ${origin.version}. Save current edits first if you want to include them.`),
    textElement("p", "Download this revision, open the GeoLibre workbench, and open the downloaded file there. Save your GeoLibre project file when finished, then use Open Project file here to review and save the results."),
    textElement("p", "This workflow supports complete managed vector data and compatible source references. Raster outputs and processing notifications alone cannot be returned as saved data."));
  const status = textElement("p", ""); status.setAttribute("role", "status");
  const download = actionButton("Download saved revision", async () => {
    download.disabled = true;
    status.textContent = "Reading the saved revision and complete vector inputs…";
    try {
      const result = await context.prepareGeoLibreHandoff({
        map: {...origin, name: context.project?.name ?? context.workspace?.title ?? "OpenGeo Studio project"},
        embeddedDataByLayerId: context.dataByLayerId
      });
      if (context.disposed || !dialog.isConnected || !dialog.open) return;
      context.lastConversionReport = result.report;
      downloadBlob(`${slug(context.project?.name ?? "project")}-v${origin.version}.geolibre.json`, result.json, "application/json");
      status.textContent = `Saved revision ${origin.version} downloaded. Open this file in GeoLibre. Review the conversion report for unsupported content.`;
    } catch (error) {status.textContent = error?.message ?? "The saved revision could not be downloaded.";}
    finally {download.disabled = false;}
  });
  const link = document.createElement("a");
  link.textContent = "Open GeoLibre workbench";
  link.href = "https://web.geolibre.app/";
  link.target = "_blank"; link.rel = "noopener noreferrer";
  const actions = document.createElement("div"); actions.className = "platform-actions";
  actions.append(download, link, actionButton("Download conversion report", () => downloadConversionReport(context)),
    actionButton("Close", () => closeProjectFileDialog(dialog)));
  dialog.append(actions, status);
  dialog.oncancel = () => dialog.remove();
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.open = true;
}

function showGeoLibreReturnReview(context, file, {conversion, review}, sourceText) {
  const dialog = document.createElement("dialog");
  dialog.className = "browser-project-open-dialog browser-layer-registration";
  dialog.setAttribute("aria-label", "Review GeoLibre results");
  dialog.append(textElement("h2", "Review GeoLibre results"), textElement("p", file.name),
    textElement("p", `Opened revision ${review.base.mapVersion} · current saved revision ${review.current.mapVersion}.`),
    textElement("p", review.conflict
      ? "This Project changed after it was opened in GeoLibre. Save the reviewed results as a new map to keep both versions."
      : "Saving creates a new saved revision and replaces this map’s working composition. Original data remains preserved; changed data becomes a separate derivative Layer."));
  const changes = document.createElement("ul");
  for (const message of [
    `${review.unchanged.length} unchanged Layers reuse their existing identities.`,
    `${review.added.length} added outputs: ${review.added.join(", ") || "none"}.`,
    ...review.changed.map(change => `${change.layerId}: ${change.changes.join(", ")}${change.derivativeLayerId ? ` → ${change.derivativeLayerId}` : ""}.`),
    `${review.styles.length} Layers with changed styles: ${review.styles.join(", ") || "none"}.`,
    `${review.removed.length} removed from the returned composition: ${review.removed.join(", ") || "none"}.`,
    ...review.limits
  ]) changes.append(textElement("li", message));
  dialog.append(changes,
    textElement("p", "Saved outputs retain the reported processing history and conversion limits. They do not establish a reproducible analysis when exact parameters or execution details are missing. Publication review and access remain separate."));
  const returnRecord = conversion.map.definition.extensions?.opengeoGeoLibreReturn;
  const inputSelections = [];
  if (returnRecord?.outputs?.length && returnRecord.inputs?.length) {
    dialog.append(textElement("p", "Select the source Layers used for each output. These links record your review; they do not verify how GeoLibre ran the analysis. Leave independent new data unlinked."));
    for (const output of returnRecord.outputs) {
      const label = document.createElement("label"); label.textContent = `Input Layers for ${output.layerId}`;
      const select = document.createElement("select"); select.multiple = true;
      select.ariaLabel = `Input Layers for ${output.layerId}`;
      select.size = Math.min(4, returnRecord.inputs.length);
      for (const input of returnRecord.inputs) {
        const option = textElement("option", input.layerId); option.value = input.layerId;
        option.selected = output.inputLayerIds.includes(input.layerId); select.append(option);
      }
      label.append(select); dialog.append(label); inputSelections.push({output, select});
    }
  }
  const newMapLabel = document.createElement("label"); newMapLabel.textContent = "New map name";
  const newMapName = document.createElement("input"); newMapName.type = "text"; newMapName.maxLength = 200;
  newMapName.ariaLabel = "New map name"; newMapName.value = `${context.project?.name ?? "GeoLibre results"} — results`.slice(0, 200);
  newMapLabel.append(newMapName); newMapLabel.hidden = true;
  const status = textElement("p", ""); status.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.className = "platform-actions";
  const buttons = [];
  let saving = false;
  let submitted = false;
  let submittedMapName = null;
  const save = async asNewMapName => {
    if (saving) return;
    saving = true;
    buttons.forEach(button => {button.disabled = true;});
    cancel.disabled = true;
    status.textContent = "Saving reviewed results to OpenGeo…";
    context.shell.dataset.importState = "running";
    try {
      if (!submitted) {
        for (const {output, select} of inputSelections) {
          output.inputLayerIds = [...select.selectedOptions].map(option => option.value);
          output.inputLinkMethod = "user-declared";
          select.disabled = true;
        }
        newMapName.disabled = true;
        submittedMapName = asNewMapName;
        submitted = true;
      }
      const result = await context.applyGeoLibreImport({conversion,
        sourceText,
        filename: file.name, review, ...(submittedMapName ? {asNewMapName: submittedMapName} : {})});
      context.shell.dataset.importState = "completed";
      closeProjectFileDialog(dialog);
      if (context.disposed) return;
      setStatus(context, `GeoLibre results saved at revision ${result.operation.finalMapVersion}. Reopen the saved map to continue or publish its reviewed edition.`);
      if (result.mapId) location.href = compositionHref(result.mapId, {adapterKind: context.persistenceMode});
    } catch (error) {
      saving = false;
      cancel.disabled = false;
      context.shell.dataset.importState = "recovery";
      context.lastImportRecovery = error.importRecovery ?? null;
      status.textContent = `${error?.message ?? "Results could not be saved."} Retry keeps the submitted inputs and map name. Reopen the file to change the review.`;
      buttons.forEach(button => {button.disabled = !canPersist(context);});
      apply.disabled = review.conflict || !canPersist(context);
    }
  };
  const apply = actionButton("Save results to OpenGeo", () => void save(null));
  apply.disabled = review.conflict || !canPersist(context) || typeof context.applyGeoLibreImport !== "function";
  buttons.push(apply);
  const cancel = actionButton("Cancel", () => {if (!saving) closeProjectFileDialog(dialog);});
  actions.append(cancel,
    actionButton("Download conversion report", () => downloadConversionReport(context)), apply);
  if (review.conflict) {
    const separate = actionButton("Save results as a new map…", () => {
      if (newMapLabel.hidden) {newMapLabel.hidden = false; separate.textContent = "Save new map"; newMapName.focus(); return;}
      const name = newMapName.value.trim();
      if (!name) {status.textContent = "Enter a name for the new map."; newMapName.focus(); return;}
      void save(name);
    });
    separate.disabled = !canPersist(context) || typeof context.applyGeoLibreImport !== "function";
    buttons.push(separate); actions.append(separate);
  }
  dialog.append(newMapLabel, actions, status);
  dialog.oncancel = event => {if (saving) event.preventDefault(); else dialog.remove();};
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.open = true;
}

function downloadGeoLibreProject(context) {
  try {
    const definition = {
      ...structuredClone(context.project ?? {}),
      ...currentProjectDefinition(context)
    };
    const result = exportGeoLibreProject(
      {name: context.project?.name ?? context.workspace?.title ?? "OpenGeo Studio project", definition},
      {embeddedDataByLayerId: context.dataByLayerId}
    );
    context.lastConversionReport = result.report;
    downloadBlob(`${slug(context.project?.name ?? context.workspace?.title ?? "project")}.geolibre.json`, result.json, "application/json");
    setStatus(context, `GeoLibre ${result.report.target.version} project exported with ${result.report.summary.preserved} extension-preserved and ${result.report.summary.unsupported} unsupported field records. Review the conversion report before sharing.`);
  } catch (error) {
    setStatus(context, `GeoLibre export failed safely: ${error.message}`);
  }
}

function exportInteractiveMap(context, initialMode = "live", initialFormat = "html") {
  if (context.rendererAdapter.id !== "maplibre") {setStatus(context, "Switch to MapLibre for portable map export."); return false;}
  const map = context.state.map;
  if (!map || !map.isStyleLoaded()) {setStatus(context, "Wait for the map to load before exporting."); return false;}
  const title = context.project?.name ?? context.workspace?.title ?? "OpenGeo Studio map";
  openStaticMapExport({map, title, savedProjectOrigin: context.savedProjectOrigin, layers: context.layers, handles: context.state.layerHandles, initialMode, initialFormat,
    onInsert: context.onPublicationMapExport,
    downloadBundle: blob => downloadBlob(`${slug(title)}.developer.zip`, blob, "application/zip"),
    downloadPublication: blob => downloadBlob(`${slug(title)}.publication-source.zip`, blob, "application/zip"),
    publicationHref: context.demoSurface ? `${MANAGED_STUDIO_URL}workspaces?view=publishing` : "/workspaces?view=publishing",
    downloadManifest: manifest => downloadBlob(`${slug(title)}.html.artifact.json`, JSON.stringify(manifest, null, 2), "application/json"),
    download: html => downloadBlob(`${slug(title)}.html`, html, "text/html;charset=utf-8")});
  return true;
}

async function exportCurrentMapImage(context, format = "png") {
  const jpeg = format === "jpeg", name = jpeg ? "JPEG" : "PNG";
  if (context.rendererAdapter.id !== "maplibre") {setStatus(context, `Switch to MapLibre for verified ${name} export.`); return;}
  const {state} = context;
  if (state.mapExportState === "running") return;
  const map = state.map;
  const canvas = map?.getCanvas?.();
  if (!map || !canvas) {
    setStatus(context, `Map ${name} export is unavailable until the interactive map finishes loading.`);
    return;
  }
  state.mapExportState = "running";
  setStatus(context, "Capturing the current rendered map and its provenance receipt…");
  try {
    map.triggerRepaint?.();
    const [image, manifest] = await Promise.all([
      jpeg ? canvasJpegBlob(canvas) : canvasPngBlob(canvas),
      Promise.resolve(createMapExportManifest({
        workspace: context.workspace,
        project: context.project,
        map,
        canvas,
        layers: context.layers,
        basemap: activeBasemap(context),
        format
      }))
    ]);
    const filename = slug(context.project?.name ?? context.workspace?.title ?? "opengeo-map");
    downloadBlob(`${filename}.${jpeg ? "jpg" : "png"}`, image, jpeg ? "image/jpeg" : "image/png");
    downloadBlob(
      `${filename}.map-export.json`,
      JSON.stringify(manifest, null, 2),
      "application/json"
    );
    state.mapExportState = "completed";
    setStatus(
      context,
      `Current map exported as bounded ${name} with ${manifest.layers.length} visible-layer source receipts and ${manifest.attribution.length} attribution records.`
    );
  } catch (error) {
    state.mapExportState = "failed";
    setStatus(context, `Map ${name} export stopped safely (${error?.code ?? "map_export_unavailable"}).`);
  }
}

function downloadGeoMooseMapbook(context) {
  try {
    const definition = {
      ...structuredClone(context.project ?? {}),
      ...currentProjectDefinition(context)
    };
    const result = exportGeoMooseMapbook({name: context.project?.name ?? context.workspace?.title ?? "OpenGeo Studio portal", definition});
    context.lastConversionReport = result.report;
    downloadBlob(`${slug(context.project?.name ?? context.workspace?.title ?? "project")}.mapbook.xml`, result.xml, "application/xml");
    setStatus(context, `GeoMoose 3.15 mapbook exported with ${result.report.summary.preserved} OpenGeo Studio-only fields retained in the project conversion report.`);
  } catch (error) {
    setStatus(context, `GeoMoose export failed safely (${error?.code ?? "invalid_portal_configuration"}).`);
  }
}

function downloadWebMapContext(context) {
  try {
    const definition = {
      ...structuredClone(context.project ?? {}),
      ...currentProjectDefinition(context)
    };
    const canvas = context.state.map?.getCanvas?.();
    const result = exportWebMapContext(
      {
        name: context.project?.name ?? context.workspace?.title ?? "OpenGeo Studio map",
        description: context.project?.description ?? null,
        definition
      },
      {
        bounds: authoringMapExtent(context),
        width: canvas?.width || 1_280,
        height: canvas?.height || 720
      }
    );
    context.lastConversionReport = result.report;
    downloadBlob(`${slug(context.project?.name ?? context.workspace?.title ?? "opengeo-map")}.wmc`, result.xml, "application/xml");
    setStatus(context, `OGC Web Map Context 1.1 exported with ${result.report.summary.unsupported} unsupported and ${result.report.summary.preserved} extension-preserved mappings. Review the conversion report before sharing.`);
  } catch (error) {
    setStatus(context, `Web Map Context export failed safely (${error?.code ?? "wmc_export_unavailable"}).`);
  }
}

function downloadConversionReport(context) {
  if (!context.lastConversionReport) {
    setStatus(context, "Inspect or export a portable project or mapbook before downloading a conversion report.");
    return;
  }
  downloadBlob(
    `${slug(context.project?.name ?? context.workspace?.title ?? "project")}.conversion-report.json`,
    JSON.stringify(context.lastConversionReport, null, 2),
    "application/json"
  );
  setStatus(context, "Field-level conversion report downloaded.");
}

function downloadImportRecoveryReport(context) {
  if (!context.lastImportRecovery) {
    setStatus(context, "No interrupted import recovery report is available.");
    return;
  }
  downloadBlob(
    `${slug(context.project?.name ?? context.workspace?.title ?? "project")}.import-recovery.json`,
    JSON.stringify(context.lastImportRecovery, null, 2),
    "application/json"
  );
  setStatus(context, "Import recovery report downloaded without project data or credentials.");
}

async function shareCurrentLink(context) {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus(context, "Workspace link copied.");
  } catch {
    setStatus(context, "Workspace link is available in the address bar.");
  }
}

function featureRows(geojson, filterText) {
  const needle = filterText.trim().toLowerCase();
  return (geojson.features ?? [])
    .map((feature, index) => ({index, feature, values: feature.properties ?? {}}))
    .filter((row) => !needle || Object.values(row.values).some((value) => String(value).toLowerCase().includes(needle)))
    .slice(0, 100);
}

function attributeTable(rows, context, layer, {onSelect = null} = {}) {
  const table = document.createElement("table");
  table.className = "gis-attribute-table";
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", `${layer?.title ?? "Layer"} attribute table`);
  if (!rows.length) {
    table.append(document.createElement("tbody"));
    table.tBodies[0].append(document.createElement("tr"));
    table.tBodies[0].rows[0].append(textElement("td", "No matching records."));
    return table;
  }
  const fields = Object.keys(rows[0].values).slice(0, 7);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(textElement("th", "#"));
  for (const field of fields) headRow.append(textElement("th", field));
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const selected = row.index === context.state.selectedFeatureIndex;
    tr.classList.toggle("selected", selected);
    tr.dataset.featureIndex = String(row.index);
    if (row.feature?.id !== undefined && row.feature?.id !== null) {
      tr.dataset.featureId = String(row.feature.id);
    }
    tr.tabIndex = selected || (context.state.selectedFeatureIndex === null && row === rows[0]) ? 0 : -1;
    tr.setAttribute("aria-selected", selected ? "true" : "false");
    const selectRow = () => {
      context.state.selectedFeatureIndex = row.index;
      onSelect?.(row);
      zoomToFeature(context, layer, row.feature);
      context.render();
      requestAnimationFrame(() => context.shell
        .querySelector(`.gis-attribute-table tbody tr[data-feature-index="${row.index}"]`)
        ?.focus());
    };
    tr.addEventListener("click", selectRow);
    tr.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        selectRow();
        return;
      }
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      const sibling = event.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
      if (!(sibling instanceof HTMLElement)) return;
      event.preventDefault();
      tr.tabIndex = -1;
      sibling.tabIndex = 0;
      sibling.focus();
    });
    tr.append(textElement("td", row.index + 1));
    for (const field of fields) tr.append(textElement("td", row.values[field]));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function attributeSummary(rows, total) {
  const summary = document.createElement("div");
  summary.className = "gis-attribute-summary";
  summary.append(textElement("strong", `${rows.length}`), textElement("span", `of ${total} rows shown`));
  return summary;
}

function compactTable(title, rows) {
  const section = document.createElement("section");
  section.className = "gis-compact-section";
  section.append(textElement("h3", title));
  if (!rows.length) {
    section.append(textElement("p", "None"));
    return section;
  }
  const table = document.createElement("table");
  table.className = "gis-compact-table";
  const fields = Object.keys(rows[0]);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const field of fields) tr.append(textElement("td", row[field]));
    tbody.append(tr);
  }
  table.append(tbody);
  section.append(table);
  return section;
}

function compactKeyValues(values) {
  const dl = document.createElement("dl");
  dl.className = "gis-key-values";
  for (const [key, value] of Object.entries(values)) {
    dl.append(textElement("dt", key), textElement("dd", value));
  }
  return dl;
}

function editorSection(title, description) {
  const section = document.createElement("section");
  section.className = "gis-editor-section";
  section.append(textElement("h3", title));
  if (description) section.append(textElement("p", description));
  return section;
}

function palettePicker(context, layer, geojson, colorKey) {
  const base = layer.style?.[colorKey] ?? layerColor(layer);
  const wrapper = document.createElement("div");
  wrapper.className = "gis-palette-picker";
  wrapper.append(textElement("span", "Palette"));

  for (const [id, title, colors] of STYLE_PALETTES) {
    const palette = id === "mono" ? paletteFromColor(base) : colors;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gis-palette-button";
    button.title = title;
    button.ariaLabel = `${title} palette`;
    for (const color of palette) {
      const swatch = document.createElement("span");
      swatch.style.background = color;
      button.append(swatch);
    }
    button.addEventListener("click", () => {
      layer.style.paletteName = id;
      layer.style.palette = palette;
      if (layer.style.renderer === "graduated") {
        layer.style.graduated = {
          ...validGraduatedStyle(
            layer.style.graduated,
            layer.style.graduated?.field ?? safeNumericPropertyFields(geojson)[0]
          ),
          colors: palette.slice(0, 5)
        };
      } else {
        applyPrimaryColor(layer, palette[0]);
      }
      repaintLayer(context, layer);
      context.render();
      setStatus(context, `${title} palette applied to ${layer.title}.`);
    });
    wrapper.append(button);
  }

  return wrapper;
}

function rendererLegend(layer, geojson, resolved) {
  if (layer.styleReference && resolved?.pattern) return PatternLegend(resolved);
  if (layer.styleReference) return textElement("p", `Referenced Style · version ${layer.styleReference.versionNumber}. Inspect its definition for symbology.`);
  const renderer = layer.style?.renderer;
  if (!renderer || renderer === "single") return null;
  if (renderer === "graduated") {
    let entries;
    try {
      entries = graduatedLegendEntries(layer.style.graduated);
    } catch {
      return null;
    }
    const legend = document.createElement("div");
    legend.className = "gis-style-legend";
    legend.append(textElement("strong", layer.style?.legendTitle ?? "Statewide percentile"));
    for (const entry of entries) {
      const row = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = entry.color;
      row.append(swatch, textElement("span", entry.label));
      legend.append(row);
    }
    return legend;
  }
  const values = renderer === "status"
    ? ["verified", "needs review", "draft"]
    : topFieldValues(geojson, layer.style?.categoryField, 5);
  if (!values.length) return null;

  const palette = renderer === "status"
    ? ["#16a34a", "#f59e0b", "#64748b"]
    : stylePalette(layer, layerColor(layer));
  const legend = document.createElement("div");
  legend.className = "gis-style-legend";
  legend.append(textElement("strong", "Preview"));
  for (const [index, value] of values.entries()) {
    const row = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = palette[index % palette.length];
    row.append(swatch, textElement("span", String(value)));
    legend.append(row);
  }
  return legend;
}

function textField(label, value, onChange, {placeholder = ""} = {}) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.addEventListener("change", () => onChange(input.value.trim()));
  return fieldWrap(label, input);
}

function panelShell() {
  const panel = document.createElement("div");
  panel.className = "gis-panel-body";
  return panel;
}

function colorInput(label, value, onInput) {
  const input = document.createElement("input");
  input.type = "color";
  input.value = value;
  input.addEventListener("input", () => onInput(input.value));
  return fieldWrap(label, input);
}

function rangeInput(label, {min, max, step, value, onInput}) {
  const input = document.createElement("input");
  const output = textElement("span", `${label}: ${value}`);
  input.type = "range";
  input.setAttribute("aria-label", label);
  input.min = `${min}`;
  input.max = `${max}`;
  input.step = `${step}`;
  input.value = `${value}`;
  input.addEventListener("input", () => {
    const next = Number(input.value);
    output.textContent = `${label}: ${next}`;
    onInput(next);
  });
  const wrapper = fieldWrap("", input);
  wrapper.prepend(output);
  return wrapper;
}

function selectField(label, value, options, onChange) {
  const select = document.createElement("select");
  for (const [id, title] of options.length ? options : [["", "No fields"]]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = title;
    option.selected = id === value;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  return fieldWrap(label, select);
}

function checkField(label, checked, onChange) {
  const wrapper = document.createElement("label");
  wrapper.className = "gis-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrapper.append(input, textElement("span", label));
  return wrapper;
}

function fieldWrap(label, input) {
  const wrapper = document.createElement("label");
  wrapper.className = "gis-field";
  if (label) {
    wrapper.append(textElement("span", label));
    input.setAttribute("aria-label", label);
  }
  wrapper.append(input);
  return wrapper;
}

function textInput(label, value) {
  const input = document.createElement("input");
  input.value = value;
  return {input, wrapper: fieldWrap(label, input)};
}

function textAreaInput(label, value, placeholder = "") {
  const input = document.createElement("textarea");
  input.value = value;
  input.placeholder = placeholder;
  input.rows = 3;
  return {input, wrapper: fieldWrap(label, input)};
}

function selectInput(label, value, options) {
  const input = document.createElement("select");
  for (const [id, title] of options) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = title;
    option.selected = id === value;
    input.append(option);
  }
  return {input, wrapper: fieldWrap(label, input)};
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function labeledActionButton(label, accessibleLabel, onClick) {
  const button = actionButton(label, onClick);
  button.setAttribute("aria-label", accessibleLabel);
  return button;
}

function navLink(label, href) {
  const link = document.createElement("a");
  link.className = "gis-button gis-link-button";
  link.href = href;
  link.textContent = label;
  const path = typeof location === "undefined" ? "" : location.pathname;
  link.classList.toggle("active", href === "/" ? path === "/" : path.startsWith(href));
  return link;
}

function selectOption({value, title, selected = false}) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = title;
  option.selected = selected;
  return option;
}

function iconButton(title, label, onClick) {
  const button = actionButton(label, onClick);
  button.classList.add("gis-icon-button");
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function svgIconButton(title, iconName, onClick) {
  const button = iconButton(title, "", onClick);
  button.classList.add("gis-svg-icon-button");
  const icon = primaryCommandIcon(iconName);
  icon.setAttribute("aria-hidden", "true");
  button.replaceChildren(icon);
  return button;
}

function addSource(id) {
  for (const group of ADD_DATA_SOURCES) {
    const source = group.sources.find(([sourceId]) => sourceId === id);
    if (source) return source;
  }
  return null;
}

function activeLayer(context) {
  return context.layers.find((layer) => layer.layerId === context.state.activeLayerId) ?? context.layers[0] ?? null;
}

function propertyFields(geojson) {
  const fields = new Set();
  for (const feature of geojson?.features ?? []) {
    for (const key of Object.keys(feature.properties ?? {})) fields.add(key);
  }
  return [...fields];
}

function safeNumericPropertyFields(geojson) {
  try {
    return numericPropertyFields(geojson);
  } catch {
    return [];
  }
}

function validGraduatedStyle(value, fallbackField) {
  try {
    return normalizeGraduatedStyle(value);
  } catch {
    return normalizeGraduatedStyle({field: fallbackField});
  }
}

function graduatedColorForLayer(layer, fallback) {
  try {
    return graduatedColorExpression(layer.style?.graduated, fallback);
  } catch {
    return fallback;
  }
}

function hasStatusField(geojson) {
  return propertyFields(geojson).includes("status");
}

function categoryColorExpression(layer, geojson, fallback) {
  const field = layer.style?.categoryField;
  const values = topFieldValues(geojson, field, 8);
  if (!field || !values.length) return fallback;
  const palette = stylePalette(layer, fallback);
  return ["match", ["to-string", ["get", field]], ...values.flatMap((value, index) => [String(value), palette[index % palette.length]]), fallback];
}

function topFieldValues(geojson, field, limit = 8) {
  if (!geojson || !field) return [];
  const counts = new Map();
  for (const feature of geojson.features ?? []) {
    const value = feature.properties?.[field];
    if (value === undefined || value === null || value === "") continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function stylePalette(layer, fallback) {
  if (Array.isArray(layer.style?.palette) && layer.style.palette.length) return layer.style.palette;
  const named = STYLE_PALETTES.find(([id]) => id === layer.style?.paletteName);
  if (named?.[2]?.length) return named[2];
  return paletteFromColor(fallback);
}

function paletteFromColor(hex) {
  return [
    lighter(hex, 0.32),
    hex,
    darker(hex, 0.18),
    rotateHue(hex, 40),
    rotateHue(hex, -40)
  ];
}

function applyPrimaryColor(layer, value) {
  if (layer.geometryType?.includes("Point")) {
    layer.style.circleColor = value;
  } else if (layer.geometryType?.includes("Polygon")) {
    layer.style.fill = value;
    layer.style.stroke ??= darker(value, 0.24);
  } else {
    layer.style.stroke = value;
  }
}

function layerColor(layer) {
  return layer.style?.circleColor ?? layer.style?.fill ?? layer.style?.stroke ?? "#2563eb";
}

function lighter(hex, amount) {
  const color = hexToRgb(hex);
  return rgbToHex({
    r: color.r + (255 - color.r) * amount,
    g: color.g + (255 - color.g) * amount,
    b: color.b + (255 - color.b) * amount
  });
}

function darker(hex, amount) {
  const color = hexToRgb(hex);
  return rgbToHex({
    r: color.r * (1 - amount),
    g: color.g * (1 - amount),
    b: color.b * (1 - amount)
  });
}

function rotateHue(hex, degrees) {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.h = (hsl.h + degrees + 360) % 360;
  return rgbToHex(hslToRgb(hsl));
}

function hexToRgb(hex) {
  const value = String(hex || "#2563eb").replace("#", "");
  const full = value.length === 3 ? value.split("").map((digit) => digit + digit).join("") : value.padEnd(6, "0").slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

function rgbToHex({r, g, b}) {
  return `#${[r, g, b].map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl({r, g, b}) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return {h: 0, s: 0, l};
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const h = max === r
    ? ((g - b) / delta + (g < b ? 6 : 0)) * 60
    : max === g
      ? ((b - r) / delta + 2) * 60
      : ((r - g) / delta + 4) * 60;
  return {h, s, l};
}

function hslToRgb({h, s, l}) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0]
    : h < 120 ? [x, chroma, 0]
      : h < 180 ? [0, chroma, x]
        : h < 240 ? [0, x, chroma]
          : h < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return {r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255};
}

function featureTitle(feature, layer) {
  const properties = feature.properties ?? {};
  const labelField = layer.labels?.field;
  return labelField && properties[labelField] !== undefined
    ? properties[labelField]
    : properties.name ?? properties.title ?? properties.site_id ?? properties.id ?? layer.title;
}

function sourceId(layer) {
  return layer.sharedSourceId
    ? `shared-${mapSafeId(layer.sharedSourceId)}-source`
    : `${layer.layerId}-source`;
}

function firstDataLayerId(map) {
  return map.getStyle().layers.find((layer) => layer.id !== "background" && layer.id !== "basemap")?.id;
}

function firstSymbolLayerId(map) {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

function toolTitle(id) {
  return PROCESSING_TOOLS.find((tool) => tool.id === id)?.title ?? id;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(0)} m`;
}

function downloadBlob(filename, content, type) {
  const artifact = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(artifact);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "layer";
}

function overlayMediaType(file) {
  const extension = String(file?.name ?? "").split(".").at(-1)?.toLowerCase();
  const inferred = extension === "png" ? "image/png"
    : ["jpg", "jpeg"].includes(extension) ? "image/jpeg"
      : extension === "gif" ? "image/gif"
        : extension === "webp" ? "image/webp" : null;
  const mediaType = String(file?.type ?? "").toLowerCase() || inferred;
  if (!inferred || mediaType !== inferred) throw Object.assign(new Error("kml_overlay_media_type_invalid"), {code: "kml_overlay_media_type_invalid"});
  return mediaType;
}

function browserBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
}

function browserBytesFromBase64(value) {
  if (typeof value !== "string") throw Object.assign(new Error("kml_network_link_body_invalid"), {code: "kml_network_link_body_invalid"});
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function uniqueKmlResourcePath(document, requested) {
  const used = new Set((document?.resources ?? []).map(({path}) => path));
  if (!used.has(requested)) return requested;
  const dot = requested.lastIndexOf(".");
  const stem = dot > 0 ? requested.slice(0, dot) : requested;
  const suffix = dot > 0 ? requested.slice(dot) : "";
  for (let index = 2; index <= KML_PLACES_LIMITS.maximumKmzResources + 1; index += 1) {
    const candidate = `${stem}-${index}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw Object.assign(new Error("kmz_resource_path_unavailable"), {code: "kmz_resource_path_unavailable"});
}

function textElement(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value ?? "";
  return element;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}


async function loadBoundLayerStyle(context, layer) {
  const {state} = context;
  state.resolvedLayerStyles.delete(layer.layerId);
  state.layerStyleErrors.delete(layer.layerId);
  removeMapLayer(state, layer.layerId);
  const request = Symbol();
  context.styleRequests ??= new Map();
  context.styleRequests.set(layer.layerId, request);
  try {
    if (layer.sourceType !== "governed-dataset") throw new Error("Referenced Styles currently require a governed dataset version");
    const resolved = await resolveLayerStyle(context.styleAdapter, layer);
    if (context.styleRequests.get(layer.layerId) !== request || !context.layers.includes(layer)) return;
    state.resolvedLayerStyles.set(layer.layerId, resolved);
    if (state.map?.isStyleLoaded()) {
      addMapLayer(state, layer, context.dataByLayerId.get(layer.layerId), context.datasets);
      syncLayerOrder(context);
    }
  } catch (error) {
    if (context.styleRequests.get(layer.layerId) !== request) return;
    state.resolvedLayerStyles.delete(layer.layerId);
    removeMapLayer(state, layer.layerId);
    state.layerStyleErrors.set(layer.layerId, "Selected Style unavailable or incompatible. Check access, dataset association and the saved version; no fallback is displayed.");
    setStatus(context, state.layerStyleErrors.get(layer.layerId));
  }
  context.render();
}
