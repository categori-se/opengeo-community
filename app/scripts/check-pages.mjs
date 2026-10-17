import {createServer} from "node:http";
import assert from "node:assert/strict";
import {existsSync, mkdirSync, statSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import {extname, join, normalize, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {fromGeojsonVt} from "@maplibre/vt-pbf";
import {strToU8, zipSync} from "fflate";
import config from "../observablehq.config.js";
import {GLOBE_TELEMETRY_LIMITS} from "../src/lib/globeTelemetry.js";
import {restoredMapViewMatches} from "../src/lib/globeInteraction.js";
import {OPEN_3D_SCENE_SOURCE} from "../src/lib/openScene3d.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {
  applyFeatureQuery,
  createSavedFeatureQueryReceipt,
  featureQuerySha256,
  normalizeFeatureQuery
} from "../src/lib/featureQuery.js";
import {GOVERNED_IDENTIFY_LIMITS} from "../src/lib/governedIdentify.js";

const kmlNetworkLinkMode = process.argv.includes("--kml-network-link")
  || process.argv.includes("--ux-002")
  || process.argv.includes("--without-ux-002")
  || process.argv.length === 2;
const geomooseQueryMode = process.argv.includes("--geomoose-query");
const screenshotsEnabled = process.env.OPEN_GEO_BROWSER_SCREENSHOTS !== "0";
const performanceGateEnabled = process.env.OPEN_GEO_BROWSER_PERFORMANCE_GATE !== "0"
  && (process.argv.includes("--ux-002")
    || process.env.OPEN_GEO_BROWSER_PERFORMANCE_GATE === "1");
const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const distRoot = process.env.OPEN_GEO_BROWSER_DIST
  ? resolve(process.env.OPEN_GEO_BROWSER_DIST)
  : resolve(appRoot, "dist");
if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  throw new Error(`Browser dist directory is unavailable: ${distRoot}`);
}
const artifactRoot = resolve(appRoot, "page-check-artifacts");
const publicLibrary = JSON.parse(
  await readFile(new URL("../src/data/public-library.json", import.meta.url), "utf8")
);
const sourceXyzFixture = JSON.parse(
  await readFile(new URL("../../parity/fixtures/source-001-xyz.json", import.meta.url), "utf8")
);
const sourceXyzTile = sourceXyzFixture.artifacts.find(({mediaType}) => mediaType === "image/png");
if (sourceXyzFixture.fixtureId !== "source-001.xyz.public-tile" || !sourceXyzTile) {
  throw new Error("The checksum-validated SOURCE-001 XYZ parity fixture is unavailable.");
}
const sourceXyzTileBytes = Buffer.from(sourceXyzTile.value, sourceXyzTile.encoding);
// Constant 100 m Terrarium RGB tile: (128 * 256 + 100) - 32768.
const terrainTileBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACvklEQVR42u3TMQEAIAzAMEArQpCOjB1NFPTpfndB1pkOgEkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDEDaBzkXAuT7wJu/AAAAAElFTkSuQmCC",
  "base64"
);
const openScene3dTileBytes = Buffer.from(fromGeojsonVt({
  building: {
    features: [{
      geometry: [[[900, 900], [3000, 900], [3000, 3000], [900, 3000], [900, 900]]],
      type: 3,
      tags: {render_height: 36, render_min_height: 0, hide_3d: false}
    }]
  },
  landcover: {
    features: [{
      geometry: [[[250, 250], [750, 250], [750, 750], [250, 750], [250, 250]]],
      type: 3,
      tags: {class: "wood", subclass: "forest"}
    }]
  }
}, {version: 2, extent: 4096}));
const kmlPlacesBrowserKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document id="browser-places"><name>Browser Places</name><open>1</open>
  <Style id="tower-style"><IconStyle><color>ff112233</color><scale>1.25</scale><Icon><href>icons/tower.png</href></Icon></IconStyle></Style>
  <StyleMap id="tower-map"><Pair><key>normal</key><styleUrl>#tower-style</styleUrl></Pair><Pair><key>highlight</key><Style><IconStyle><color>ff00ffff</color><scale>1.5</scale></IconStyle></Style></Pair></StyleMap>
  <Schema id="survey-schema" name="Survey"><SimpleField name="sampleCount" type="int"/><SimpleField name="verified" type="bool"/></Schema>
  <Folder id="field-sites"><name>Field sites</name><open>1</open>
    <Placemark id="tower"><name>Tower</name><styleUrl>#tower-map</styleUrl><LookAt><longitude>13.405</longitude><latitude>52.52</latitude><range>1200</range></LookAt><ExtendedData><Data name="status"><value>verified</value></Data><SchemaData schemaUrl="#survey-schema"><SimpleData name="sampleCount">7</SimpleData><SimpleData name="verified">true</SimpleData></SchemaData></ExtendedData><Point><altitudeMode>absolute</altitudeMode><coordinates>13.405,52.52,120</coordinates></Point></Placemark>
    <Placemark id="route"><name>Route</name><LineString><tessellate>1</tessellate><coordinates>13.4,52.5 13.41,52.51</coordinates></LineString></Placemark>
    <Placemark id="area"><name>Area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>13.4,52.5 13.5,52.5 13.5,52.6 13.4,52.5</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <GroundOverlay id="ground-overlay"><name>Ground image</name><color>afffffff</color><drawOrder>2</drawOrder><Icon><href>icons/tower.png</href></Icon><altitude>0</altitude><altitudeMode>clampToGround</altitudeMode><LatLonBox><north>52.58</north><south>52.54</south><east>13.48</east><west>13.42</west><rotation>8</rotation></LatLonBox></GroundOverlay>
    <ScreenOverlay id="screen-overlay"><name>Screen legend</name><Icon><href>icons/tower.png</href></Icon><overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/><screenXY x="16" y="16" xunits="pixels" yunits="insetPixels"/><rotationXY x="0.5" y="0.5" xunits="fraction" yunits="fraction"/><size x="32" y="32" xunits="pixels" yunits="pixels"/><rotation>0</rotation></ScreenOverlay>
    <PhotoOverlay id="photo-overlay"><name>Photo preview</name><Region><LatLonAltBox><north>52.56</north><south>52.54</south><east>13.46</east><west>13.44</west></LatLonAltBox><Lod><minLodPixels>0</minLodPixels><maxLodPixels>1</maxLodPixels></Lod></Region><Icon><href>icons/tower.png</href></Icon><rotation>0</rotation><ViewVolume><leftFov>-20</leftFov><rightFov>20</rightFov><bottomFov>-20</bottomFov><topFov>20</topFov><near>1</near></ViewVolume><ImagePyramid><tileSize>256</tileSize><maxWidth>1</maxWidth><maxHeight>1</maxHeight><gridOrigin>upperLeft</gridOrigin></ImagePyramid><Point><coordinates>13.45,52.55,40</coordinates></Point><shape>rectangle</shape></PhotoOverlay>
    <NetworkLink id="browser-network-link"><name>Browser live stations</name><visibility>1</visibility><open>0</open><refreshVisibility>0</refreshVisibility><flyToView>0</flyToView><Link><href>https://data.opengeo.tools/places/browser.kml?collection=stations</href><refreshMode>onChange</refreshMode><refreshInterval>30</refreshInterval><viewRefreshMode>onRequest</viewRefreshMode><viewRefreshTime>1</viewRefreshTime><viewBoundScale>1.25</viewBoundScale><viewFormat>BBOX=[bboxWest],[bboxSouth],[bboxEast],[bboxNorth]</viewFormat><httpQuery>client=[clientName]&amp;language=[language]</httpQuery></Link></NetworkLink>
  </Folder>
  <NetworkLink><name>Declared invalid link</name></NetworkLink>
</Document></kml>`;
const kmlPlacesBrowserIcon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const kmlPlacesBrowserBytes = Buffer.from(zipSync({
  "maps/doc.kml": strToU8(kmlPlacesBrowserKml),
  "maps/icons/tower.png": kmlPlacesBrowserIcon,
  "unreferenced/private.bin": strToU8("not extracted")
}));
const basemapTileBytes = await readFile(
  new URL("../../parity/fixtures/mapserver/mapserver-8.6.5-3857.png", import.meta.url)
);
const geolibreProjectBytes = await readFile(
  new URL("../../parity/fixtures/data/geolibre-2.6-project.geolibre.json", import.meta.url)
);
const geomooseMapbookBytes = await readFile(
  new URL("../../parity/fixtures/data/geomoose-3.15.2-mapbook.xml", import.meta.url)
);
const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  secondOrganization: "10000000-0000-4000-8000-000000000002",
  user: "20000000-0000-4000-8000-000000000001",
  member: "20000000-0000-4000-8000-000000000002",
  invitation: "70000000-0000-4000-8000-000000000001",
  clients: [
    "30000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002"
  ],
  projects: [
    "50000000-0000-4000-8000-000000000001",
    "50000000-0000-4000-8000-000000000002",
    "50000000-0000-4000-8000-000000000003"
  ],
  maps: [
    "60000000-0000-4000-8000-000000000001",
    "60000000-0000-4000-8000-000000000002",
    "60000000-0000-4000-8000-000000000003"
  ],
  createdProject: "50000000-0000-4000-8000-000000000011",
  createdMap: "60000000-0000-4000-8000-000000000011",
  savedMap: "60000000-0000-4000-8000-000000000012",
  team: "90000000-0000-4000-8000-000000000051",
  userConnection: "a0000000-0000-4000-8000-000000000051",
  connectionBinding: "a1000000-0000-4000-8000-000000000051",
  basemapConnection: "a2000000-0000-4000-8000-000000000051",
  basemapConnectionBinding: "a3000000-0000-4000-8000-000000000051",
  dataset: "80000000-0000-4000-8000-000000000001",
  geomooseQueryDataset: "80000000-0000-4000-8000-000000000041",
  odtDataset: "80000000-0000-4000-8000-000000000031",
  pdfDataset: "80000000-0000-4000-8000-000000000032",
  upload: "81000000-0000-4000-8000-000000000001",
  uploadedDataset: "82000000-0000-4000-8000-000000000001",
  sourceDataset: "83000000-0000-4000-8000-000000000001",
  regionalSourceDataset: "83000000-0000-4000-8000-000000000002",
  protectedCopyEstimate: "d0000000-0000-4000-8000-000000000051",
  protectedCopyJob: "d1000000-0000-4000-8000-000000000051",
  protectedCopyDataset: "d2000000-0000-4000-8000-000000000051",
  projectImport: "94000000-0000-4000-8000-000000000001",
  importUpload: "81000000-0000-4000-8000-000000000002",
  importEmbeddedDataset: "82000000-0000-4000-8000-000000000002",
  importObject: "84000000-0000-4000-8000-000000000002",
  importVersion: "90000000-0000-4000-8000-000000000002",
  importJob: "91000000-0000-4000-8000-000000000002",
  resource: "a0000000-0000-4000-8000-000000000001",
  mapResource: "a0000000-0000-4000-8000-000000000002",
  spatialService: "a8000000-0000-4000-8000-000000000001",
  spatialServiceMetadataVersion: "a8600000-0000-4000-8000-000000000001",
  spatialServiceStore: "a8700000-0000-4000-8000-000000000001",
  spatialBinding: "a8100000-0000-4000-8000-000000000001",
  tileCache: "a8110000-0000-4000-8000-000000000001",
  retiredTileCacheVersion: "a8120000-0000-4000-8000-000000000001",
  currentTileCacheVersion: "a8120000-0000-4000-8000-000000000002",
  tileCacheReclamation: "a8130000-0000-4000-8000-000000000001",
  tileSeedPlan: "a8140000-0000-4000-8000-000000000001",
  tileSeedRender: "a8150000-0000-4000-8000-000000000001",
  tileSeedRenderSecond: "a8160000-0000-4000-8000-000000000001",
  spatialCoverage: "a8200000-0000-4000-8000-000000000001",
  coverageDerivative: "a8300000-0000-4000-8000-000000000001",
  coverageDerivativeObject: "a8400000-0000-4000-8000-000000000001",
  coverageReclamation: "a8500000-0000-4000-8000-000000000001",
  site: "b0000000-0000-4000-8000-000000000001",
  siteVersion: "b1000000-0000-4000-8000-000000000001",
  sitePage: "b2000000-0000-4000-8000-000000000001",
  resourceVersion: "b3000000-0000-4000-8000-000000000001",
  pageDraft: "b4000000-0000-4000-8000-000000000001",
  sourceProject: "b8000000-0000-4000-8000-000000000001",
  sourceRevision: "b9000000-0000-4000-8000-000000000001",
  sourceObjectMarkdown: "ba000000-0000-4000-8000-000000000001",
  sourceObjectLock: "bb000000-0000-4000-8000-000000000001",
  observableBuild: "bc000000-0000-4000-8000-000000000001",
  sourceUploadMarkdown: "bd000000-0000-4000-8000-000000000001",
  sourceUploadLock: "be000000-0000-4000-8000-000000000001",
  renderProfile: "a4000000-0000-4000-8000-000000000001",
  renderProfileVersion: "a5000000-0000-4000-8000-000000000001",
  metadataProfile: "c0000000-0000-4000-8000-000000000001",
  importSourceDatasets: [
    "83000000-0000-4000-8000-000000000002",
    "83000000-0000-4000-8000-000000000003",
    "83000000-0000-4000-8000-000000000004"
  ],
  version: "90000000-0000-4000-8000-000000000001",
  geomooseQueryVersion: "90000000-0000-4000-8000-000000000041",
  odtVersion: "90000000-0000-4000-8000-000000000031",
  pdfVersion: "90000000-0000-4000-8000-000000000032",
  job: "91000000-0000-4000-8000-000000000001"
});

const routes = flattenPages(config.pages);
const fixtureProjectRoute = `/workspaces?project=${IDS.projects[0]}&adapter=fixture`;
const fixtureProjectQueryRoute = fixtureProjectRoute;
const screenshotRoutes = [
  "/?adapter=fixture",
  "/public-demo",
  "/library",
  "/workspaces?adapter=fixture",
  "/login?adapter=fixture",
  "/admin?adapter=fixture",
  fixtureProjectRoute,
  `${fixtureProjectRoute}&manage=data#project-data`,
  `${fixtureProjectRoute}&manage=print#project-print`
];
const screenshotArtifactNames = screenshotRoutes.map(screenshotArtifactName);
if (new Set(screenshotArtifactNames).size !== screenshotArtifactNames.length) {
  throw new Error("Screenshot routes must produce unique artifact names");
}
const BROWSER_OAUTH_STATE = "browser-oauth-state-000000000000000000000000";
const BROWSER_OAUTH_VERIFIER = "browser-oauth-verifier-0000000000000000000000000000000000000000";
let tokenExchangeRequests = 0;
const acceptedInvitationTokens = new Set();
let coverageReclamationQueued = false;
let tileCacheReclamationQueued = false;
let tileSeedPlanQueued = false;
let tileSeedPlanBbox = null;
const browserDatasets = [
  datasetPayload(),
  datasetPayload({
    id: "80000000-0000-4000-8000-000000000002",
    name: "Invalid raster upload",
    format: "cog",
    status: "failed",
    current_version_state: "failed",
    feature_count: null,
    extent: null,
    crs: null,
    geometry_type: null,
    quality_results: {
      valid: false,
      checks: [],
      warnings: [],
      errors: [{code: "cog_layout_required"}]
    },
    processing_job_state: "failed",
    processing_error_code: "cog_layout_required"
  }),
  datasetPayload({
    id: IDS.odtDataset,
    name: "Field report",
    description: "Governed OpenDocument text with an exact semantic preview.",
    format: "odt",
    current_version_id: IDS.odtVersion,
    feature_count: null,
    extent: null,
    crs: null,
    geometry_type: "document",
    tags: ["research", "document"]
  }),
  datasetPayload({
    id: IDS.pdfDataset,
    name: "Investigation PDF",
    description: "Governed PDF with an exact all-page semantic text presentation.",
    format: "pdf",
    current_version_id: IDS.pdfVersion,
    feature_count: null,
    extent: null,
    crs: null,
    geometry_type: "document",
    tags: ["research", "pdf"]
  })
];
if (geomooseQueryMode) {
  browserDatasets.push(datasetPayload({
    id: IDS.geomooseQueryDataset,
    name: "MassGIS priority habitats",
    description: "Second governed layer for the GeoMoose identify and query browser acceptance.",
    current_version_id: IDS.geomooseQueryVersion,
    current_version_number: 4,
    feature_count: 1,
    extent: [-71.18, 42.31, -71.01, 42.44],
    geometry_type: "Polygon",
    tags: ["massgis", "screening", "habitat"]
  }));
}
const browserUploads = new Map();
const browserSources = [];
const browserProjectDatasetLinks = new Map();
for (const dataset of browserDatasets) {
  projectDatasetIds(dataset.project_id).add(dataset.id);
}
const browserMapOverrides = new Map();
let browserAuthoritativeFeatureState = null;
let browserFieldForms = [];
let browserFieldSubmissions = [];
const browserGeoMooseQueryRequests = [];
let browserGeoMooseDelayedQueryResponses = 0;
let browserExpectedFeatureQueryAborts = 0;
const browserExpectedAbortedRequests = new WeakSet();
const browserResources = [
  resourceSummaryPayload(),
  resourceSummaryPayload({
    id: IDS.mapResource,
    kind: "map",
    slug: "verified-access-map",
    map_id: IDS.maps[0],
    title: "Verified access map",
    abstract: "Governed map for declarative page insertion.",
    keywords: ["map", "roads"],
    origin_namespace: null,
    origin_identifier: null,
    relationship_count: 0
  })
];
const browserPageSources = [];
const browserPageDrafts = new Map();
const browserPageDraftFingerprints = new Map();
let browserPageUpload = null;
let browserPageDetailOverrides = {};
let browserSites = [sitePayload()];
let browserObservableSourceProjects = [observableSourceProjectPayload()];
const browserObservableSourceUploads = new Map();
const browserObservableSourceRevisions = [];
const browserObservableBuilds = [];
const browserSourceRequests = [];
const browserRegionalBasemapRequests = [];
const browserPortalSourceRequests = [];
const browserTerrainRequests = [];
const browserOpenScene3dRequests = [];
let simulateTerrainOutage = false;
const browserImports = new Map();
const browserCreatedProjects = [];
const browserCreatedMaps = [];
const browserTeams = [{
  id: IDS.team,
  name: "OpenGeo research team",
  description: "Shared browser-check collaborators",
  status: "active",
  caller_role: "owner",
  created_at: "2026-08-24T12:00:00Z",
  updated_at: "2026-08-24T12:00:00Z"
}];
const browserUserConnections = [{
  connection_id: IDS.userConnection,
  owner_user_id: IDS.user,
  provider: "s3",
  display_name: "Geospatial data",
  bucket_name: "example-geodata",
  region_name: "us-east-1",
  object_prefix: "",
  credential_mode: "workload_identity",
  role_arn: null,
  configured_secret_fields: [],
  credential_revision: 0,
  target_revision: 1,
  credential_ready: true,
  status: "unverified",
  last_verified_at: null,
  sanitized_error_code: null,
  created_at: "2026-08-24T12:00:00Z",
  updated_at: "2026-08-24T12:00:00Z",
  owned_by_caller: true,
  verification_available: false,
  repository_browse_available: false
}];
const browserUserBasemapConnections = [];
const browserBasemapKeys = new Map();
const browserProjectBasemapBindings = new Map();
const browserProtomapsRequests = [];
let lastMapUpdate = null;
let lastMapCreate = null;
let importedMapDefinition = null;
let importedMapVersion = null;
let acceptedGlobeTelemetry = null;
let acceptedGlobeNavigation = null;
let acceptedTerrainGovernance = null;
let acceptedPathMeasurement = null;
let acceptedOpenScene3d = null;
let acceptedKmlPlaces = null;
let acceptedKmlNetworkLink = null;
let acceptedDataPreservation = null;
let acceptedFlightSimulation = null;
const flightBrowserRequests = {local: 0, interceptedExternal: 0, blockedUnexpected: 0};
const browserProtectedCopyEstimateRequests = [];
const browserProtectedCopyQueueRequests = [];
const browserSourceDiscoveryRequests = [];

mkdirSync(artifactRoot, {recursive: true});

const server = createServer(async (request, response) => {
  try {
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1" && request.url?.startsWith("/api/")) {
      console.log(`Browser fixture request: ${request.method} ${request.url}`);
    }
    if (await handleAuthRequest(request, response)) return;
    if (await handleApiRequest(request, response)) return;
    const filePath = routeFile(request.url);
    if (!filePath) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const mediaType = contentType(filePath);
    const contents = await readFile(filePath);
    response.writeHead(200, {"content-type": mediaType});
    response.end(mediaType.startsWith("text/html")
      ? contents.toString("utf8").replace(/<link rel="modulepreload"[^>]*>\n?/g, "")
      : contents);
  } catch (error) {
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") {
      console.error(`Browser fixture server error for ${request.method} ${request.url}:`, error);
    }
    response.writeHead(500);
    response.end(error.stack);
  }
});

await listen(server);

const baseUrl = `http://127.0.0.1:${server.address().port}`;
browserProgress(`Browser fixture server: ${baseUrl}`);
const launchBrowser = () => chromium.launch({
  headless: true,
  ...chromiumExecutable(),
  ...(process.argv.includes("--project-dataset-reuse")
    ? {
        args: ["--disable-gpu", "--disable-software-rasterizer"],
        ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"]
      }
    : process.argv.includes("--platform-states")
    ? {ignoreDefaultArgs: ["--disable-dev-shm-usage"]}
    : process.env.OPEN_GEO_BROWSER_DEBUG === "1"
    ? {dumpio: true, args: ["--enable-logging=stderr", "--v=1"]}
    : {})
});
let browser = await launchBrowser();
const failures = [];

try {
  if (process.argv.includes("--auth")) {
    await assertAuthenticationStates(browser, baseUrl);
  } else if (process.argv.includes("--studio-account")) {
    await assertStudioAccount(browser, baseUrl);
  } else if (process.argv.includes("--studio-entry")) {
    await assertStudioEntry(browser, baseUrl);
  } else if (process.argv.includes("--public-3d")) {
    await assertHostedPublic3d(browser, baseUrl);
  } else if (process.argv.includes("--camera-controls")) {
    await assertCameraNavigation(browser, baseUrl);
  } else if (process.argv.includes("--invitation-recovery")) {
    await assertInvitationRecovery(browser, baseUrl);
  } else if (process.argv.includes("--authoring-panels")) {
    await assertAuthoringAndPanels(browser, baseUrl);
    await assertMobileOrientationAndTouch(browser, baseUrl);
  } else if (process.argv.includes("--esri-basemaps")) {
    await assertEsriBasemaps(browser, baseUrl);
    await assertLandingMapViewport(browser, baseUrl);
  } else if (process.argv.includes("--kml-network-link")) {
    await assertKmlNetworkLinkPersistence(browser, baseUrl);
  } else if (process.argv.includes("--ux-002")) {
    await assertUx002Workflows(browser, baseUrl);
  } else if (process.argv.includes("--workbench-layout")) {
    await assertResponsiveShells(browser, baseUrl);
  } else if (process.argv.includes("--platform-states")) {
    await assertPlatformStates(browser, baseUrl);
  } else if (process.argv.includes("--geolibre-import")) {
    await assertGeoLibreRendererImport(browser, baseUrl);
  } else if (process.argv.includes("--project-directory")) {
    for (const colorScheme of ["dark", "light"]) {
      for (const viewport of [
        {width: 1440, height: 950},
        {width: 390, height: 844},
        {width: 844, height: 390}
      ]) {
        await withPlatformPage(
          browser,
          baseUrl,
          {
            token: null,
            colorScheme,
            viewport,
            hasTouch: viewport.width === 390,
            isMobile: viewport.width === 390
          },
          async (page) => {
            const route = "/workspaces?adapter=fixture";
            const caseLabel = `${route} ${colorScheme} ${viewport.width}x${viewport.height}`;
            await visit(page, `${baseUrl}${route}`, `${caseLabel} project-directory acceptance`);
            await page.locator('.composition-directory[data-state="ready"]').waitFor();
            await assertProjectDirectory(page, caseLabel);
          }
        );
      }
    }
  } else if (process.argv.includes("--project-applications")) {
    await assertProjectApplications(browser, baseUrl);
  } else if (process.argv.includes("--project-dataset-reuse")) {
    await assertProjectDatasetReuse(browser, baseUrl);
  } else if (process.argv.includes("--studio-start")) {
    await assertStudioStartWorkspace(browser, baseUrl);
  } else if (process.argv.includes("--basemap-governance")) {
    await assertBasemapGovernanceWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--basemap-runtime-recovery")) {
    await assertBasemapRuntimeRecovery(browser, baseUrl);
  } else if (process.argv.includes("--basemap-resource-feedback")) {
    await assertBasemapResourceFeedback(browser, baseUrl);
  } else if (process.argv.includes("--data-preservation")) {
    await assertDataPreservationWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--geomoose-query")) {
    await assertGeoMooseQueryWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--geomoose-temporary-edit")) {
    await assertGeoMooseTemporaryGeometryWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--camera-tour")) {
    await assertCameraTourWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--flight-simulator")) {
    await assertFlightSimulatorWorkflow(browser, baseUrl);
  } else if (process.argv.includes("--ux-002")) {
    await assertUx002Workflows(browser, baseUrl);
  } else {
    await checkRoutes(browser, baseUrl, routes);
    await checkScreenshots(browser, baseUrl, screenshotRoutes);
    await assertResponsiveShells(browser, baseUrl);
    await assertPlatformStates(browser, baseUrl);
    if (!process.argv.includes("--without-ux-002")) {
      // Run the advanced interaction path in a new browser when explicitly
      // included in this matrix. The canonical gate uses a separate process
      // so both server state and rendering telemetry begin clean.
      await browser.close();
      browser = await launchBrowser();
      await assertUx002Workflows(browser, baseUrl);
    }
    await assertAuthenticationStates(browser, baseUrl);
    await assertBasemapGovernanceWorkflow(browser, baseUrl);
    await assertBasemapRuntimeRecovery(browser, baseUrl);
    await assertBasemapResourceFeedback(browser, baseUrl);
  }
} finally {
  await browser.close();
  await close(server);
  if (process.argv.includes("--flight-simulator")) browserProgress("Flight browser and local fixture server closed.");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    process.argv.includes("--geolibre-import")
      ? "Checked the compiled GeoLibre inspect/import/reopen/export workflow with fixture services."
      : process.argv.includes("--flight-simulator")
      ? "Checked the compiled flight simulator workflow in dark and light at 1440×950, 390×844, and 844×390."
      : screenshotsEnabled
      ? `Checked ${routes.length} pages. Screenshots written to ${artifactRoot}.`
      : `Checked ${routes.length} pages. Screenshot capture disabled; layout and contrast assertions ran.`
  );
  if (acceptedGlobeTelemetry) console.log(`Globe telemetry: ${JSON.stringify(acceptedGlobeTelemetry)}`);
  if (acceptedGlobeNavigation) console.log(`Globe navigation: ${JSON.stringify(acceptedGlobeNavigation)}`);
  if (acceptedTerrainGovernance) console.log(`Terrain governance: ${JSON.stringify(acceptedTerrainGovernance)}`);
  if (acceptedPathMeasurement) console.log(`Saved path measurement: ${JSON.stringify(acceptedPathMeasurement)}`);
  if (acceptedOpenScene3d) console.log(`Open 3D scene: ${JSON.stringify(acceptedOpenScene3d)}`);
  if (acceptedKmlPlaces) console.log(`KML Places: ${JSON.stringify(acceptedKmlPlaces)}`);
  if (acceptedKmlNetworkLink) console.log(`KML NetworkLink: ${JSON.stringify(acceptedKmlNetworkLink)}`);
  if (acceptedDataPreservation) console.log(`Data preservation: ${JSON.stringify(acceptedDataPreservation)}`);
  if (acceptedFlightSimulation) console.log(`Flight simulator: ${JSON.stringify(acceptedFlightSimulation)}`);
}

async function assertProjectApplications(browser, baseUrl) {
  const surfaces = ["data", "resources", "services", "publishing", "print", "settings"];
  const viewports = [
    {width: 1440, height: 950},
    {width: 390, height: 844},
    {width: 844, height: 390}
  ];
  for (const colorScheme of ["dark", "light"]) {
    for (const viewport of viewports) {
      for (const surface of surfaces) {
        await withPlatformPage(browser, baseUrl, {
          token: null,
          colorScheme,
          viewport,
          hasTouch: viewport.width === 390,
          isMobile: viewport.width === 390
        }, async (page) => {
          const route = `/workspaces?project=${IDS.projects[0]}&adapter=fixture&manage=${surface}`;
          const label = `${surface} ${colorScheme} ${viewport.width}x${viewport.height}`;
          await visit(page, `${baseUrl}${route}`, `${label} project application`);
          await page.locator(`#project-${surface}`).waitFor();
          if (await page.locator(".project-management").count()) {
            failures.push(`${label}: obsolete intermediary project management disclosure remained`);
          }
          if (await page.locator(".opengeo-workbench").count()) {
            failures.push(`${label}: dedicated ${surface} page rendered a map workbench underneath it`);
          }
          const current = page.locator('.platform-project-sections [aria-current="page"]');
          if ((await current.textContent())?.trim().toLowerCase() !== surface) {
            failures.push(`${label}: project navigation did not identify the current destination`);
          }
          const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            targets: [...document.querySelectorAll(".platform-project-sections a")].map((item) => ({
              width: item.getBoundingClientRect().width,
              height: item.getBoundingClientRect().height
            }))
          }));
          if (layout.overflow > 1) failures.push(`${label}: horizontal overflow ${layout.overflow}px`);
          if (layout.targets.some(({height}) => height < 44)) {
            failures.push(`${label}: project destination exposed a target shorter than 44 pixels`);
          }
          await assertReadable(page, `${label} project application`);
        });
      }
    }
  }
}

async function checkRoutes(browser, baseUrl, routes) {
  const context = await browser.newContext({colorScheme: "dark", viewport: {width: 1440, height: 950}});
  const page = await context.newPage();
  capturePageErrors(page, "configured routes");

  for (const route of routes) {
    await visit(page, `${baseUrl}${route}`, route);
    await assertNoRuntimeError(page, route);
  }

  await context.close();
}

async function checkScreenshots(browser, baseUrl, routes) {
  for (const colorScheme of ["dark", "light"]) {
    const context = await browser.newContext({colorScheme, viewport: {width: 1440, height: 950}});
    const basemapRequests = [];
    await context.route("https://a.basemaps.cartocdn.com/**", async (route) => {
      basemapRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: basemapTileBytes,
        headers: {"cache-control": "public,max-age=86400"}
      });
    });
    const page = await context.newPage();
    capturePageErrors(page, `${colorScheme} screenshots`);

    for (const route of routes) {
      await visit(page, `${baseUrl}${route}`, route);
      await assertNoRuntimeError(page, route);
      await assertReadable(page, route);

      if (route === fixtureProjectRoute) {
        await assertMapPreview(page, route);
      }

      if (route === "/?adapter=fixture") await assertStartExperience(page, route);
      if (route === "/public-demo") {
        await assertPublicDemoHandoff(page, route);
      }
      if (route === "/library") await assertPublicLibrary(page, route);
      if (route === "/workspaces?adapter=fixture") await assertProjectDirectory(page, route);

      if (route.startsWith("/print/")) {
        await assertPrintLayout(page, route);
      }

      const name = screenshotArtifactName(route);
      if (screenshotsEnabled) {
        await page.screenshot({path: join(artifactRoot, `${name}-${colorScheme}.png`), fullPage: true});
      }

      if (route === fixtureProjectRoute) {
        await assertWorkbenchInteractions(page, route, colorScheme);
      }
    }

    await context.close();
  }
}

function screenshotArtifactName(route) {
  const parsedRoute = new URL(route, "http://localhost");
  if (parsedRoute.pathname === "/workspaces") {
    const projectId = parsedRoute.searchParams.get("project");
    const management = parsedRoute.searchParams.get("manage");
    if (projectId && management) return `project-${management}-${projectId}`;
    if (projectId) return `project-${projectId}`;
  }
  return parsedRoute.pathname.replace(/^\//, "").replaceAll("/", "-") || "index";
}

async function assertPublicDemoHandoff(page, route) {
  const body = await page.locator("body").innerText();
  if (!body.includes("OpenGeo Studio demo") || !body.includes("temporary browser-only workspace")) {
    failures.push(`${route}: demo handoff copy is missing`);
  }
  const links = await page.locator('a[href="https://demo.studio.opengeo.tools/"]').count();
  if (links !== 1) failures.push(`${route}: demo handoff does not target the isolated origin`);
  for (const forbidden of ["Sign out", "Managed dataset upload", "storage.opengeo.tools"]) {
    if (body.includes(forbidden)) failures.push(`${route}: leaked private control ${forbidden}`);
  }
}

async function visibleTargetSizes(container) {
  return container.evaluate((element) => [...element.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]):not([type="range"]), select:not([disabled]), textarea:not([disabled]), summary'
  )].flatMap((candidate) => {
    const style = getComputedStyle(candidate);
    const rectangle = candidate.getBoundingClientRect();
    if (style.display === "none"
      || style.visibility === "hidden"
      || rectangle.width === 0
      || rectangle.height === 0) return [];
    return [{
      label: candidate.getAttribute("aria-label")
        || candidate.textContent?.trim().replace(/\s+/g, " ").slice(0, 48)
        || candidate.tagName.toLowerCase(),
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height)
    }];
  }));
}

async function minimumBasemapDialogContrast(dialog) {
  return dialog.evaluate((element) => {
    const visible = (candidate) => {
      const style = getComputedStyle(candidate);
      const rectangle = candidate.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rectangle.width > 0
        && rectangle.height > 0;
    };
    const candidates = [
      element.querySelector("h2"),
      element.querySelector(".gis-basemap-dialog-header p"),
      element.querySelector(".gis-basemap-catalog-group > summary strong"),
      element.querySelector(".gis-basemap-reviewed-facts"),
      element.querySelector(".gis-basemap-dialog-feedback")
    ].filter((candidate) => candidate && visible(candidate));
    const ratios = candidates.map((candidate) => {
      const foreground = parseColor(getComputedStyle(candidate).color);
      const background = resolvedBackground(candidate);
      return contrastRatio(composite(foreground, background), background);
    });
    return ratios.length ? Math.min(...ratios) : 0;

    function parseColor(value) {
      if (!value || value === "transparent") return {r: 0, g: 0, b: 0, a: 0};
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return {r, g, b, a};
      }
      const srgb = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
      if (srgb) {
        const [, r, g, b, a = "1"] = srgb;
        return {r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a)};
      }
      return {r: 0, g: 0, b: 0, a: 1};
    }

    function resolvedBackground(candidate) {
      let background = {r: 0, g: 0, b: 0, a: 0};
      for (let current = candidate; current; current = current.parentElement) {
        background = composite(background, parseColor(getComputedStyle(current).backgroundColor));
        if (background.a >= 0.999) return background;
      }
      return composite(background, {r: 255, g: 255, b: 255, a: 1});
    }

    function composite(top, bottom) {
      const alpha = top.a + bottom.a * (1 - top.a);
      if (!alpha) return {r: 0, g: 0, b: 0, a: 0};
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha
      };
    }

    function contrastRatio(left, right) {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    }

    function luminance(color) {
      const channels = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }
  });
}

async function assertLegacyPublications(browser, baseUrl) {
  const context = await browser.newContext({colorScheme: "dark", viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  capturePageErrors(page, "preserved legacy publications");
  const items = publicLibrary?.items ?? [];
  if (items.length !== 27) failures.push(`public library: expected 27 preserved publications, found ${items.length}`);
  for (const item of items) {
    await visit(page, `${baseUrl}${item.path}`, `preserved publication ${item.path}`);
    const body = await page.locator("body").innerText();
    const expectedTitle = item.title.replace(" legacy home", "").toLocaleLowerCase();
    const documentTitle = (await page.title()).toLocaleLowerCase();
    if (!body.toLocaleLowerCase().includes(expectedTitle) && !documentTitle.includes(expectedTitle)) {
      failures.push(`${item.path}: preserved publication title is not visible`);
    }
  }
  await context.close();
}

async function assertPublicLibrary(page, route) {
  await page.locator(".public-library").waitFor();
  if (await page.locator(".public-library-card").count() !== 27) {
    failures.push(`${route}: expected all 27 preserved publication records`);
  }
  await page.getByLabel("Search the public library").fill("MapLibre");
  if (await page.locator(".public-library-card").count() !== 2) {
    failures.push(`${route}: publication search did not narrow to the two MapLibre pages`);
  }
  await page.getByLabel("Search the public library").fill("");
  await page.getByLabel("Filter publication section").selectOption("methods");
  if (await page.locator(".public-library-card").count() !== 4) {
    failures.push(`${route}: methods filter did not expose the four preserved pages`);
  }
}

async function assertResponsiveShells(browser, baseUrl) {
  const context = await browser.newContext({colorScheme: "dark", viewport: {width: 390, height: 844}});
  await context.addInitScript(() => {
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = true;
  });
  await stubResponsiveMapRequests(context);
  const page = await context.newPage();
  capturePageErrors(page, "responsive shells");

  for (const [route, selector, artifact] of [
    ["/?adapter=fixture", ".opengeo-start", "index-mobile-dark.png"],
    [fixtureProjectQueryRoute, ".opengeo-workbench", "workbench-mobile-dark.png"]
  ]) {
    await visit(page, `${baseUrl}${route}`, `${route} mobile`);
    await page.locator(selector).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) failures.push(`${route}: responsive shell overflows the 390px viewport by ${overflow}px`);
    if (route === fixtureProjectQueryRoute) {
      await page.locator(".gis-persistence-disclosure", {hasText: "fixture · memory only"}).waitFor({state: "attached"});
      await assertWorkbenchLayoutConflicts(page, route, 390);
      await assertMobileWorkbenchCommands(page, route);
      await page.getByRole("button", {name: "Polygon", exact: true}).click();
      await page.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]').waitFor();
      if (await page.locator(".opengeo-workbench.left-collapsed").count() !== 1) {
        failures.push(`${route}: starting a phone drawing did not clear the project drawer from the map`);
      }
      await assertWorkbenchLayoutConflicts(page, route, 390);
      await page.getByRole("button", {name: "Cancel drawing"}).click();
    }
    if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, artifact), fullPage: true});
  }

  for (const {width, colorScheme, route} of [
    {width: 768, colorScheme: "dark", route: fixtureProjectQueryRoute},
    {width: 1024, colorScheme: "dark", route: fixtureProjectQueryRoute},
    {width: 1178, colorScheme: "dark", route: fixtureProjectQueryRoute},
    {width: 1405, colorScheme: "dark", route: fixtureProjectQueryRoute},
    {width: 1405, colorScheme: "light", route: fixtureProjectQueryRoute}
  ]) {
    await page.setViewportSize({width, height: 900});
    const currentRoute = new URL(page.url()).pathname + new URL(page.url()).search;
    if (currentRoute !== route) await visit(page, `${baseUrl}${route}`, `${route} ${width}px ${colorScheme}`);
    await page.locator(".opengeo-workbench").waitFor();
    const currentMode = await page.locator(".opengeo-workbench").getAttribute("data-color-mode");
    if (currentMode !== colorScheme) {
      await page.getByRole("button", {name: colorScheme === "light" ? "Light" : "Dark", exact: true}).click();
    }
    await assertWorkbenchLayoutConflicts(page, route, width, colorScheme);
    if (width === 1178) {
      const fullyVisible = await page.locator('.gis-app-nav a', {hasText: "Publications"}).evaluate((link) => {
        const item = link.getBoundingClientRect(), nav = link.closest("nav").getBoundingClientRect();
        return item.width > 0 && item.left >= nav.left - 1 && item.right <= nav.right + 1;
      });
      if (!fullyVisible) failures.push(`${route}: Publications is clipped in the 1178px header`);
    }
    if (width === 1405 && colorScheme === "dark") {
      if (!await page.locator('.gis-app-nav a', {hasText: "Publications"}).isVisible()) {
        failures.push(`${route}: desktop navigation does not expose Publications`);
      }
      await page.getByRole("button", {name: "Controls", exact: true}).click();
      await page.getByRole("menuitem", {name: "Measure line", exact: true}).click();
      await page.locator('.gis-measurement-guide[data-authoring-kind="line-measurement"]').waitFor();
      await page.locator(".gis-measurement-guide").getByRole("button", {name: "Cancel", exact: true}).click();
    }
    await page.getByRole("button", {name: "Polygon", exact: true}).click();
    await page.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]').waitFor();
    await assertWorkbenchLayoutConflicts(page, route, width, colorScheme);
    await page.getByRole("button", {name: "Cancel drawing"}).click();
  }

  await context.close();
  await assertMobileOrientationAndTouch(browser, baseUrl);
}

async function assertMobileWorkbenchCommands(page, route) {
  const toolbar = page.locator(".gis-mobile-toolbar");
  const labels = await toolbar.getByRole("button").allTextContents();
  for (const expected of ["Layers", "Point", "Path", "Polygon", "Overlay", "Actions"]) {
    if (!labels.some((label) => label.trim() === expected)) {
      failures.push(`${route}: phone toolbar is missing ${expected}`);
    }
  }
  const layout = await toolbar.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll("button")].map((button) => {
      const bounds = button.getBoundingClientRect();
      return {label: button.textContent.trim(), width: bounds.width, height: bounds.height};
    });
    return {
      left: rectangle.left,
      right: rectangle.right,
      bottom: rectangle.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      buttons
    };
  });
  if (layout.left < -1 || layout.right > layout.viewportWidth + 1 || layout.bottom > layout.viewportHeight + 1) {
    failures.push(`${route}: phone toolbar escaped the viewport (${JSON.stringify(layout)})`);
  }
  for (const button of layout.buttons) {
    if (button.width < 44 || button.height < 44) {
      failures.push(`${route}: ${button.label} phone target is smaller than 44px (${button.width}×${button.height})`);
    }
  }
  if (await page.locator(".opengeo-workbench.left-collapsed.right-collapsed").count() !== 1) {
    failures.push(`${route}: phone workbench did not begin map-first with both drawers closed`);
  }

  await page.getByRole("button", {name: "Actions", exact: true}).click();
  const sheet = page.getByRole("dialog", {name: "Actions"});
  await sheet.waitFor();
  if (!await sheet.locator('.gis-mobile-command-navigation a', {hasText: "Publications"}).isVisible()) {
    failures.push(`${route}: phone navigation does not expose Publications`);
  }
  const essentialCommands = await sheet.locator(".gis-mobile-command-essentials [data-primary-command]").evaluateAll((elements) => (
    elements.map((element) => element.dataset.primaryCommand)
  ));
  const expectedEssentials = ["new-project", "open-project", "open-file", "add-data", "catalog", "save", "save-as", "temporary", "layer-up", "layer-down"];
  if (JSON.stringify(essentialCommands) !== JSON.stringify(expectedEssentials)) {
    failures.push(`${route}: phone action sheet essentials are not in the required order (${JSON.stringify(essentialCommands)})`);
  }
  const categories = await sheet.locator("[data-mobile-command-category]").evaluateAll((elements) => (
    elements.map((element) => element.dataset.mobileCommandCategory)
  ));
  for (const expected of ["project", "edit", "view", "layer", "add", "processing", "controls", "plugins", "settings", "help"]) {
    if (!categories.includes(expected)) failures.push(`${route}: phone command sheet is missing ${expected}`);
  }
  const sheetBounds = await sheet.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      left: rectangle.left,
      right: rectangle.right,
      top: rectangle.top,
      bottom: rectangle.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      overflow: element.scrollWidth - element.clientWidth
    };
  });
  if (sheetBounds.left < -1
    || sheetBounds.right > sheetBounds.viewportWidth + 1
    || sheetBounds.top < -1
    || sheetBounds.bottom > sheetBounds.viewportHeight + 1
    || sheetBounds.overflow > 1) {
    failures.push(`${route}: phone command sheet escaped or overflowed the viewport (${JSON.stringify(sheetBounds)})`);
  }
  await page.keyboard.press("Escape");
  if (await sheet.count()) failures.push(`${route}: Escape did not close the phone command sheet`);
  if (!await page.getByRole("button", {name: "Actions", exact: true}).evaluate((button) => button === document.activeElement)) {
    failures.push(`${route}: phone command sheet did not restore focus to Actions`);
  }

  await page.getByRole("button", {name: "Layers", exact: true}).click();
  await page.locator(".gis-panel-left").waitFor({state: "visible"});
  const drawer = await page.locator(".gis-panel-left").evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight};
  });
  if (drawer.left < -1 || drawer.right > drawer.viewportWidth + 1 || drawer.bottom > drawer.viewportHeight + 1) {
    failures.push(`${route}: phone project drawer escaped the viewport`);
  }
  const toolbarBounds = await toolbar.evaluate((element) => element.getBoundingClientRect().toJSON());
  const drawerToolbarOverlap = Math.min(drawer.right, toolbarBounds.right) - Math.max(drawer.left, toolbarBounds.left) > 1
    && Math.min(drawer.bottom, toolbarBounds.bottom) - Math.max(drawer.top, toolbarBounds.top) > 1;
  if (drawerToolbarOverlap) {
    failures.push(`${route}: phone project drawer overlaps the mobile toolbar`);
  }
  await page.getByRole("button", {name: "Close project contents"}).click();
  if (await page.locator(".opengeo-workbench.left-collapsed").count() !== 1) {
    failures.push(`${route}: phone project drawer close action did not return to the map`);
  }
}

async function stubResponsiveMapRequests(context) {
  await context.route("https://a.basemaps.cartocdn.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: basemapTileBytes,
      headers: {"cache-control": "public,max-age=86400"}
    });
  });
  await context.route("https://tiles.openfreemap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: basemapTileBytes,
      headers: {"cache-control": "public,max-age=86400"}
    });
  });
  await context.route("https://tiles.openfreemap.org/styles/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({version: 8, name: "OpenGeo browser fixture", sources: {}, layers: []}),
      headers: {"cache-control": "public,max-age=86400"}
    });
  });
}

async function assertMobileOrientationAndTouch(browser, baseUrl) {
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: {width: 844, height: 390},
    hasTouch: true,
    isMobile: true
  });
  await context.addInitScript(({token, organizationId}) => {
    sessionStorage.setItem("opengeo.accessToken", token);
    sessionStorage.setItem("opengeo.accessTokenExpiresAt", String(Date.now() + 3_600_000));
    sessionStorage.setItem("opengeo.organizationId", organizationId);
  }, {token: "browser.test.token", organizationId: IDS.organization});
  await stubResponsiveMapRequests(context);
  const page = await context.newPage();
  capturePageErrors(page, "mobile orientation and touch authoring");

  try {
    await visit(page, `${baseUrl}${route}`, `${route} phone landscape touch`);
    await page.locator(".opengeo-workbench").waitFor();
    await page.locator(".gis-map .maplibregl-canvas").waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());
    await assertCompactMobileFrame(page, route, "844×390 landscape");
    await assertMobileWorkbenchCommands(page, route);

    const initial = await mobileWorkbenchSnapshot(page);
    const mapCanvas = page.locator(".gis-map .maplibregl-canvas");

    await page.getByRole("button", {name: "Path", exact: true}).tap();
    let guide = page.locator('.gis-map-authoring-guide[data-authoring-kind="LineString"]');
    await guide.waitFor();
    await mapCanvas.tap({position: {x: 180, y: 70}});
    if (!/1 vertex/.test(await guide.innerText())) {
      failures.push(`${route}: touch path authoring did not retain its first vertex`);
    }

    await page.setViewportSize({width: 390, height: 844});
    await settleMobileViewport(page, 390, 844);
    await assertCompactMobileFrame(page, route, "390×844 portrait");
    guide = page.locator('.gis-map-authoring-guide[data-authoring-kind="LineString"]');
    if (!/1 vertex/.test(await guide.innerText())) {
      failures.push(`${route}: rotating to portrait discarded the unfinished path`);
    }
    await mapCanvas.tap({position: {x: 250, y: 190}});
    await guide.getByRole("button", {name: "Finish path"}).tap();
    await persistMobilePlace(page, route, "Touch path", "LineString");

    await page.getByRole("button", {name: "Point", exact: true}).tap();
    await page.locator('.gis-map-authoring-guide[data-authoring-kind="Point"]').waitFor();
    await mapCanvas.tap({position: {x: 190, y: 160}});
    await persistMobilePlace(page, route, "Touch point", "Point");

    await page.getByRole("button", {name: "Polygon", exact: true}).tap();
    guide = page.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]');
    await guide.waitFor();
    await mapCanvas.tap({position: {x: 90, y: 110}});
    await mapCanvas.tap({position: {x: 285, y: 115}});
    await page.setViewportSize({width: 844, height: 390});
    await settleMobileViewport(page, 844, 390);
    await assertCompactMobileFrame(page, route, "844×390 landscape polygon draft");
    guide = page.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]');
    if (!/2 vertices/.test(await guide.innerText())) {
      failures.push(`${route}: rotating to landscape discarded the unfinished polygon`);
    }
    await mapCanvas.tap({position: {x: 520, y: 70}});
    await guide.getByRole("button", {name: "Finish polygon"}).tap();
    const polygonPositions = await page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoData.get("kml-places").features.find(({properties}) => properties.name === "Polygon").geometry.coordinates[0].map((point) => point.join(",")));
    if (polygonPositions.length !== 4 || polygonPositions[0] !== polygonPositions.at(-1)) {
      failures.push(`${route}: touch polygon completion did not close its three-vertex ring`);
    }
    await persistMobilePlace(page, route, "Touch polygon", "Polygon");

    const overlayChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", {name: "Overlay", exact: true}).tap();
    await (await overlayChooser).setFiles({name: "Touch overlay.png", mimeType: "image/png", buffer: kmlPlacesBrowserIcon});
    const imageEditor = page.locator(".gis-image-overlay-editor");
    await imageEditor.waitFor();
    const overlayBeforeRotation = await page.locator(".opengeo-workbench").evaluate((shell) => Object.values(shell.__opengeoMap.getStyle().sources).filter(({type}) => type === "image").map(({coordinates}) => coordinates));
    await page.setViewportSize({width: 390, height: 844});
    await settleMobileViewport(page, 390, 844);
    await assertCompactMobileFrame(page, route, "390×844 portrait overlay draft");
    const overlayAfterRotation = await page.locator(".opengeo-workbench").evaluate((shell) => Object.values(shell.__opengeoMap.getStyle().sources).filter(({type}) => type === "image").map(({coordinates}) => coordinates));
    if (JSON.stringify(overlayBeforeRotation) !== JSON.stringify(overlayAfterRotation)) failures.push(`${route}: orientation changed image coordinates`);
    await imageEditor.getByLabel("Keep proportions").check();
    await imageEditor.getByRole("button", {name: "Done", exact: true}).tap();

    await page.setViewportSize({width: 844, height: 390});
    await settleMobileViewport(page, 844, 390);
    await assertCompactMobileFrame(page, route, "844×390 landscape after authoring");

    const final = await mobileWorkbenchSnapshot(page);
    if (final.workspace !== initial.workspace || final.styleName !== initial.styleName) {
      failures.push(`${route}: orientation changes replaced the active project or basemap (${JSON.stringify({initial, final})})`);
    }
    if (!mobileCameraMatches(initial, final)) {
      failures.push(`${route}: orientation changes moved the saved map view (${JSON.stringify({initial, final})})`);
    }

    lastMapUpdate = null;
    await page.locator(".gis-save-command").tap();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const savedPlaces = kmlEntrySummaries(lastMapUpdate?.definition?.kmlPlaces);
    for (const expected of [
      {name: "Touch path", geometryType: "LineString"},
      {name: "Touch point", geometryType: "Point"},
      {name: "Touch polygon", geometryType: "Polygon"},
      {name: "Touch overlay", kind: "ground-overlay"}
    ]) {
      if (!savedPlaces.some((entry) => Object.entries(expected).every(([key, value]) => entry[key] === value))) {
        failures.push(`${route}: mobile Save omitted ${JSON.stringify(expected)} (${JSON.stringify(savedPlaces)})`);
      }
    }

    await page.reload({waitUntil: "load"});
    await page.locator(".opengeo-workbench").waitFor();
    await page.locator(".gis-map .maplibregl-canvas").waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());
    await settleMobileViewport(page, 844, 390);
    await assertCompactMobileFrame(page, route, "844×390 restored project");
    const restored = await mobileWorkbenchSnapshot(page);
    if (restored.workspace !== final.workspace
      || restored.styleName !== final.styleName
      || !mobileCameraMatches(final, restored)) {
      failures.push(`${route}: mobile save/reload did not restore project, basemap, or full camera (${JSON.stringify({final, restored})})`);
    }
    await page.getByRole("button", {name: "Layers", exact: true}).tap();
    await page.locator(".gis-kml-contents > summary").tap();
    const expectedPlacemarks = savedPlaces.filter(({kind}) => kind === "placemark").length;
    const expectedOverlays = savedPlaces.filter(({kind}) => kind.endsWith("-overlay")).length;
    await page.locator(`.gis-kml-layer-editor[data-placemarks="${expectedPlacemarks}"][data-overlays="${expectedOverlays}"]`).waitFor();
    for (const name of ["Touch path", "Touch point", "Touch polygon", "Touch overlay"]) {
      await page.getByRole("button", {name: `Edit ${name}`, exact: true}).waitFor();
    }
  } finally {
    await context.close();
  }
}

async function checkDirectImageOverlay(page, route) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", {name: "Image overlay", exact: true}).click();
  await (await chooser).setFiles({name: "Direct overlay.png", mimeType: "image/png", buffer: kmlPlacesBrowserIcon});
  const editor = page.locator(".gis-image-overlay-editor");
  await editor.waitFor();
  const source = () => page.locator(".opengeo-workbench").evaluate((shell) => Object.values(shell.__opengeoMap.getStyle().sources).filter(({type}) => type === "image").at(-1)?.coordinates);
  const initial = await source();
  await editor.locator('[data-overlay-handle="se"]').press("Shift+ArrowRight");
  await editor.locator('[data-overlay-handle="rotate"]').press("ArrowRight");
  if (JSON.stringify(initial) === JSON.stringify(await source())) failures.push(`${route}: overlay handles did not update geometry`);
  await editor.getByLabel("Image opacity", {exact: true}).fill("50");
  await editor.getByLabel("Image opacity", {exact: true}).dispatchEvent("change");
  if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "image-overlay-editing.png")});
  browserProgress(`Overlay toolbar: ${JSON.stringify(await editor.getByRole("button", {name: "Done", exact: true}).evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {rect: rect.toJSON(), hit: hit?.className, map: button.closest(".gis-map")?.getBoundingClientRect().toJSON()};
  }))}`);
  await editor.getByRole("button", {name: "Done", exact: true}).click();
}

async function assertEsriBasemaps(browser, baseUrl) {
  for (const viewport of [{width: 1440, height: 950}, {width: 390, height: 844}]) {
    await withPlatformPage(browser, baseUrl, {token: "browser.test.token", viewport}, async (page) => {
      await stubResponsiveMapRequests(page.context());
      const requests = [];
      for (const host of ["services.arcgisonline.com", "ibasemaps-api.arcgis.com", "static-map-tiles-api.arcgis.com"]) {
        await page.context().route(`https://${host}/**`, async (route) => {
          requests.push({url: route.request().url(), authorization: route.request().headers().authorization});
          await route.fulfill({status: 200, contentType: "image/png", body: basemapTileBytes});
        });
      }
      await visit(page, `${baseUrl}/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`, "Esri basemaps");
      await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
      if (viewport.width < 500) await page.getByRole("button", {name: "Layers", exact: true}).click();
      await page.locator(".gis-basemap-tree-row > button").click();
      const imageryGroup = page.locator('[data-catalog-group="key-free-imagery"]');
      if (!await imageryGroup.locator('[data-catalog-id="esri-imagery-options"]').count()) failures.push("Esri is not grouped with imagery");
      const facts = imageryGroup.locator('.gis-basemap-reviewed-facts').first();
      if (await facts.evaluate(node => getComputedStyle(node).gridColumnStart) !== "2") failures.push("Basemap facts still occupy the icon column");
      if (await page.locator('[data-catalog-group="open-terrain"]').evaluate(node => node.open)) failures.push("Optional terrain should start collapsed");
      const bright = page.locator('[data-catalog-id="openfreemap-bright"]');
      await bright.scrollIntoViewIfNeeded();
      const beforeScroll = await page.locator(".gis-basemap-dialog-body").evaluate(node => node.scrollTop);
      await bright.click();
      await page.locator('[data-catalog-id="openfreemap-bright"][aria-pressed="true"]').waitFor();
      const afterScroll = await page.locator(".gis-basemap-dialog-body").evaluate(node => node.scrollTop);
      if (Math.abs(beforeScroll - afterScroll) > 20) failures.push("Basemap selection lost the chooser's scroll position");
      const panel = page.locator(".gis-esri-basemaps");
      await panel.locator("summary").click();
      await panel.getByRole("checkbox").check();
      await panel.getByRole("button", {name: "Use Esri basemap", exact: true}).click();
      await page.waitForFunction(() => Object.values(document.querySelector(".opengeo-workbench").__opengeoMap.getStyle().sources).some((source) => source.tiles?.some((url) => url.includes("services.arcgisonline.com"))));
      if (!requests.length || requests.some(({authorization}) => authorization)) failures.push("Public Esri imagery did not load anonymously");
      // Selection must preserve the open configuration and its consent through renderer feedback.
      if (!await panel.evaluate((element) => element.open)) failures.push("Basemap activation discarded the open Esri configuration");
      await panel.getByLabel("Esri basemap", {exact: true}).selectOption("navigation");
      await panel.getByRole("checkbox").check();
      await panel.getByLabel("ArcGIS browser API key", {exact: true}).fill("browser-fixture-not-a-real-esri-key");
      if (await panel.getByRole("button", {name: "Use Esri basemap", exact: true}).isDisabled()) {
        throw new Error(`Esri configuration unexpectedly disabled: ${JSON.stringify(await panel.evaluate((element) => ({selected: element.querySelector("select").value, consent: element.querySelector('[type="checkbox"]').checked, keyLength: element.querySelector('[type="password"]').value.length, status: element.querySelector('[role="status"]').textContent})))}`);
      }
      await panel.getByRole("button", {name: "Use Esri basemap", exact: true}).click();
      await page.waitForFunction(() => Object.values(document.querySelector(".opengeo-workbench").__opengeoMap.getStyle().sources).some((source) => source.tiles?.some((url) => url.includes("static-map-tiles-api.arcgis.com"))));
      const keyed = requests.filter(({url}) => url.includes("static-map-tiles-api.arcgis.com"));
      if (!keyed.length || keyed.some(({authorization}) => authorization !== "Bearer browser-fixture-not-a-real-esri-key")) failures.push("Esri browser key was not attached to the supported tile route");
      const state = await page.locator(".opengeo-workbench").evaluate((shell) => JSON.stringify({style: shell.__opengeoMap.getStyle(), storage: {...localStorage}}));
      if (state.includes("browser-fixture-not-a-real-esri-key")) failures.push("Esri key leaked into map style or browser storage");
      if (requests.some(({url}) => url.includes("browser-fixture-not-a-real-esri-key"))) failures.push("Esri key leaked into a request URL");
      if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, `esri-basemaps-${viewport.width}.png`)});
      await page.getByRole("button", {name: "Explore imagery by date", exact: true}).click();
      await page.locator(".gis-history-panel").waitFor();
      if (await page.locator(".gis-basemap-dialog").count()) failures.push("Imagery history left the chooser in front of the map");
      if (viewport.width > 500) await assertMapJourney(page);
    });
  }
}

async function assertMapJourney(page) {
  await page.getByRole("button", {name: "Collapse inspector", exact: true}).click();
  await page.locator('.gis-menubar [data-menu="plugins"] > button').click();
  await page.getByRole("menuitem", {name: "Open imagery history", exact: true}).click();
  await page.locator(".gis-history-panel").waitFor();
  await page.getByRole("button", {name: "Collapse inspector", exact: true}).click();
  await page.getByRole("button", {name: "Hide quick tools", exact: true}).click();
  if (!await page.locator(".gis-primary-toolbar").isHidden()) failures.push("Quick toolbar did not collapse");
  await page.locator('.gis-menubar [data-menu="project"] > button').click();
  for (const label of ["Metadata, citations and saved styles", "Manage map services", "Stories and site publishing", "Open Print Studio"]) {
    if (!await page.getByRole("menuitem", {name: label, exact: true}).isVisible()) failures.push(`Missing management entry: ${label}`);
  }
  await page.locator('.gis-menubar [data-menu="project"] > button').click();
  await page.locator(".opengeo-workbench").evaluate(shell => shell.__opengeoMap.jumpTo({center: [-71.095, 42.305], zoom: 14}));
  await page.getByRole("button", {name: "Show graticule", exact: true}).click();
  await page.waitForFunction(() => document.querySelector(".opengeo-workbench").__opengeoMap.queryRenderedFeatures({layers: ["opengeo-graticule-lines"]}).length > 0);
  const details = page.locator(".gis-status-details");
  await details.locator("summary").click();
  await page.locator(".opengeo-workbench").evaluate(shell => shell.__opengeoMap.fire("mousemove", {lngLat: {lng: -71.095, lat: 42.305}}));
  if (!await details.evaluate(node => node.open)) failures.push("Pointer movement closed map details");
  if (!await page.locator('[data-status-field="zoom"]').innerText().then(value => value.includes("14.00"))) failures.push("Status zoom did not follow the view");
  await details.locator("summary").click();
  const frame = await page.locator(".opengeo-workbench").evaluate(shell => ({
    top: shell.querySelector(".gis-topbar").getBoundingClientRect().top,
    bottom: shell.querySelector(".gis-statusbar").getBoundingClientRect().bottom,
    viewport: window.innerHeight,
    layout: [shell.parentElement, shell, shell.querySelector('.gis-map-column'), shell.querySelector('.gis-statusbar')].map(node => ({className: node.className, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, height: getComputedStyle(node).height, margin: getComputedStyle(node).margin, padding: getComputedStyle(node).padding, rows: getComputedStyle(node).gridTemplateRows}))
  }));
  if (frame.top < 0 || frame.bottom > frame.viewport + 1) failures.push(`Map menus and status should fit together in the viewport: ${JSON.stringify(frame)}`);
  if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "map-journey-compact.png")});
  await page.getByRole("button", {name: "Show quick tools", exact: true}).click();
  await page.locator('.gis-menubar [data-menu="project"] > button').click();
  await page.getByRole("menuitem", {name: "Open Print Studio", exact: true}).click();
  await page.locator(".project-print-studio").waitFor();
  if (new URL(page.url()).searchParams.get("project") !== IDS.projects[0]) failures.push("Print Studio navigation lost the project context");
}

async function assertLandingMapViewport(browser, baseUrl) {
  for (const viewport of [{width: 1440, height: 950}, {width: 390, height: 844}]) {
    await withPlatformPage(browser, baseUrl, {token: null, viewport}, async page => {
      await stubResponsiveMapRequests(page.context());
      await visit(page, `${baseUrl}/`, "landing map viewport");
      await page.getByRole("button", {name: "Close start panel and use an empty map"}).click();
      const frame = await page.locator(".opengeo-workbench").evaluate(shell => ({
        top: shell.querySelector(".gis-topbar").getBoundingClientRect().top,
        bottom: shell.querySelector(".gis-statusbar").getBoundingClientRect().bottom,
        viewport: innerHeight
      }));
      if (frame.top < -1 || frame.bottom > frame.viewport + 1) failures.push(`Landing map should fit its viewport: ${JSON.stringify(frame)}`);
    });
  }
}

async function assertStudioEntry(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: null, viewport: {width: 900, height: 780}}, async page => {
    await stubResponsiveMapRequests(page.context());
    await visit(page, `${baseUrl}/`, "Studio entry");
    await page.getByRole("button", {name: "Close start panel and use an empty map"}).click();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    if (await page.locator(".start-map-overlay").isVisible()) throw Error("Dismissed welcome returned on refresh");
    await page.getByRole("button", {name: "Sign in", exact: true}).click();
    await page.waitForURL(/\/oauth2\/authorize\?/);
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes("studio-start-map")));
    if (stored.length) throw Error("Unchanged sign-in wrote a browser draft");
  });
  await withPlatformPage(browser, baseUrl, {token: null, viewport: {width: 390, height: 844}}, async page => {
    await stubResponsiveMapRequests(page.context());
    await visit(page, `${baseUrl}/`, "Changed browser draft");
    await page.getByRole("button", {name: "Close start panel and use an empty map"}).click();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await page.locator(".opengeo-workbench").evaluate(n => n.__opengeoMap.jumpTo({center: [13, 52], zoom: 5}));
    await page.getByRole("button", {name: "Sign in", exact: true}).click();
    const dialog = page.locator(".gis-account-dialog");
    await dialog.waitFor();
    const dimensions = await dialog.evaluate(n => ({width: n.clientWidth, scroll: n.scrollWidth, right: n.getBoundingClientRect().right, viewport: innerWidth}));
    if (dimensions.scroll > dimensions.width + 1 || dimensions.right > dimensions.viewport) throw Error(`Account dialog overflows: ${JSON.stringify(dimensions)}`);
    if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "account-dialog-wrapped.png")});
    await page.getByRole("button", {name: "Stay on map", exact: true}).click();
    await page.getByRole("button", {name: "Save in browser", exact: true}).click();
    const saved = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.includes("studio-start-map"));
      return {key, draft: JSON.parse(localStorage.getItem(key))};
    });
    if (saved.draft.demoDate || saved.draft.persistence.mode !== "browser-draft") throw Error("Personal map inherited demo expiry");
    await page.reload();
    await page.waitForFunction(() => Math.abs(document.querySelector(".opengeo-workbench")?.__opengeoMap?.getCenter().lng - 13) < 0.01);
    await page.setViewportSize({width: 1100, height: 844});
    await page.getByRole("link", {name: "Catalog", exact: true}).click();
    await page.locator(".instance-catalog").waitFor();
    if (await page.locator(".opengeo-workbench").count()) throw Error("Catalog stayed inside the map");
    if ((await page.locator(".instance-catalog").innerText()).includes("MassGIS")) throw Error("Personal catalog included public demo fixtures");
  });
  browserProgress("Studio entry: direct sign-in, changed-map safeguard, wrapped dialog, refresh preference, retained browser draft and full-page empty catalog passed.");
}

async function assertHostedPublic3d(browser, baseUrl) {
  // Browser-only interception serves the candidate at a real non-local origin.
  // It does not write to or inspect the deployed Studio account.
  const origin = "https://studio.opengeo.tools";
  const context = await browser.newContext({viewport: {width: 1440, height: 950}});
  context.setDefaultTimeout(20_000);
  await context.addInitScript(now => {Date.now = () => now;}, Date.parse(OPEN_3D_SCENE_SOURCE.observedAt) + 30 * 86400000);
  await context.route(`${origin}/**`, async route => {
    const source = new URL(route.request().url());
    const response = await fetch(`${baseUrl}${source.pathname}${source.search}`);
    const headers = Object.fromEntries(response.headers);
    delete headers["content-length"];
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    await route.fulfill({status: response.status, headers, body: Buffer.from(await response.arrayBuffer())});
  });
  await stubResponsiveMapRequests(context);
  const page = await context.newPage();
  const terrainPng = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "rgb(128, 100, 0)";
    paint.fillRect(0, 0, 512, 512);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  const requests = [];
  for (const [pattern, contentType, body] of [
    ["https://tiles.mapterhorn.com/**", "image/png", terrainPng],
    ["https://tiles.openfreemap.org/planet/**", "application/vnd.mapbox-vector-tile", openScene3dTileBytes]
  ]) await context.route(pattern, async route => {
    requests.push({url: route.request().url(), headers: route.request().headers()});
    await route.fulfill({status: 200, contentType, headers: {"access-control-allow-origin": "*"}, body});
  });
  try {
    await page.goto(origin);
    await page.getByRole("button", {name: "Close start panel and use an empty map"}).click();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await page.locator(".opengeo-workbench").evaluate(n => {
      n.__sourceErrors = [];
      n.__opengeoMap.on("error", e => n.__sourceErrors.push({source: e.sourceId, message: e.error?.message}));
    });
    const globe = page.locator('[data-map-mode="globe"]');
    if (await globe.getAttribute("aria-pressed") !== "true") await globe.click();
    await page.locator(".opengeo-workbench").evaluate(n => n.__opengeoMap.jumpTo({center: [13.42, 52.51], zoom: 14, pitch: 50}));
    await page.getByRole("button", {name: "Enable 3D terrain", exact: true}).click();
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    await page.locator('[data-terrain="enabled"][data-open-scene3d="enabled"][data-terrain-governance="source-review-due"][data-open-scene3d-governance="source-review-due"]').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.opengeo-workbench').__opengeoMap.querySourceFeatures('opengeo-openfreemap-3d', {sourceLayer: 'building'}).length > 0);
    if (!requests.some(r => r.url.includes("tiles.mapterhorn.com")) || !requests.some(r => r.url.includes(OPEN_3D_SCENE_SOURCE.snapshotVersion))) throw Error("Hosted 3D did not request both public sources");
    if (requests.some(r => r.headers.authorization || r.headers.cookie)) throw Error("Public source received credentials");
    await page.locator(".opengeo-workbench").evaluate(n => {
      for (let i = 0; i < 3; i++) n.__opengeoMap.fire("error", {sourceId: "opengeo-openfreemap-3d", error: new Error("fixture provider failure")});
    });
    await page.locator('[data-open-scene3d="disabled"][data-open-scene3d-outage="open"][data-terrain="enabled"]').first().waitFor();
    const count = requests.length;
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    if (requests.length !== count) throw Error("Buildings retried during cooldown");
    await page.evaluate(() => { const now = Date.now() + 61_000; Date.now = () => now; });
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    await page.locator('[data-open-scene3d="enabled"][data-terrain="enabled"]').first().waitFor();
    if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "hosted-public-3d.png")});
    browserProgress("Hosted-origin 3D: public sources, 30-day-old checks, credential omission and building-outage recovery passed.");
  } catch (error) {
    const state = await page.locator(".opengeo-workbench").evaluate(n => ({...n.dataset, sourceErrors: n.__sourceErrors})).catch(() => ({}));
    throw new Error(`${error.message}; hosted 3D state: ${JSON.stringify(state)}`);
  } finally {await context.close();}
}

async function assertCameraNavigation(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: "browser.test.token", clockNow: OPEN_3D_SCENE_SOURCE.observedAt}, async page => {
    await stubResponsiveMapRequests(page.context());
    await visit(page, `${baseUrl}/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`, "camera navigation");
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    const camera = () => page.locator(".opengeo-workbench").evaluate(node => {
      const map = node.__opengeoMap;
      return {bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom()};
    });
    const before = await camera();
    if (await page.locator(".gis-camera-controls button").count() !== 1) throw Error("Camera should have only one reset button");
    const ring = page.getByRole("slider", {name: "Map heading", exact: true});
    const rim = await ring.boundingBox();
    await page.mouse.move(rim.x + rim.width / 2, rim.y + 4);
    await page.mouse.down();
    await page.mouse.move(rim.x + rim.width - 4, rim.y + rim.height / 2, {steps: 12});
    await page.mouse.up();
    if (Math.abs((await camera()).bearing - before.bearing) < 30) throw Error("Compass rim did not rotate the map");
    if (Math.abs((await camera()).zoom - before.zoom) > 0.001) throw Error("Compass drag changed zoom");
    await ring.press("Home");
    await page.waitForFunction(() => Math.abs(document.querySelector(".opengeo-workbench").__opengeoMap.getBearing()) < 0.1);
    const box = await page.locator(".gis-map").boundingBox();
    for (const modifier of ["right", "control"]) {
      const beforeDrag = await camera();
      browserProgress(`Camera ${modifier} drag starts at ${JSON.stringify(beforeDrag)}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      if (modifier === "control") await page.keyboard.down("Control");
      await page.mouse.down({button: modifier === "right" ? "right" : "left"});
      await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 45, {steps: 10});
      await page.mouse.up({button: modifier === "right" ? "right" : "left"});
      if (modifier === "control") await page.keyboard.up("Control");
      await page.waitForFunction(start => Math.abs(document.querySelector(".opengeo-workbench").__opengeoMap.getBearing() - start) > 2, beforeDrag.bearing);
    }
    await page.getByRole("button", {name: "Show graticule", exact: true}).click();
    const themes = [];
    for (const mode of ["light", "dark"]) {
      await page.locator(".opengeo-workbench").evaluate((node, mode) => { node.dataset.colorMode = mode; }, mode);
      const theme = await page.locator(".gis-map-control-stack").evaluate(stack => {
        const paint = node => ({background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color, border: getComputedStyle(node).borderColor, opacity: getComputedStyle(node).opacity});
        const token = (background, color) => {const probe = document.createElement("span"); probe.style.backgroundColor = `var(${background})`; probe.style.color = `var(${color})`; stack.append(probe); const value = paint(probe); probe.remove(); return value;};
        const normal = paint(stack.querySelector('[aria-label="Zoom in"]'));
        const selected = paint(stack.querySelector('[data-map-mode="graticule"]'));
        const disabled = stack.querySelector('.gis-icon-button:disabled');
        return {normal, selected, disabled: disabled ? paint(disabled) : null, expectedNormal: token("--gis-elevated", "--gis-ink"), expectedSelected: token("--gis-blue-soft", "--gis-ink"), expectedDisabled: token("--gis-panel-strong", "--gis-muted")};
      });
      for (const key of ["normal", "selected", "disabled"]) {
        if (!theme[key]) continue;
        const expected = theme[`expected${key[0].toUpperCase()}${key.slice(1)}`];
        if (theme[key].background !== expected.background || theme[key].color !== expected.color || theme[key].opacity !== "1") throw Error(`${mode} ${key} map control does not follow the workbench theme`);
      }
      themes.push(theme);
      if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, `camera-navigation-${mode}.png`)});
    }
    if (themes[0].normal.background === themes[1].normal.background) throw Error("Map controls did not change with the theme");
    const sourceRequests = [];
    for (const [pattern, contentType, body] of [
      ["https://tiles.mapterhorn.com/**", "image/webp", terrainTileBytes],
      ["https://tiles.openfreemap.org/planet/**", "application/vnd.mapbox-vector-tile", openScene3dTileBytes]
    ]) {
      await page.context().route(pattern, async route => {
        sourceRequests.push({url: route.request().url(), headers: route.request().headers()});
        await route.fulfill({status: 200, contentType, body});
      });
    }
    const globe = page.locator('[data-map-mode="globe"]');
    if (await globe.getAttribute("aria-pressed") !== "true") await globe.click();
    await page.locator(".opengeo-workbench").evaluate(n => n.__opengeoMap.jumpTo({center: [13.42, 52.51], zoom: 14, pitch: 50}));
    await page.getByRole("button", {name: "Enable 3D terrain", exact: true}).click();
    await page.locator('.opengeo-workbench[data-terrain="enabled"][data-terrain-governance="fresh-upstream"]').waitFor();
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    await page.locator('.opengeo-workbench[data-open-scene3d="enabled"][data-open-scene3d-governance="fresh-upstream"]').waitFor();
    await page.waitForFunction(() => document.querySelector('.opengeo-workbench').__opengeoMap.querySourceFeatures('opengeo-openfreemap-3d', {sourceLayer: 'building'}).length > 0);
    if (!sourceRequests.some(r => r.url.includes("tiles.mapterhorn.com")) || !sourceRequests.some(r => r.url.includes(OPEN_3D_SCENE_SOURCE.snapshotVersion))) throw Error("Fresh 3D controls did not request their reviewed sources");
    if (sourceRequests.some(r => r.headers.authorization || r.headers.cookie)) throw Error("3D sources received application credentials");
  });
}

async function assertAuthoringAndPanels(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    await stubResponsiveMapRequests(page.context());
    const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    await visit(page, `${baseUrl}${route}`, "drawing and panels");
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await page.getByLabel("Viewing tilt in degrees", {exact: true}).fill("10");
    await page.getByLabel("Viewing tilt in degrees", {exact: true}).dispatchEvent("input");
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench").__opengeoMap.getPitch() >= 9);
    await page.getByRole("slider", {name: "Map heading", exact: true}).press("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench").__opengeoMap.getBearing() >= 4);
    await page.getByLabel("Viewing tilt in degrees", {exact: true}).fill("35");
    await page.getByLabel("Viewing tilt in degrees", {exact: true}).dispatchEvent("input");
    await page.waitForFunction(() => Math.abs(document.querySelector(".opengeo-workbench").__opengeoMap.getPitch() - 35) < 1);
    await page.getByRole("button", {name: "Reset north and tilt", exact: true}).click();
    await page.waitForFunction(() => {
      const map = document.querySelector(".opengeo-workbench").__opengeoMap;
      return Math.abs(map.getPitch()) < 0.1 && Math.abs(map.getBearing()) < 0.1;
    });
    const gridToggle = page.locator('[data-map-mode="graticule"]');
    const gridColor = await gridToggle.evaluate(node => getComputedStyle(node).backgroundColor);
    const gridState = await gridToggle.getAttribute("aria-pressed");
    await gridToggle.click();
    if (await gridToggle.getAttribute("aria-pressed") === gridState
      || await gridToggle.evaluate(node => getComputedStyle(node).backgroundColor) === gridColor) failures.push("Map toggle did not change its visible and accessible state");
    await gridToggle.click();
    const panel = page.locator(".gis-panel-left");
    const grip = page.getByRole("separator", {name: "Resize layers panel"});
    const beforeWidth = (await panel.boundingBox()).width;
    await grip.press("ArrowRight");
    if ((await panel.boundingBox()).width <= beforeWidth) failures.push("Layers panel keyboard resizing did not widen the panel");
    const position = await grip.boundingBox();
    await page.mouse.move(position.x + 5, position.y + 100);
    await page.mouse.down();
    await page.mouse.move(position.x + 55, position.y + 100, {steps: 5});
    await page.mouse.up();
    if ((await panel.boundingBox()).width < beforeWidth + 40) failures.push("Layers panel drag resizing failed");
    await page.getByRole("button", {name: "Close project contents", exact: true}).click();
    await page.getByRole("button", {name: "Open layers panel", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="controls"] > button').click();
    await page.getByRole("menuitem", {name: "Imagery history", exact: true}).click();
    const history = page.locator(".gis-history-panel");
    if (await history.getAttribute("data-imagery-active") !== "false" || !(await history.innerText()).includes("No historical imagery is active")) failures.push("History confused selected MODIS with active imagery");
    const inspector = page.locator(".gis-panel-right");
    const oldWidth = (await inspector.boundingBox()).width;
    await page.getByRole("separator", {name: "Resize inspector panel"}).press("ArrowLeft");
    if ((await inspector.boundingBox()).width <= oldWidth) failures.push("Inspector keyboard resizing failed");
    await page.getByRole("button", {name: "Collapse inspector", exact: true}).click();
    await page.getByRole("button", {name: "Open inspector panel", exact: true}).click();
    await page.getByRole("button", {name: "Polygon", exact: true}).click();
    const canvas = page.locator(".gis-map .maplibregl-canvas");
    await canvas.click({position: {x: 100, y: 180}});
    await canvas.click({position: {x: 300, y: 180}});
    await canvas.hover({position: {x: 240, y: 280}});
    const rubber = await page.locator(".opengeo-workbench").evaluate(async (shell) => (await shell.__opengeoMap.getSource("opengeo-authoring-source").getData()).features.find(({geometry}) => geometry.type === "LineString").geometry.coordinates);
    if (rubber.length !== 3) failures.push("Polygon rubber-band preview is missing");
    await canvas.click({position: {x: 240, y: 280}});
    await canvas.hover({position: {x: 101, y: 181}});
    if (await canvas.evaluate((element) => element.style.cursor) !== "pointer") failures.push("Polygon completion cursor is missing");
    await canvas.click({position: {x: 100, y: 180}});
    const geometry = () => page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoData.get("kml-places").features.find(({properties}) => properties.name === "Polygon")?.geometry);
    const original = await geometry();
    if (original?.coordinates[0].length !== 4) throw new Error("Finishing did not immediately retain the polygon");
    const metadata = page.locator(".gis-places-editor[open]");
    await metadata.locator('[data-kml-editing-field="name"]').fill("Field boundary");
    await metadata.getByLabel("Description", {exact: true}).fill("Keep this field note while adjusting corners.");
    await metadata.getByRole("button", {name: "Edit shape on map"}).click();
    await page.getByRole("button", {name: "Part 1 vertex 1", exact: true}).press("ArrowRight");
    if (JSON.stringify(original) === JSON.stringify(await geometry())) failures.push("Vertex editing did not change the shape");
    if (await metadata.locator('[data-kml-editing-field="name"]').inputValue() !== "Field boundary") failures.push("Vertex editing discarded draft metadata");
    if (await metadata.getByLabel("Description", {exact: true}).inputValue() !== "Keep this field note while adjusting corners.") failures.push("Vertex editing discarded the description");
    await page.getByRole("button", {name: "Finish shape editing"}).click();
    await page.getByRole("button", {name: "Close project contents", exact: true}).click();
    if (!(await geometry())) failures.push("Closing metadata discarded the shape");
    await checkDirectImageOverlay(page, route);
    if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "authoring-panels-desktop.png")});
  });
}

async function persistMobilePlace(page, route, name, expectedKind) {
  const kind = await page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoData.get("kml-places").features.at(-1).geometry.type);
  if (kind !== expectedKind) {
    failures.push(`${route}: touch ${expectedKind} completion opened ${kind || "no"} details`);
  }
  if (await page.locator(".opengeo-workbench.left-collapsed").count()) await page.getByRole("button", {name: "Layers", exact: true}).tap();
  const beforeHeight = (await page.locator(".gis-panel-left").boundingBox()).height;
  const mobileGrip = page.getByRole("separator", {name: "Resize layers panel"});
  await mobileGrip.press("ArrowDown");
  if ((await page.locator(".gis-panel-left").boundingBox()).height > beforeHeight) failures.push(`${route}: mobile panel resized in the wrong direction`);
  const authoring = page.locator(".gis-places-editor[open]");
  await authoring.locator('[data-kml-editing-field="name"]').fill(name);
  await authoring.getByRole("button", {name: "Apply place edits", exact: true}).tap();
  await page.getByRole("button", {name: `Edit ${name}`, exact: true}).waitFor();
  await page.getByRole("button", {name: "Close project contents", exact: true}).first().tap();
}

async function settleMobileViewport(page, width, height) {
  await page.waitForFunction(([expectedWidth, expectedHeight]) => (
    innerWidth === expectedWidth && innerHeight === expectedHeight
  ), [width, height]);
  await page.locator(".gis-map").evaluate((map) => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
  await page.waitForFunction(() => {
    const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
    const frame = document.querySelector(".gis-map")?.getBoundingClientRect();
    const canvas = map?.getCanvas?.()?.getBoundingClientRect();
    return Boolean(map?.isStyleLoaded?.()
      && frame
      && canvas
      && Math.abs(frame.width - canvas.width) <= 1
      && Math.abs(frame.height - canvas.height) <= 1);
  });
}

function mobileCameraMatches(left, right, tolerance = 1e-6) {
  return left.center.length === right.center.length
    && left.center.every((coordinate, index) => Math.abs(coordinate - right.center[index]) <= tolerance)
    && ["zoom", "pitch", "bearing"].every((field) => Math.abs(left[field] - right[field]) <= tolerance);
}

function kmlEntrySummaries(document) {
  const entries = [];
  const visit = (children) => {
    for (const child of children ?? []) {
      entries.push({name: child.name, kind: child.kind, geometryType: child.geometry?.type ?? null});
      if (child.kind === "folder") visit(child.children);
    }
  };
  visit(document?.children);
  return entries;
}

async function assertCompactMobileFrame(page, route, label) {
  const metrics = await page.locator(".opengeo-workbench").evaluate((workbench) => {
    const rectangle = (selector) => {
      const element = workbench.querySelector(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || bounds.height === 0
        ? null
        : bounds.toJSON();
    };
    const overlaps = (left, right) => Boolean(left && right
      && Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1);
    const toolbar = workbench.querySelector(".gis-mobile-toolbar");
    const toolstrip = workbench.querySelector(".gis-toolstrip");
    const toolbarBounds = rectangle(".gis-mobile-toolbar");
    const guideBounds = rectangle(".gis-map-authoring-guide");
    const controlsBounds = rectangle(".gis-map-control-stack");
    return {
      viewport: {width: innerWidth, height: innerHeight},
      documentOverflow: {
        x: document.documentElement.scrollWidth - innerWidth,
        y: document.documentElement.scrollHeight - innerHeight
      },
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : "missing",
      toolstripDisplay: toolstrip ? getComputedStyle(toolstrip).display : "missing",
      topbar: rectangle(".gis-topbar"),
      map: rectangle(".gis-map"),
      toolbar: toolbarBounds,
      authoringGuide: guideBounds,
      collisions: [
        ...(overlaps(guideBounds, toolbarBounds) ? ["drawing guide / mobile toolbar"] : []),
        ...(overlaps(guideBounds, controlsBounds) ? ["drawing guide / map controls"] : [])
      ]
    };
  });
  if (metrics.toolbarDisplay === "none" || metrics.toolbarDisplay === "missing") {
    failures.push(`${route}: ${label} did not expose the compact mobile toolbar`);
  }
  if (metrics.toolstripDisplay !== "none") {
    failures.push(`${route}: ${label} retained the desktop toolstrip`);
  }
  if (metrics.documentOverflow.x > 1 || metrics.documentOverflow.y > 1) {
    failures.push(`${route}: ${label} document overflowed (${JSON.stringify(metrics.documentOverflow)})`);
  }
  if (!metrics.map || metrics.map.height < 180) {
    failures.push(`${route}: ${label} left less than 180px of usable map height (${metrics.map?.height ?? 0}px)`);
  }
  if (!metrics.topbar || metrics.topbar.height > 64) {
    failures.push(`${route}: ${label} top bar consumed ${metrics.topbar?.height ?? "unknown"}px`);
  }
  if (!metrics.toolbar
    || metrics.toolbar.left < -1
    || metrics.toolbar.right > metrics.viewport.width + 1
    || metrics.toolbar.bottom > metrics.viewport.height + 1) {
    failures.push(`${route}: ${label} toolbar escaped the viewport (${JSON.stringify(metrics.toolbar)})`);
  }
  if (metrics.authoringGuide && (
    metrics.authoringGuide.left < -1
    || metrics.authoringGuide.right > metrics.viewport.width + 1
    || metrics.authoringGuide.top < -1
    || metrics.authoringGuide.bottom > metrics.viewport.height + 1
  )) {
    failures.push(`${route}: ${label} drawing guide escaped the viewport (${JSON.stringify(metrics.authoringGuide)})`);
  }
  if (metrics.collisions.length) {
    failures.push(`${route}: ${label} controls overlap (${metrics.collisions.join(", ")})`);
  }
}

async function mobileWorkbenchSnapshot(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => ({
    workspace: shell.querySelector(".gis-workspace-select")?.value ?? null,
    styleName: shell.__opengeoMap?.getStyle?.().name ?? null,
    center: shell.__opengeoMap?.getCenter?.().toArray?.() ?? [],
    zoom: shell.__opengeoMap?.getZoom?.() ?? null,
    pitch: shell.__opengeoMap?.getPitch?.() ?? null,
    bearing: shell.__opengeoMap?.getBearing?.() ?? null
  }));
}

async function assertWorkbenchLayoutConflicts(page, route, width, colorScheme = "dark") {
  const layout = await page.locator(".opengeo-workbench").evaluate((workbench) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rectangles = (selector) => [...workbench.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => ({label: element.textContent.trim().replace(/\s+/g, " "), rect: element.getBoundingClientRect().toJSON()}));
    const collisions = (items) => {
      const overlaps = [];
      for (let left = 0; left < items.length; left += 1) for (let right = left + 1; right < items.length; right += 1) {
        const a = items[left];
        const b = items[right];
        const overlapWidth = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const overlapHeight = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlapWidth > 1 && overlapHeight > 1) overlaps.push(`${a.label} <> ${b.label}`);
      }
      return overlaps;
    };
    const topbar = workbench.querySelector(".gis-topbar");
    const leftPanel = workbench.querySelector(".gis-panel-left");
    const leftHeader = workbench.querySelector(".gis-left-panel-header");
    const mapColumn = workbench.querySelector(".gis-map-column");
    const leftHeaderControls = rectangles(".gis-left-panel-controls button");
    const leftPanelRect = leftPanel?.getBoundingClientRect();
    const mapColumnRect = mapColumn?.getBoundingClientRect();
    const sideBySide = leftPanelRect && mapColumnRect
      && mapColumnRect.left >= leftPanelRect.right - 1
      && Math.min(leftPanelRect.bottom, mapColumnRect.bottom) - Math.max(leftPanelRect.top, mapColumnRect.top) > 1;
    const leftBoundaryIntrusions = leftHeaderControls
      .filter(({rect}) => leftPanelRect && (
        rect.left < leftPanelRect.left - 1
        || rect.right > leftPanelRect.right + 1
        || (sideBySide && rect.right > mapColumnRect.left + 1)
      ))
      .map(({label}) => label);

    const readableSelectors = [
      ["project context", ".gis-brand span"],
      ["dock heading", ".gis-dock-heading h3"],
      ["projection status", ".gis-projection-disclosure"],
      ["performance status", ".gis-globe-metrics"],
      ["map controls", ".gis-map-control-stack .gis-icon-button"],
      ["map status", ".gis-statusbar"],
      ["layer name", ".gis-layer-row-top > button"],
      ["background feedback", ".gis-basemap-runtime-alert"],
      ["portal source status", ".gis-portal-source-status"],
      ["query receipt", ".gis-query-receipt"],
      ["selected query result", ".gis-query-result-table tbody tr.selected td"]
    ];
    const contrastRatios = readableSelectors.flatMap(([label, selector]) => {
      const element = workbench.querySelector(selector);
      if (!element || !visible(element)) return [];
      const foreground = parseRgb(getComputedStyle(element).color);
      const background = effectiveBackground(element);
      return [{label, ratio: contrastRatio(composite(foreground, background), background)}];
    });

    function effectiveBackground(element) {
      let accumulated = {r: 0, g: 0, b: 0, a: 0};
      for (let node = element; node; node = node.parentElement) {
        accumulated = composite(accumulated, parseRgb(getComputedStyle(node).backgroundColor));
        if (accumulated.a >= 0.999) return accumulated;
      }
      return composite(accumulated, {r: 255, g: 255, b: 255, a: 1});
    }

    function parseRgb(value) {
      if (!value || value === "transparent") return {r: 0, g: 0, b: 0, a: 0};
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return {r, g, b, a};
      }
      const srgb = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
      if (srgb) {
        const [, r, g, b, a = "1"] = srgb;
        return {r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a)};
      }
      return {r: 0, g: 0, b: 0, a: 1};
    }

    function composite(top, bottom) {
      const alpha = top.a + bottom.a * (1 - top.a);
      if (!alpha) return {r: 0, g: 0, b: 0, a: 0};
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha
      };
    }

    function contrastRatio(a, b) {
      const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
      return (values[0] + 0.05) / (values[1] + 0.05);
    }

    function luminance(color) {
      const channels = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    return {
      commandOverlaps: collisions(rectangles(".gis-primary-command, .gis-menu-button")),
      mapChromeOverlaps: collisions(rectangles(".gis-map-control-stack, .gis-map-authoring-guide, .gis-plugin-overlay, .gis-basemap-runtime-alert")),
      topbarOverflow: Math.max(0, (topbar?.scrollWidth ?? 0) - (topbar?.clientWidth ?? 0)),
      leftPanelOverflow: Math.max(0, (leftPanel?.scrollWidth ?? 0) - (leftPanel?.clientWidth ?? 0)),
      leftHeaderOverflow: Math.max(0, (leftHeader?.scrollWidth ?? 0) - (leftHeader?.clientWidth ?? 0)),
      leftHeaderControlOverlaps: collisions(leftHeaderControls),
      leftBoundaryIntrusions,
      floatingMapToolbarCount: workbench.querySelectorAll(".gis-map-actions").length,
      titledLeftActions: [...workbench.querySelectorAll(".gis-left-panel-actions [title]")].map((element) => element.textContent.trim()),
      missingPrimaryIcons: [...workbench.querySelectorAll(".gis-primary-command")]
        .filter((element) => !element.querySelector(".gis-command-icon svg"))
        .map((element) => element.textContent.trim().replace(/\s+/g, " ")),
      contrastRatios
    };
  });
  if (layout.commandOverlaps.length) failures.push(`${route} ${width}px: command/menu overlap (${layout.commandOverlaps.join(", ")})`);
  if (layout.mapChromeOverlaps.length) failures.push(`${route} ${width}px: map chrome overlap (${layout.mapChromeOverlaps.join(", ")})`);
  if (layout.topbarOverflow > 1) failures.push(`${route} ${width}px: topbar overflows by ${layout.topbarOverflow}px`);
  if (layout.leftPanelOverflow > 1) failures.push(`${route} ${width}px: left panel content overflows by ${layout.leftPanelOverflow}px`);
  if (layout.leftHeaderOverflow > 1) failures.push(`${route} ${width}px: left panel header overflows by ${layout.leftHeaderOverflow}px`);
  if (layout.leftHeaderControlOverlaps.length) failures.push(`${route} ${width}px: left panel controls overlap (${layout.leftHeaderControlOverlaps.join(", ")})`);
  if (layout.leftBoundaryIntrusions.length) failures.push(`${route} ${width}px: left panel controls cross into the map (${layout.leftBoundaryIntrusions.join(", ")})`);
  if (layout.floatingMapToolbarCount) failures.push(`${route} ${width}px: obsolete floating map toolbar is still present`);
  if (layout.titledLeftActions.length) failures.push(`${route} ${width}px: left panel actions still expose native spillover tooltips (${layout.titledLeftActions.join(", ")})`);
  if (layout.missingPrimaryIcons.length) failures.push(`${route} ${width}px: primary commands lack comparator-style icons (${layout.missingPrimaryIcons.join(", ")})`);
  for (const {label, ratio} of layout.contrastRatios) {
    if (ratio < 7) failures.push(`${route} ${width}px ${colorScheme}: ${label} contrast is ${ratio.toFixed(2)}:1; expected at least 7:1`);
  }
}

async function visit(page, url, route) {
  const response = await page.goto(url, {waitUntil: "load"});
  if (!response || response.status() !== 200) failures.push(`${route}: expected HTTP 200, got ${response?.status() ?? "no response"}`);
  await page.waitForTimeout(750);
  if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") {
    const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
    browserProgress(`${route}: ${body.slice(0, 1_200).replace(/\s+/g, " ")}`);
  }
}

async function assertNoRuntimeError(page, route) {
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("RuntimeError") || bodyText.includes("Observable is not defined")) {
    failures.push(`${route}: visible runtime error`);
  }
}

function capturePageErrors(page, label) {
  const noContentResponses = new Set();
  page.on("crash", () => {
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") console.error(`${label}: browser page crashed`);
  });
  page.on("close", () => {
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") console.error(`${label}: browser page closed`);
  });
  page.on("pageerror", (error) => {
    const message = `${label}: uncaught browser error: ${error.stack ?? error.message}`;
    failures.push(message);
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") console.error(message);
  });
  page.on("requestfailed", (request) => {
    const requestKey = `${request.method()} ${request.url()}`;
    if (noContentResponses.delete(requestKey)
      && request.failure()?.errorText === "net::ERR_ABORTED") return;
    const expectedFeatureQueryAbort = request.failure()?.errorText === "net::ERR_ABORTED"
      && request.url().includes("/feature-query")
      && (browserExpectedAbortedRequests.has(request) || browserExpectedFeatureQueryAborts > 0);
    if (expectedFeatureQueryAbort) {
      if (!browserExpectedAbortedRequests.has(request)) {
        browserExpectedAbortedRequests.add(request);
        browserExpectedFeatureQueryAborts -= 1;
      }
      return;
    }
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") {
      console.error(`Browser request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
    }
    if (!request.url().includes("/api/")) return;
    failures.push(
      `${label}: API request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`
    );
  });
  page.on("response", (response) => {
    if ([204, 205, 304].includes(response.status())) {
      noContentResponses.add(`${response.request().method()} ${response.url()}`);
    }
    if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1"
      && response.status() >= 400
      && response.url().includes("/_import/")) {
      console.error(`Browser module response: ${response.status()} ${response.url()}`);
    }
  });
}

async function assertMapPreview(page, route) {
  const workbench = await page.locator(".opengeo-workbench").count();
  const mapFrames = await page.locator(".gis-map, .workbench-map, .map-frame").count();
  const layerRows = await page.locator(".gis-layer-row").count();
  const menus = await page.locator(".gis-menubar").count();
  const appNav = await page.locator(".gis-app-nav").count();
  const homeLinks = await page.getByRole("link", {name: "Home"}).count();
  const brandLinks = await page.getByRole("link", {name: /OpenGeo Studio/}).count();
  const mapControls = await page.locator(".gis-map-control-stack").count();
  const focusedDefault = await page.locator(".opengeo-workbench.right-collapsed").count();
  const layersMode = await page.locator(".gis-left-panel-header h2", {hasText: "Layers"}).count();
  const primaryCommands = await page.locator(".gis-primary-command").allTextContents();
  if (!workbench) failures.push(`${route}: expected a GIS workbench`);
  if (!mapFrames) failures.push(`${route}: expected a map preview container`);
  if (!layerRows) failures.push(`${route}: expected layer controls`);
  if (!menus) failures.push(`${route}: expected OpenGeo Studio toolbar menus`);
  if (!appNav) failures.push(`${route}: expected application navigation`);
  if (!homeLinks || !brandLinks) failures.push(`${route}: expected obvious navigation back to the app home`);
  if (!mapControls) failures.push(`${route}: expected map control stack`);
  if (!focusedDefault || !layersMode) failures.push(`${route}: expected the map-first Layers view with the inspector initially closed`);
  for (const command of ["Open file", "Add data", "Point", "Path", "Polygon", "Fit", "Identify"]) {
    if (!primaryCommands.some((label) => label.includes(command))) {
      failures.push(`${route}: primary command surface did not expose ${command}`);
    }
  }
  if (await page.locator('.gis-menubar [data-menu="project"] > button').count() !== 1) {
    failures.push(`${route}: project file and directory commands lost their menu entry`);
  }
  const commandLayout = await page.locator(".gis-topbar").evaluate((topbar) => {
    const controls = [...topbar.querySelectorAll(".gis-primary-command, .gis-menu-button")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        label: element.textContent.trim(),
        rect: element.getBoundingClientRect().toJSON()
      }));
    const overlaps = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left];
        const b = controls[right];
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) overlaps.push(`${a.label} <> ${b.label}`);
      }
    }
    return {
      overlaps,
      topbarOverflow: Math.max(0, topbar.scrollWidth - topbar.clientWidth)
    };
  });
  if (commandLayout.overlaps.length) {
    failures.push(`${route}: primary/menu controls overlap (${commandLayout.overlaps.join(", ")})`);
  }
  if (commandLayout.topbarOverflow > 1) {
    failures.push(`${route}: topbar overflows horizontally by ${commandLayout.topbarOverflow}px`);
  }
}

async function assertStartExperience(page, route) {
  const actions = await page.locator(".start-action-card").count();
  const recent = await page.locator(".start-project-row").count();
  if (actions !== 3) failures.push(`${route}: expected New project, Open file, and Open project actions`);
  if (!recent) failures.push(`${route}: expected recent projects on the start screen`);
  if (await page.locator(".start-library-strip").count() !== 1) {
    failures.push(`${route}: expected the preserved publication library entry`);
  }
  await expectText(
    page,
    "A project workspace for reproducible geospatial analysis",
    "task-first start heading"
  );
  await expectText(page, "27 preserved pages", "preserved publication count");
  if (await page.locator(".start-map-overlay").count() !== 1
    || await page.locator(".start-workbench-frame > .opengeo-workbench").count() !== 1) {
    failures.push(`${route}: expected the start choices to appear over a usable map workspace`);
  }
  for (const command of ["Point", "Path", "Polygon"]) {
    if (await page.getByRole("button", {name: command, exact: true}).count() !== 1) {
      failures.push(`${route}: expected one immediate ${command} drawing command behind the start panel`);
    }
  }
  if (await page.locator('.start-action-card', {hasText: "Open a project"}).count() !== 1) {
    failures.push(`${route}: Studio start screen did not expose project-directory navigation`);
  }

  const palette = await page.locator(".opengeo-start").evaluate((start) => {
    const resolvedColor = (selector) => getComputedStyle(start.querySelector(selector)).color;
    const probe = document.createElement("span");
    probe.style.color = "var(--start-focus)";
    start.append(probe);
    const focus = getComputedStyle(probe).color;
    probe.remove();
    return {
      foreground: resolvedColor(".start-map-dialog"),
      focus,
      action: resolvedColor(".start-action-card small"),
      project: resolvedColor(".start-project-identity strong")
    };
  });
  if (palette.project !== palette.foreground) {
    failures.push(`${route}: recent-project text did not use the start panel foreground, received ${palette.project}`);
  }
  if (palette.foreground === palette.focus) {
    failures.push(`${route}: expected the keyboard focus color to remain distinct from the everyday Studio palette`);
  }
}

async function assertStudioStartWorkspace(browser, baseUrl) {
  for (const colorScheme of ["dark", "light"]) {
    const context = await browser.newContext({colorScheme, viewport: {width: 1440, height: 950}});
    let openFreeMapOutagePath = null;
    let regionalRasterOutage = false;
    const openFreeMapStyleRequests = [];
    await context.route("https://a.basemaps.cartocdn.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: basemapTileBytes
    }));
    await context.route("https://tiles.openfreemap.org/styles/**", async (route) => {
      const target = new URL(route.request().url());
      openFreeMapStyleRequests.push(target.pathname);
      if (target.pathname === openFreeMapOutagePath) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        await route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "deterministic basemap outage"
        });
        return;
      }
      const styleName = target.pathname.split("/").filter(Boolean).at(-1) ?? "fixture";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 8,
          name: `Browser ${styleName}`,
          sources: {},
          layers: [{id: "background", type: "background", paint: {"background-color": "#dce7ec"}}]
        })
      });
    });
    await context.route("https://regional.example.test/**", async (route) => {
      if (regionalRasterOutage) {
        // Keep the request outstanding long enough for the isolated renderer
        // to own it before returning the deterministic HTTP failure.
        await new Promise((resolve) => setTimeout(resolve, 75));
        await route.fulfill({status: 503, contentType: "text/plain", body: "deterministic raster outage"});
        return;
      }
      await route.fulfill({status: 200, contentType: "image/png", body: basemapTileBytes});
    });
    await context.route("https://gibs.earthdata.nasa.gov/**", (route) => route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: basemapTileBytes
    }));
    await context.route("https://basemap.nationalmap.gov/**", (route) => route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: basemapTileBytes
    }));
    const page = await context.newPage();
    capturePageErrors(page, `${colorScheme} Studio start`);
    const route = "/?adapter=fixture";
    await visit(page, `${baseUrl}${route}`, `${route} ${colorScheme} Studio start`);
    await page.locator(".start-map-dialog").waitFor();
    await page.locator(".gis-map .maplibregl-canvas").waitFor();
    await assertStartExperience(page, route);
    await assertReadable(page, `${route} ${colorScheme} start panel`);
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `studio-start-overlay-${colorScheme}.png`),
        fullPage: true
      });
    }
    await page.getByRole("button", {name: "Close start panel and use an empty map"}).click();
    if (!await page.locator(".start-map-overlay").isHidden()) {
      failures.push(`${route}: start panel did not dismiss over the empty map`);
    }
    for (const [command, kind] of [
      ["Point", "Point"],
      ["Path", "LineString"],
      ["Polygon", "Polygon"]
    ]) {
      await page.getByRole("button", {name: command, exact: true}).click();
      await page.locator(`.gis-map-authoring-guide[data-authoring-kind="${kind}"]`).waitFor();
      await page.getByRole("button", {name: "Cancel drawing"}).click();
    }
    const imageChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", {name: "Image overlay", exact: true}).click();
    await (await imageChooser).setFiles([]);
    await page.locator('[data-image-overlay-file]').evaluateAll((inputs) => inputs.forEach((input) => input.dispatchEvent(new Event("cancel"))));
    await page.locator('.gis-menubar [data-menu="edit"] > button').click();
    const editMenuText = await page.locator('.gis-menu-wrap[data-menu="edit"] .gis-menu-dropdown').innerText();
    if (editMenuText.includes("Add point at map center")) {
      failures.push(`${route}: legacy map-center point action is still exposed`);
    }
    for (const label of ["Draw point on map", "Draw path on map", "Draw polygon on map", "Place image overlay on map"]) {
      if (!editMenuText.includes(label)) failures.push(`${route}: Edit menu is missing ${label}`);
    }
    await page.locator('.gis-menubar [data-menu="edit"] > button').click();
    const backgroundButton = page.locator(".gis-basemap-tree-row > button");
    if (!await backgroundButton.innerText().then((text) => text.includes("Background · Positron"))) {
      failures.push(`${route}: project tree did not expose the initial key-free Positron background`);
    }
    await backgroundButton.click();
    const basemapDialog = page.getByRole("dialog", {name: "Change basemap"});
    await basemapDialog.waitFor();
    if (await page.locator('.gis-topbar[inert][aria-hidden="true"]').count() !== 1) {
      failures.push(`${route}: basemap dialog did not make the workbench background inert`);
    }
    const basemapTitles = await basemapDialog.locator(".gis-basemap-card > strong").allTextContents();
    for (const title of [
      "Liberty",
      "Liberty 3D",
      "Positron",
      "Bright",
      "Dark",
      "Fiord",
      "Blue Marble relief",
      "Earth at night",
      "USGS imagery",
      "USGS shaded relief"
    ]) {
      if (!basemapTitles.includes(title)) {
        failures.push(`${route}: key-free GeoLibre/OpenFreeMap choice ${title} is missing`);
      }
    }
    for (const groupId of [
      "key-free-imagery",
      "key-free-terrain-relief",
      "open-terrain",
      "protomaps",
      "regional",
      "moon",
      "mars",
      "other-celestial-bodies"
    ]) {
      if (await basemapDialog.locator(`[data-catalog-group="${groupId}"]`).count() !== 1) {
        failures.push(`${route}: GeoLibre-inspired ${groupId} catalog group is missing`);
      }
    }
    const blueMarble = basemapDialog.locator(
      '.gis-basemap-card[data-catalog-id="nasa-blue-marble-relief"]'
    );
    if (await blueMarble.getAttribute("data-access") !== "no-api-key"
      || !await blueMarble.innerText().then((text) => (
        text.includes("Global Web Mercator · zoom 1–8")
        && text.includes("No API key · NASA GIBS")
      ))) {
      failures.push(`${route}: reviewed Blue Marble card did not expose access, coverage, and zoom facts`);
    }
    const openTerrain = basemapDialog.locator(
      '.gis-terrain-card[data-catalog-id="mapterhorn-open-terrain"]'
    );
    if (await openTerrain.getAttribute("aria-label") !== "Enable open 3D terrain"
      || !await openTerrain.getAttribute("title").then(text => text.includes("Mapterhorn") && text.includes("Terms:"))) {
      failures.push(`${route}: basemap chooser did not surface the distinct open-terrain action and service limits`);
    }
    await blueMarble.click();
    await page.locator('.opengeo-workbench[data-basemap-activation-state="active"]').waitFor();
    await basemapDialog.locator(
      '.gis-basemap-card[data-catalog-id="nasa-blue-marble-relief"][aria-pressed="true"]'
    ).waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.getSource("basemap"));
    const blueMarbleRuntime = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      current: shell.dataset.basemap,
      tiles: shell.__opengeoMap.getStyle().sources.basemap?.tiles ?? []
    }));
    if (!blueMarbleRuntime.tiles.some((url) => url.includes("BlueMarble_ShadedRelief_Bathymetry"))) {
      failures.push(`${route}: reviewed Blue Marble choice did not install its bounded NASA raster source`);
    }
    await page.keyboard.press("Escape");
    await basemapDialog.waitFor({state: "detached"});
    const attributionInner = page.locator(".gis-map .maplibregl-ctrl-attrib-inner");
    if (!await attributionInner.isVisible()) {
      await page.locator(".gis-map .maplibregl-ctrl-attrib-button:visible").click();
    }
    await attributionInner.getByText("NASA GIBS", {exact: false}).waitFor();
    const attributionLayout = await page.locator(".opengeo-workbench").evaluate((shell) => {
      const map = shell.querySelector(".gis-map")?.getBoundingClientRect();
      const attribution = shell.querySelector(".maplibregl-ctrl-attrib")?.getBoundingClientRect();
      const controls = shell.querySelector(".gis-map-control-stack")?.getBoundingClientRect();
      const overlaps = (left, right) => Boolean(left && right
        && Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
        && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1);
      return {
        contained: Boolean(map && attribution
          && attribution.left >= map.left - 1
          && attribution.top >= map.top - 1
          && attribution.right <= map.right + 1
          && attribution.bottom <= map.bottom + 1),
        overlapsMapControls: overlaps(attribution, controls)
      };
    });
    if (!attributionLayout.contained || attributionLayout.overlapsMapControls) {
      failures.push(`${route}: source attribution escaped or overlapped the map controls (${JSON.stringify(attributionLayout)})`);
    }
    await page.locator(".gis-map .maplibregl-ctrl-attrib-button:visible").click();
    await backgroundButton.click();
    await basemapDialog.waitFor();
    const protomapsGroup = basemapDialog.locator('[data-catalog-group="protomaps"]');
    if (!await protomapsGroup.evaluate((element) => element.open)) {
      await protomapsGroup.locator(":scope > summary").click();
    }
    const unavailableLight = basemapDialog.locator(
      '.gis-basemap-card[data-catalog-id="provider-protomaps-unconfigured-light"]'
    );
    if (await unavailableLight.getAttribute("data-unavailable") !== "true") {
      failures.push(`${route}: Protomaps Light was enabled without a reusable provider connection`);
    }
    await unavailableLight.click();
    if (!await basemapDialog.getByRole("status").innerText().then((text) => text.includes("reusable provider connection"))) {
      failures.push(`${route}: unavailable Protomaps choice did not explain its connection requirement`);
    }
    await basemapDialog.locator(".gis-basemap-source-tools > summary").click();
    if (
      await basemapDialog.getByText("Regional XYZ basemap", {exact: true}).count() !== 1
      || await basemapDialog.getByLabel("License or terms reference").count() !== 1
      || await basemapDialog.getByLabel("Coverage · west, south, east, north").count() !== 1
      || await basemapDialog.getByLabel("Coordinate behavior").count() !== 1
    ) {
      failures.push(`${route}: basemap source tools did not expose the governed regional source contract`);
    }
    await basemapDialog.getByRole("button", {name: "Register and use basemap"}).click();
    await page.locator(".gis-statusbar strong")
      .filter({hasText: "A persistent editable project is required"})
      .waitFor();
    await basemapDialog.getByLabel("Public HTTPS URL").fill("https://api.protomaps.com/styles/v4/light/en.json");
    await basemapDialog.getByRole("button", {name: "Use custom basemap"}).click();
    if (!await page.locator(".gis-statusbar strong").innerText().then((text) => (
      text.includes("Custom basemap rejected") && text.includes("reusable OpenGeo connection")
    ))) {
      failures.push(`${route}: public custom-style path accepted or poorly explained a Protomaps provider URL`);
    }
    await basemapDialog.locator('[data-catalog-group="moon"] > summary').click();
    if (await basemapDialog.getByText("Hillshaded Albedo", {exact: true}).count() !== 1) {
      failures.push(`${route}: lunar catalog disclosure did not expose its indexed choice`);
    }
    await basemapDialog.locator(".gis-basemap-card", {has: page.getByText("Fiord", {exact: true})}).click();
    await basemapDialog.locator('.gis-basemap-card[aria-pressed="true"]', {hasText: "Fiord"}).waitFor();
    if (await basemapDialog.locator("[data-basemap-current]").innerText() !== "Fiord") {
      failures.push(`${route}: chooser summary did not update after selecting Fiord`);
    }
    if (await page.locator('.gis-content-tree[role="tree"] .gis-basemap-tree-row').count() !== 1) {
      failures.push(`${route}: project contents did not retain a tree-style background entry`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `studio-empty-map-basemaps-${colorScheme}.png`),
        fullPage: true
      });
    }
    await page.keyboard.press("Escape");
    if (await basemapDialog.count() !== 0 || await page.locator('.gis-topbar[inert]').count() !== 0) {
      failures.push(`${route}: basemap dialog did not close and restore the workbench`);
    }
    if (!await backgroundButton.evaluate((element) => element === document.activeElement)) {
      failures.push(`${route}: Escape did not restore focus to the Background tree action`);
    }
    await page.setViewportSize({width: 390, height: 900});
    await page.locator(".opengeo-workbench.left-collapsed.right-collapsed").waitFor();
    await assertWorkbenchLayoutConflicts(page, route, 390, colorScheme);
    await assertReadable(page, `${route} ${colorScheme} empty map`);
    const narrowBasemapTrigger = page.locator('[aria-label="Change basemap"]:visible').first();
    const narrowTriggerSize = await narrowBasemapTrigger.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return {width: rectangle.width, height: rectangle.height};
    });
    if (narrowTriggerSize.width < 44 || narrowTriggerSize.height < 44) {
      failures.push(`${route}: portrait Change basemap target is smaller than 44px (${narrowTriggerSize.width}×${narrowTriggerSize.height})`);
    }
    await narrowBasemapTrigger.click();
    const narrowBasemapDialog = page.getByRole("dialog", {name: "Change basemap"});
    const narrowDialogLayout = await narrowBasemapDialog.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return {
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
        bottom: rectangle.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
      };
    });
    if (narrowDialogLayout.left < -1
      || narrowDialogLayout.right > narrowDialogLayout.viewportWidth + 1
      || narrowDialogLayout.top < -1
      || narrowDialogLayout.bottom > narrowDialogLayout.viewportHeight + 1
      || narrowDialogLayout.scrollWidth > narrowDialogLayout.clientWidth + 1) {
      failures.push(`${route}: focused basemap chooser escaped the 390-pixel viewport`);
    }
    await narrowBasemapDialog.focus();
    await page.keyboard.press("Shift+Tab");
    if (await page.locator(':focus').innerText() !== "Done") {
      failures.push(`${route}: reverse Tab did not remain trapped inside the basemap chooser`);
    }
    await page.keyboard.press("Tab");
    if (await page.locator(":focus").getAttribute("aria-label") !== "Close basemap chooser") {
      failures.push(`${route}: forward Tab did not wrap to the first basemap chooser control`);
    }
    const narrowTargets = await visibleTargetSizes(narrowBasemapDialog);
    for (const target of narrowTargets.filter(({width, height}) => width < 44 || height < 44)) {
      failures.push(`${route}: portrait basemap target ${target.label} is smaller than 44px (${target.width}×${target.height})`);
    }
    const narrowContrast = await minimumBasemapDialogContrast(narrowBasemapDialog);
    if (narrowContrast < 4.5) {
      failures.push(`${route}: portrait basemap chooser contrast is ${narrowContrast.toFixed(2)}:1; expected at least 4.5:1`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `studio-basemap-modal-mobile-${colorScheme}.png`),
        fullPage: true
      });
    }
    await page.keyboard.press("Escape");

    const closeProjectContents = page.getByRole("button", {name: "Close project contents"});
    if (await closeProjectContents.isVisible()) await closeProjectContents.click();
    if (await page.locator(".opengeo-workbench.left-collapsed").count() !== 1) {
      failures.push(`${route}: closing the phone project drawer did not return to the map`);
    }
    await page.setViewportSize({width: 844, height: 390});
    const landscapeBasemapTrigger = page.locator('[aria-label="Change basemap"]:visible').first();
    const landscapeTriggerSize = await landscapeBasemapTrigger.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return {width: rectangle.width, height: rectangle.height};
    });
    if (landscapeTriggerSize.width < 44 || landscapeTriggerSize.height < 44) {
      failures.push(`${route}: landscape Change basemap target is smaller than 44px (${landscapeTriggerSize.width}×${landscapeTriggerSize.height})`);
    }
    await landscapeBasemapTrigger.click();
    const landscapeBasemapDialog = page.getByRole("dialog", {name: "Change basemap"});
    await landscapeBasemapDialog.waitFor();
    const landscapeDialogLayout = await landscapeBasemapDialog.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const body = element.querySelector(".gis-basemap-dialog-body")?.getBoundingClientRect();
      return {
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
        bottom: rectangle.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        bodyHeight: body?.height ?? 0
      };
    });
    if (landscapeDialogLayout.left < -1
      || landscapeDialogLayout.right > landscapeDialogLayout.viewportWidth + 1
      || landscapeDialogLayout.top < -1
      || landscapeDialogLayout.bottom > landscapeDialogLayout.viewportHeight + 1
      || landscapeDialogLayout.horizontalOverflow > 1
      || landscapeDialogLayout.bodyHeight < 44) {
      failures.push(`${route}: basemap chooser was not usable at 844×390 (${JSON.stringify(landscapeDialogLayout)})`);
    }
    const landscapeTargets = await visibleTargetSizes(landscapeBasemapDialog);
    for (const target of landscapeTargets.filter(({width, height}) => width < 44 || height < 44)) {
      failures.push(`${route}: landscape basemap target ${target.label} is smaller than 44px (${target.width}×${target.height})`);
    }
    const landscapeContrast = await minimumBasemapDialogContrast(landscapeBasemapDialog);
    if (landscapeContrast < 4.5) {
      failures.push(`${route}: landscape basemap chooser contrast is ${landscapeContrast.toFixed(2)}:1; expected at least 4.5:1`);
    }
    await landscapeBasemapDialog.focus();
    await page.keyboard.press("Shift+Tab");
    if (await page.locator(":focus").innerText() !== "Done") {
      failures.push(`${route}: 844×390 reverse Tab escaped the basemap chooser`);
    }
    await page.keyboard.press("Tab");
    if (await page.locator(":focus").getAttribute("aria-label") !== "Close basemap chooser") {
      failures.push(`${route}: 844×390 forward Tab escaped the basemap chooser`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `studio-basemap-modal-landscape-${colorScheme}.png`),
        fullPage: false
      });
    }
    await page.keyboard.press("Escape");

    await page.setViewportSize({width: 1440, height: 950});
    const projectRoute = fixtureProjectRoute;
    await visit(page, `${baseUrl}${projectRoute}`, `${projectRoute} ${colorScheme} basemap preservation`);
    await page.waitForFunction(() => {
      const shell = document.querySelector(".opengeo-workbench");
      return shell?.__opengeoLayers?.length >= 2
        && shell.__opengeoMap?.isStyleLoaded?.()
        && shell.__opengeoLayers.every((layer) => shell.__opengeoMap.getSource(`${layer.layerId}-source`));
    });
    if (await page.locator(".opengeo-workbench").getAttribute("data-color-mode") !== colorScheme) {
      await page.getByRole("button", {name: colorScheme === "light" ? "Light" : "Dark", exact: true}).click();
    }
    const beforeSwitch = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      layers: shell.__opengeoLayers.map(({layerId, title, order}) => ({layerId, title, order})),
      center: shell.__opengeoMap.getCenter().toArray(),
      zoom: shell.__opengeoMap.getZoom()
    }));
    await page.getByRole("button", {name: /Background · /}).click();
    const projectBasemapDialog = page.getByRole("dialog", {name: "Change basemap"});
    if (!await projectBasemapDialog.innerText().then((text) => text.includes("0 compatible · 1 dataset-only"))) {
      failures.push(`${projectRoute}: chooser did not distinguish the attached S3 dataset connection from a basemap-provider connection`);
    }
    await projectBasemapDialog.locator('[data-catalog-group="moon"] > summary').click();
    const blockedMoon = projectBasemapDialog.locator(
      '.gis-basemap-card[data-catalog-id="planetary-blank-moon"]'
    );
    if (await blockedMoon.getAttribute("data-availability") !== "empty-project-required"
      || await blockedMoon.getAttribute("data-unavailable") !== "true") {
      failures.push(`${projectRoute}: populated Earth project allowed a silent switch to Moon coordinates`);
    }
    await blockedMoon.click();
    if (!await projectBasemapDialog.getByRole("status").innerText().then((text) => (
      text.includes("already contains Earth layers") && text.includes("never silently reinterpreted")
    ))) {
      failures.push(`${projectRoute}: blocked Moon switch did not explain the coordinate safety rule`);
    }
    const currentBeforeFailure = await projectBasemapDialog.locator("[data-basemap-current]").innerText();
    const renderedStyleBeforeFailure = await page.locator(".opengeo-workbench").evaluate(
      (shell) => shell.__opengeoMap.getStyle().name
    );
    openFreeMapOutagePath = "/styles/fiord";
    await projectBasemapDialog.locator(".gis-basemap-card", {has: page.getByText("Fiord", {exact: true})}).click();
    await page.locator('.opengeo-workbench[data-basemap-activation-state="loading"]').waitFor();
    await page.locator('.opengeo-workbench[data-basemap-activation-state="failed"]').waitFor();
    const failedFeedback = projectBasemapDialog.locator(
      '.gis-basemap-dialog-feedback[data-activation-state="failed"]'
    );
    await failedFeedback.waitFor();
    if (!await failedFeedback.innerText().then((text) => (
      text.includes("Fiord reported a loading or rendering error")
      && text.includes(`${currentBeforeFailure} is still displayed and remains the saved selection`)
    ))) {
      failures.push(`${projectRoute}: failed candidate did not explain transactional retention`);
    }
    for (const action of [`Retry Fiord`, `Keep ${currentBeforeFailure}`, "Use blank canvas"]) {
      if (await failedFeedback.getByRole("button", {name: action, exact: true}).count() !== 1) {
        failures.push(`${projectRoute}: failed candidate did not expose ${action}`);
      }
    }
    if (await projectBasemapDialog.locator("[data-basemap-current]").innerText() !== currentBeforeFailure
      || await projectBasemapDialog.locator('.gis-basemap-card[aria-pressed="true"] > strong').innerText() !== currentBeforeFailure) {
      failures.push(`${projectRoute}: failed candidate changed the chooser's current basemap`);
    }
    const renderedStyleAfterFailure = await page.locator(".opengeo-workbench").evaluate(
      (shell) => shell.__opengeoMap.getStyle().name
    );
    if (renderedStyleAfterFailure !== renderedStyleBeforeFailure) {
      failures.push(`${projectRoute}: failed candidate replaced the rendered basemap`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `basemap-transaction-failure-${colorScheme}.png`),
        fullPage: true
      });
    }
    await projectBasemapDialog.getByRole("button", {name: "Done"}).click();
    await page.getByRole("button", {name: "Project", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Save to browser draft"}).click();
    const savedAfterFailure = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    });
    if (savedAfterFailure?.basemaps?.find(({visible}) => visible)?.basemapId !== "openfreemap-positron") {
      failures.push(`${projectRoute}: browser save persisted a failed Fiord candidate`);
    }

    await page.getByRole("button", {name: /Background · /}).click();
    const retryDialog = page.getByRole("dialog", {name: "Change basemap"});
    openFreeMapOutagePath = null;
    await retryDialog.getByRole("button", {name: "Retry Fiord", exact: true}).click();
    await page.locator('.opengeo-workbench[data-basemap-activation-state="active"]').waitFor();
    await retryDialog.locator('.gis-basemap-card[aria-pressed="true"]', {hasText: "Fiord"}).waitFor();
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `basemap-transaction-recovered-${colorScheme}.png`),
        fullPage: true
      });
    }
    try {
      await page.waitForFunction(() => {
        const shell = document.querySelector(".opengeo-workbench");
        return shell?.__opengeoMap?.isStyleLoaded?.()
          && shell.__opengeoLayers.every((layer) => shell.__opengeoMap.getSource(`${layer.layerId}-source`));
      });
    } catch (error) {
      const diagnostic = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        styleLoaded: shell.__opengeoMap?.isStyleLoaded?.() ?? false,
        styleName: shell.__opengeoMap?.getStyle?.().name ?? null,
        expectedSources: shell.__opengeoLayers?.map(({layerId}) => `${layerId}-source`) ?? [],
        actualSources: Object.keys(shell.__opengeoMap?.getStyle?.().sources ?? {})
      }));
      throw new Error(`OpenFreeMap style switch did not restore project layers: ${JSON.stringify(diagnostic)}`, {cause: error});
    }
    const afterSwitch = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      layers: shell.__opengeoLayers.map(({layerId, title, order}) => ({layerId, title, order})),
      center: shell.__opengeoMap.getCenter().toArray(),
      zoom: shell.__opengeoMap.getZoom()
    }));
    if (JSON.stringify(afterSwitch.layers) !== JSON.stringify(beforeSwitch.layers)) {
      failures.push(`${projectRoute}: switching to an OpenFreeMap style did not preserve the project layer tree`);
    }
    if (Math.abs(afterSwitch.center[0] - beforeSwitch.center[0]) > 0.0001
      || Math.abs(afterSwitch.center[1] - beforeSwitch.center[1]) > 0.0001
      || Math.abs(afterSwitch.zoom - beforeSwitch.zoom) > 0.0001) {
      failures.push(`${projectRoute}: switching basemaps changed the saved map camera`);
    }
    if (openFreeMapStyleRequests.filter((path) => path === "/styles/fiord").length < 2) {
      failures.push(`${projectRoute}: deterministic outage and retry did not both request Fiord`);
    }
    await retryDialog.getByRole("button", {name: "Done"}).click();
    await page.getByRole("button", {name: "Project", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Save to browser draft"}).click();
    const savedAfterRecovery = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    });
    if (savedAfterRecovery?.basemaps?.find(({visible}) => visible)?.basemapId !== "openfreemap-fiord") {
      failures.push(`${projectRoute}: recovered Fiord candidate was not available to the browser save`);
    }

    await page.getByRole("button", {name: /Background · Fiord/}).click();
    const rasterDialog = page.getByRole("dialog", {name: "Change basemap"});
    const customBasemap = rasterDialog.locator(".gis-basemap-custom-source");
    regionalRasterOutage = true;
    await customBasemap.getByLabel("Source type").selectOption("raster");
    await customBasemap.getByLabel("Name", {exact: true}).fill("Unavailable raster");
    await customBasemap.getByLabel("Public HTTPS URL").fill("https://regional.example.test/{z}/{x}/{y}.png");
    await customBasemap.getByLabel("Attribution", {exact: true}).fill("Example mapping agency");
    await customBasemap.getByRole("button", {name: "Use custom basemap"}).click();
    // Let the deliberately aborted tile requests settle before asserting the
    // transactional failure state; MapLibre may emit several tile errors in a
    // single task when the current camera crosses tile boundaries.
    await page.waitForTimeout(1000);
    await page.locator('.opengeo-workbench[data-basemap-activation-state="failed"]').waitFor();
    if (await rasterDialog.locator("[data-basemap-current]").innerText() !== "Fiord") {
      failures.push(`${projectRoute}: failed raster candidate changed the current basemap`);
    }
    await rasterDialog.getByRole("button", {name: "Keep Fiord", exact: true}).click();
    await page.locator('.opengeo-workbench[data-basemap-activation-state="retained"]').waitFor();
    if (!await rasterDialog.getByRole("status").innerText().then((text) => text.includes("No basemap selection changed"))) {
      failures.push(`${projectRoute}: explicit raster fallback did not confirm the retained basemap`);
    }
    regionalRasterOutage = false;
    await rasterDialog.getByRole("button", {name: "Done"}).click();
    await context.close();
  }
}

async function assertBasemapRuntimeRecovery(browser, baseUrl) {
  for (const colorScheme of ["dark", "light"]) {
    const context = await browser.newContext({colorScheme, viewport: {width: 1440, height: 950}});
    let runtimeStyleOutage = false;
    let runtimeTileOutage = false;
    let outageTileRequests = 0;
    let retryStyleRequests = 0;
    await context.route("https://tiles.openfreemap.org/styles/**", async (route) => {
      if (runtimeStyleOutage) retryStyleRequests += 1;
      const styleName = new URL(route.request().url()).pathname.split("/").filter(Boolean).at(-1) ?? "fixture";
      await route.fulfill({
        status: runtimeStyleOutage ? 503 : 200,
        contentType: runtimeStyleOutage ? "text/plain" : "application/json",
        body: runtimeStyleOutage ? "deterministic retry style outage" : JSON.stringify({
          version: 8,
          name: `Runtime ${styleName}`,
          sources: {
            "runtime-basemap-source": {
              type: "raster",
              tiles: ["https://runtime-basemap.example.test/{z}/{x}/{y}.png"],
              tileSize: 256,
              minzoom: 0,
              maxzoom: 22,
              attribution: "Runtime basemap fixture"
            }
          },
          layers: [{id: "runtime-basemap-layer", type: "raster", source: "runtime-basemap-source"}]
        })
      });
    });
    await context.route("https://runtime-basemap.example.test/**", async (route) => {
      if (runtimeTileOutage) outageTileRequests += 1;
      await route.fulfill({
        status: runtimeTileOutage ? 503 : 200,
        contentType: runtimeTileOutage ? "text/plain" : "image/png",
        body: runtimeTileOutage ? "deterministic post-activation outage" : basemapTileBytes
      });
    });
    await context.route("https://a.basemaps.cartocdn.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: basemapTileBytes
    }));
    const page = await context.newPage();
    const route = fixtureProjectRoute;
    capturePageErrors(page, `${colorScheme} basemap runtime recovery`);
    await visit(page, `${baseUrl}${route}`, `${route} ${colorScheme} basemap runtime recovery`);
    try {
      await page.waitForFunction(() => {
        const shell = document.querySelector(".opengeo-workbench");
        return shell?.dataset.basemapRuntimeState === "healthy"
          && shell.__opengeoMap?.isStyleLoaded?.()
          && shell.__opengeoMap?.getSource?.("runtime-basemap-source");
      });
    } catch (error) {
      const diagnostic = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        runtimeState: shell.dataset.basemapRuntimeState,
        activationState: shell.dataset.basemapActivationState,
        styleLoaded: shell.__opengeoMap?.isStyleLoaded?.() ?? false,
        expectedBasemapSource: Boolean(shell.__opengeoMap?.getSource?.("runtime-basemap-source")),
        actualSources: Object.keys(shell.__opengeoMap?.getStyle?.().sources ?? {})
      }));
      throw new Error(`runtime basemap did not reach a healthy loaded state: ${JSON.stringify(diagnostic)}`, {cause: error});
    }
    try {
      await page.waitForFunction(() => {
        const shell = document.querySelector(".opengeo-workbench");
        return shell?.__opengeoLayers?.length >= 2
          && shell.__opengeoLayers.every((layer) => shell.__opengeoMap.getSource(`${layer.layerId}-source`));
      });
    } catch (error) {
      const diagnostic = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        expectedProjectSources: shell.__opengeoLayers?.map(({layerId}) => ({
          layerId,
          present: Boolean(shell.__opengeoMap?.getSource?.(`${layerId}-source`))
        })) ?? [],
        projectLayers: shell.__opengeoLayers?.map(({layerId, sourceType}) => ({layerId, sourceType})) ?? [],
        loadedData: [...(shell.__opengeoData?.keys?.() ?? [])],
        actualSources: Object.keys(shell.__opengeoMap?.getStyle?.().sources ?? {})
      }));
      throw new Error(`project layers did not hydrate before runtime outage testing: ${JSON.stringify(diagnostic)}`, {cause: error});
    }
    if (await page.locator(".opengeo-workbench").getAttribute("data-color-mode") !== colorScheme) {
      await page.getByRole("button", {name: colorScheme === "light" ? "Light" : "Dark", exact: true}).click();
    }

    await page.getByRole("button", {name: "Project", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Save to browser draft"}).click();
    const savedBefore = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
      return key ? localStorage.getItem(key) : null;
    });
    if (!savedBefore) failures.push(`${route}: runtime recovery acceptance could not establish a saved baseline`);

    await page.locator(".opengeo-workbench").evaluate((shell) => {
      const layerSourceId = `${shell.__opengeoLayers[0].layerId}-source`;
      shell.__opengeoMap.fire({
        type: "error",
        sourceId: layerSourceId,
        error: new Error("deterministic project-layer failure")
      });
    });
    await page.waitForTimeout(100);
    if (await page.locator(".opengeo-workbench").getAttribute("data-basemap-runtime-state") !== "healthy") {
      failures.push(`${route}: a project-layer error was incorrectly attributed to the basemap`);
    }

    const compositionBefore = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      center: shell.__opengeoMap.getCenter().toArray(),
      zoom: shell.__opengeoMap.getZoom(),
      pitch: shell.__opengeoMap.getPitch(),
      bearing: shell.__opengeoMap.getBearing(),
      layers: shell.__opengeoLayers.map(({layerId, title, order}) => ({layerId, title, order})),
      styleName: shell.__opengeoMap.getStyle().name
    }));
    runtimeTileOutage = true;
    await page.locator(".opengeo-workbench").evaluate((shell) => {
      shell.__opengeoMap.getSource("runtime-basemap-source").setTiles([
        "https://runtime-basemap.example.test/{z}/{x}/{y}.png?outage=1"
      ]);
    });
    await page.locator('.opengeo-workbench[data-basemap-runtime-state="outage"]').waitFor({timeout: 8_000});
    const alert = page.locator('.gis-basemap-runtime-alert[data-runtime-state="outage"]');
    await alert.waitFor();
    const alertText = await alert.innerText();
    if (!alertText.includes("Positron has 3 recent map-tile failures")
      || !alertText.includes("Project layers and map position remain available")
      || !alertText.includes("saved basemap has not changed")) {
      failures.push(`${route}: post-activation outage did not explain retained map state`);
    }
    for (const action of ["Retry Positron", "Keep current", "Change basemap"]) {
      if (await alert.getByRole("button", {name: action, exact: true}).count() !== 1) {
        failures.push(`${route}: post-activation outage did not expose ${action}`);
      }
    }
    if (outageTileRequests < 3) {
      failures.push(`${route}: runtime outage state was reached without three failed tile requests`);
    }
    const retainedComposition = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      center: shell.__opengeoMap.getCenter().toArray(),
      zoom: shell.__opengeoMap.getZoom(),
      pitch: shell.__opengeoMap.getPitch(),
      bearing: shell.__opengeoMap.getBearing(),
      layers: shell.__opengeoLayers.map(({layerId, title, order}) => ({layerId, title, order})),
      layerSourcesReady: shell.__opengeoLayers.every((layer) => shell.__opengeoMap.getSource(`${layer.layerId}-source`)),
      styleName: shell.__opengeoMap.getStyle().name
    }));
    if (JSON.stringify(retainedComposition.layers) !== JSON.stringify(compositionBefore.layers)
      || retainedComposition.styleName !== compositionBefore.styleName
      || !retainedComposition.layerSourcesReady
      || Math.abs(retainedComposition.center[0] - compositionBefore.center[0]) > 0.0001
      || Math.abs(retainedComposition.center[1] - compositionBefore.center[1]) > 0.0001
      || Math.abs(retainedComposition.zoom - compositionBefore.zoom) > 0.0001
      || Math.abs(retainedComposition.pitch - compositionBefore.pitch) > 0.0001
      || Math.abs(retainedComposition.bearing - compositionBefore.bearing) > 0.0001) {
      failures.push(`${route}: runtime outage changed project layers, camera, or active style`);
    }
    const savedDuringOutage = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
      return key ? localStorage.getItem(key) : null;
    });
    if (savedDuringOutage !== savedBefore) {
      failures.push(`${route}: detecting an active basemap outage wrote project state`);
    }
    await assertReadable(page, `${route} ${colorScheme} basemap outage`);
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `basemap-runtime-outage-${colorScheme}.png`),
        fullPage: true
      });
    }

    await page.setViewportSize({width: 390, height: 844});
    await page.locator(".opengeo-workbench.left-collapsed.right-collapsed").waitFor();
    await alert.waitFor();
    const phoneLayout = await alert.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const toolbarTop = document.querySelector(".gis-mobile-toolbar")?.getBoundingClientRect().top ?? innerHeight;
      const buttons = [...element.querySelectorAll("button")].map((button) => {
        const bounds = button.getBoundingClientRect();
        return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: bounds.height};
      });
      return {left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom, toolbarTop, buttons};
    });
    if (phoneLayout.left < -1 || phoneLayout.right > 391 || phoneLayout.top < -1 || phoneLayout.bottom > 845
      || phoneLayout.bottom > phoneLayout.toolbarTop + 1
      || phoneLayout.buttons.some(({height}) => height < 43.5)) {
      failures.push(`${route}: runtime recovery controls escaped the phone viewport or lost 44-pixel targets (${JSON.stringify(phoneLayout)})`);
    }
    const closeProjectContents = page.getByRole("button", {name: "Close project contents", exact: true});
    if (await closeProjectContents.count() === 1) await closeProjectContents.click();
    await alert.getByRole("button", {name: "Keep current", exact: true}).click();
    const retainedAlert = page.locator('.gis-basemap-runtime-alert[data-runtime-state="retained"]');
    await retainedAlert.waitFor();
    const retainedText = await retainedAlert.innerText();
    if (!retainedText.includes("background may be incomplete")
      || !retainedText.includes("saved basemap remain unchanged")) {
      failures.push(`${route}: Keep current did not retain a visible incomplete-map explanation: ${JSON.stringify(retainedText)}`);
    }
    if (screenshotsEnabled && colorScheme === "dark") {
      await page.screenshot({
        path: join(artifactRoot, "basemap-runtime-retained-phone-dark.png"),
        fullPage: true
      });
    }
    runtimeStyleOutage = true;
    await page.getByRole("button", {name: "Retry Positron", exact: true}).click();
    // The product transition is bounded at eight seconds. Give the clean-runner
    // assertion time to observe the user-visible recovery result scheduled
    // immediately after that bound. Activation state is diagnostic metadata;
    // the retained-map alert is the recovery contract presented to the user.
    const failedRetryAlert = page.locator('.gis-basemap-runtime-alert[data-runtime-state="outage"]')
      .filter({hasText: "did not pass the retry check"});
    try {
      await failedRetryAlert.waitFor({timeout: 20_000});
    } catch (error) {
      const diagnostic = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        activationState: shell.dataset.basemapActivationState,
        runtimeState: shell.dataset.basemapRuntimeState,
        runtimeFailures: shell.dataset.basemapRuntimeFailures,
        alert: document.querySelector(".gis-basemap-runtime-alert")?.textContent ?? null
      }));
      throw new Error(
        `Failed basemap retry did not reach the retained-map alert: ${JSON.stringify({retryStyleRequests, ...diagnostic})}`,
        {cause: error}
      );
    }
    const failedRetryActivationState = await page.locator(".opengeo-workbench")
      .getAttribute("data-basemap-activation-state");
    if (failedRetryActivationState !== "failed") {
      failures.push(`${route}: a failed retry did not complete its isolated activation check`);
    }
    if (!await failedRetryAlert.innerText().then((text) => text.includes("did not pass the retry check"))) {
      failures.push(`${route}: a failed retry did not retain the current map with an explicit explanation`);
    }
    runtimeStyleOutage = false;
    runtimeTileOutage = false;
    await page.getByRole("button", {name: "Retry Positron", exact: true}).click();
    await page.locator('.opengeo-workbench[data-basemap-runtime-state="healthy"][data-basemap-activation-state="active"]').waitFor({timeout: 12_000});
    if (await page.locator(".gis-basemap-runtime-alert").count() !== 0) {
      failures.push(`${route}: successful retry left a stale outage notice`);
    }
    await page.waitForFunction(() => {
      const shell = document.querySelector(".opengeo-workbench");
      return shell?.__opengeoMap?.isStyleLoaded?.()
        && shell.__opengeoLayers.every((layer) => shell.__opengeoMap.getSource(`${layer.layerId}-source`));
    });
    await page.setViewportSize({width: 1440, height: 950});
    await page.locator(".opengeo-workbench").scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const compositionAfter = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      center: shell.__opengeoMap.getCenter().toArray(),
      zoom: shell.__opengeoMap.getZoom(),
      pitch: shell.__opengeoMap.getPitch(),
      bearing: shell.__opengeoMap.getBearing(),
      layers: shell.__opengeoLayers.map(({layerId, title, order}) => ({layerId, title, order})),
      styleName: shell.__opengeoMap.getStyle().name
    }));
    if (JSON.stringify(compositionAfter) !== JSON.stringify(compositionBefore)) {
      failures.push(`${route}: successful active-basemap retry did not restore the exact composition and camera`);
    }
    const savedAfterRecovery = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
      return key ? localStorage.getItem(key) : null;
    });
    if (savedAfterRecovery !== savedBefore) {
      failures.push(`${route}: retrying the exact active basemap wrote project state without Save`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, `basemap-runtime-recovered-${colorScheme}.png`),
        fullPage: true
      });
    }
    await context.close();
  }
}

async function assertBasemapResourceFeedback(browser, baseUrl) {
  const resourceContext = await browser.newContext({colorScheme: "dark", viewport: {width: 1280, height: 820}});
  let failUpdatedSprite = false;
  await resourceContext.route("https://tiles.openfreemap.org/styles/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      version: 8,
      name: "Resource-specific background fixture",
      glyphs: "https://runtime-resources.example.test/fonts/{fontstack}/{range}.pbf",
      sprite: "https://runtime-resources.example.test/original-sprite",
      sources: {
        "runtime-resource-source": {
          type: "raster",
          tiles: ["https://runtime-resources.example.test/tiles/{z}/{x}/{y}.png"],
          tileSize: 256,
          minzoom: 0,
          maxzoom: 22,
          bounds: [-180, -85, 180, 85]
        }
      },
      layers: [{id: "runtime-resource-layer", type: "raster", source: "runtime-resource-source"}]
    })
  }));
  await resourceContext.route("https://runtime-resources.example.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (failUpdatedSprite && pathname.includes("updated-sprite")) {
      await route.fulfill({status: 503, contentType: "text/plain", body: "deterministic optional sprite failure"});
    } else if (pathname.endsWith(".json")) {
      await route.fulfill({status: 200, contentType: "application/json", body: "{}"});
    } else {
      await route.fulfill({status: 200, contentType: "image/png", body: basemapTileBytes});
    }
  });
  const resourcePage = await resourceContext.newPage();
  capturePageErrors(resourcePage, "basemap resource-specific feedback");
  await visit(
    resourcePage,
    `${baseUrl}${fixtureProjectRoute}`,
    `${fixtureProjectRoute} basemap resource-specific feedback`
  );
  await resourcePage.locator('.opengeo-workbench[data-basemap-runtime-state="healthy"]').waitFor();
  const savedBefore = await resourcePage.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
    return key ? localStorage.getItem(key) : null;
  });
  failUpdatedSprite = true;
  await resourcePage.locator(".opengeo-workbench").evaluate((shell) => {
    shell.__opengeoMap.setSprite("https://runtime-resources.example.test/updated-sprite?key=must-not-appear");
  });
  await resourcePage.locator('.opengeo-workbench[data-basemap-runtime-state="incomplete"][data-basemap-runtime-resources*="sprite"]').waitFor();
  let resourceAlert = resourcePage.locator('.gis-basemap-runtime-alert[data-runtime-state="incomplete"]');
  if (!await resourceAlert.innerText().then((text) => (
    text.includes("Background partly available")
      && text.includes("Map symbols")
      && text.includes("some icons may be missing")
      && !text.includes("must-not-appear")
      && !text.includes("runtime-resources.example.test")
  ))) {
    failures.push(`${fixtureProjectRoute}: sprite failure did not produce redacted partial-resource feedback`);
  }
  await resourcePage.locator(".opengeo-workbench").evaluate((shell) => {
    shell.__opengeoMap.fire({
      type: "error",
      resourceType: "Glyphs",
      error: {
        message: "deterministic glyph range failure with token=must-not-appear",
        url: "https://runtime-resources.example.test/fonts/Open%20Sans/0-255.pbf?token=must-not-appear"
      }
    });
  });
  await resourcePage.locator('.opengeo-workbench[data-basemap-runtime-resources*="glyph"]').waitFor();
  resourceAlert = resourcePage.locator('.gis-basemap-runtime-alert[data-runtime-state="incomplete"]');
  if (!await resourceAlert.innerText().then((text) => (
    text.includes("Labels")
      && text.includes("supported characters can still render locally")
      && !text.includes("token=")
  ))) {
    failures.push(`${fixtureProjectRoute}: glyph failure did not produce redacted fallback feedback`);
  }
  if (await resourcePage.locator(".opengeo-workbench").getAttribute("data-basemap-runtime-state") === "outage") {
    failures.push(`${fixtureProjectRoute}: optional sprite or glyph failures escalated to a whole-background outage`);
  }
  if (savedBefore !== await resourcePage.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.project."));
    return key ? localStorage.getItem(key) : null;
  })) {
    failures.push(`${fixtureProjectRoute}: resource-specific feedback wrote project state without Save`);
  }
  await assertReadable(resourcePage, `${fixtureProjectRoute} partial background resources`);
  await assertWorkbenchLayoutConflicts(
    resourcePage,
    `${fixtureProjectRoute} partial background resources`,
    1280,
    "dark"
  );
  if (screenshotsEnabled) {
    await resourcePage.screenshot({
      path: join(artifactRoot, "basemap-resource-partial-dark.png"),
      fullPage: true
    });
  }
  await resourceContext.close();

  const coverageContext = await browser.newContext({colorScheme: "light", viewport: {width: 1280, height: 820}});
  await coverageContext.route("https://tiles.openfreemap.org/styles/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      version: 8,
      name: "Declared regional coverage fixture",
      sources: {
        "regional-background-source": {
          type: "raster",
          tiles: ["https://regional-coverage.example.test/{z}/{x}/{y}.png"],
          tileSize: 256,
          minzoom: 4,
          maxzoom: 12,
          bounds: [10, 10, 20, 20]
        }
      },
      layers: [{id: "regional-background-layer", type: "raster", source: "regional-background-source"}]
    })
  }));
  await coverageContext.route("https://regional-coverage.example.test/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: basemapTileBytes
  }));
  const coveragePage = await coverageContext.newPage();
  capturePageErrors(coveragePage, "basemap declared coverage feedback");
  await visit(
    coveragePage,
    `${baseUrl}${fixtureProjectRoute}`,
    `${fixtureProjectRoute} basemap declared coverage feedback`
  );
  if (await coveragePage.locator(".opengeo-workbench").getAttribute("data-color-mode") !== "light") {
    await coveragePage.getByRole("button", {name: "Light", exact: true}).click();
  }
  await coveragePage.locator('.opengeo-workbench[data-basemap-runtime-state="incomplete"][data-basemap-runtime-resources="coverage"]').waitFor();
  const coverageAlert = coveragePage.locator('.gis-basemap-runtime-alert[data-runtime-state="incomplete"]');
  if (!await coverageAlert.innerText().then((text) => (
    text.includes("Coverage") && text.includes("do not cover the current view")
  ))) {
    failures.push(`${fixtureProjectRoute}: declared geographic extent did not explain the current coverage gap`);
  }
  if (await coverageAlert.getByRole("button", {name: /^Retry /}).count() !== 0) {
    failures.push(`${fixtureProjectRoute}: declarative coverage feedback offered a misleading network retry`);
  }
  await assertWorkbenchLayoutConflicts(
    coveragePage,
    `${fixtureProjectRoute} declared coverage`,
    1280,
    "light"
  );
  if (screenshotsEnabled) {
    await coveragePage.screenshot({
      path: join(artifactRoot, "basemap-resource-coverage-light.png"),
      fullPage: true
    });
  }
  await coveragePage.locator(".opengeo-workbench").evaluate((shell) => {
    shell.__opengeoMap.jumpTo({center: [15, 15], zoom: 14});
  });
  await coveragePage.locator('.opengeo-workbench[data-basemap-runtime-state="limited"]').waitFor();
  const limitAlert = coveragePage.locator('.gis-basemap-runtime-alert[data-runtime-state="limited"]');
  if (!await limitAlert.innerText().then((text) => (
    text.includes("Background detail limit")
      && text.includes("published maximum detail")
      && text.includes("may appear enlarged")
  ))) {
    failures.push(`${fixtureProjectRoute}: declared maximum zoom did not produce precise detail-limit feedback`);
  }
  await coveragePage.locator(".opengeo-workbench").evaluate((shell) => {
    shell.__opengeoMap.jumpTo({center: [15, 15], zoom: 6});
  });
  await coveragePage.locator('.opengeo-workbench[data-basemap-runtime-state="healthy"]').waitFor();
  if (await coveragePage.locator(".gis-basemap-runtime-alert").count() !== 0) {
    failures.push(`${fixtureProjectRoute}: coverage feedback did not clear after returning to supported extent and zoom`);
  }
  await coverageContext.close();
}

async function assertProjectDirectory(page, route) {
  await page.locator('.composition-directory[data-state="ready"]').waitFor();
  const navigation = page.getByRole("navigation", {name: "Studio navigation", exact: true});
  const destinations = await navigation.getByRole("link").allTextContents();
  if (JSON.stringify(destinations) !== JSON.stringify([
    "OpenGeo Studio", "Home", "Projects", "Catalog", "Styles", "Geographic tags", "Collections", "Publications"
  ])) {
    failures.push(`${route}: shared Studio destinations were incomplete (${JSON.stringify(destinations)})`);
  }
  if (await navigation.locator('[aria-current="page"]').innerText() !== "Projects") {
    failures.push(`${route}: project destination was not identified as current`);
  }
  if (await page.locator(".platform-directory-action").count() !== 1) {
    failures.push(`${route}: expected one focused New Project action`);
  }
  if (await page.locator(".platform-directory-advanced").count() !== 0) {
    failures.push(`${route}: project selection retained buried account administration panels`);
  }
  await expectText(page, "New Project", "durable OpenGeo Project creation entry");
  if (await page.getByRole("link", {name: /^Open project$/}).count() !== 0) {
    failures.push(`${route}: project directory retained an arbitrary generic Open project shortcut`);
  }
  const projectLinks = page.locator('.composition-directory tbody tr[data-composition-id] td:first-child > a').filter({hasNotText: "Related publications"});
  if (await projectLinks.count() === 0) {
    failures.push(`${route}: no authored Project activation targets were rendered`);
  } else {
    const firstProject = projectLinks.first();
    if (!/^\/workspaces\?composition=/.test(await firstProject.getAttribute("href") ?? "")) {
      failures.push(`${route}: authored Project does not target its persistent composition identity`);
    }
    await firstProject.focus();
    if (!await firstProject.evaluate(element => element === document.activeElement && element.tabIndex === 0)) {
      failures.push(`${route}: authored Project link cannot receive keyboard focus`);
    }
  }
  const layout = await page.locator(".platform-directory-actions").evaluate((container) => {
    const rectangles = [...container.querySelectorAll(".platform-directory-action")]
      .map((element) => element.getBoundingClientRect());
    const overlaps = rectangles.some((left, index) => rectangles.slice(index + 1).some(
      (right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
        && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
    ));
    return {overlaps, overflow: container.scrollWidth - container.clientWidth};
  });
  if (layout.overlaps || layout.overflow > 1) {
    failures.push(`${route}: project actions overlap or overflow (${JSON.stringify(layout)})`);
  }
  const projectLayout = await page.locator(".composition-directory").evaluate((directory) => {
    const bounds = directory.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      left: bounds.left,
      right: bounds.right,
      // The table scrolls inside its own container on narrow screens.
      scrollable: getComputedStyle(directory).overflowX === "auto"
    };
  });
  if (projectLayout.documentOverflow > 1 || projectLayout.left < -1
    || projectLayout.right > page.viewportSize().width + 1 || !projectLayout.scrollable) {
    failures.push(`${route}: authored Projects escape their responsive scroll container (${JSON.stringify(projectLayout)})`);
  }
  const accountMenu = page.locator(".platform-account-menu");
  const accountSummary = accountMenu.locator(":scope > summary");
  await accountSummary.focus();
  await page.keyboard.press("Enter");
  if (!await accountMenu.evaluate(menu => menu.open)) {
    failures.push(`${route}: account settings did not open from the keyboard`);
  }
  await page.keyboard.press("Escape");
  if (!await accountMenu.evaluate(menu => !menu.open && document.activeElement === menu.querySelector("summary"))) {
    failures.push(`${route}: account settings did not close and restore keyboard focus`);
  }
  await navigation.getByRole("link", {name: "Catalog", exact: true}).click();
  await page.getByRole("heading", {name: "Catalog", exact: true}).waitFor();
  try {
    await page.locator(".platform-catalog-table").first().waitFor();
  } catch (error) {
    const catalogState = await page.locator(".platform-catalog-search").evaluate((catalog) => ({
      feedback: catalog.querySelector(".platform-note")?.textContent ?? null,
      forms: catalog.querySelectorAll("form").length,
      url: location.href
    })).catch(() => null);
    throw new Error(`Catalog did not finish loading: ${JSON.stringify(catalogState)}`, {cause: error});
  }
  await expectText(page, "Access Road Network", "first-class authorized data catalog");
  await page.locator(".platform-account-menu > summary").click();
  await page.getByRole("navigation", {name: "Account settings", exact: true})
    .getByRole("link", {name: "Connections", exact: true}).click();
  await page.getByRole("heading", {name: "Connections", exact: true}).waitFor();
  if (await page.locator("#connections[open]").count() !== 1) {
    failures.push(`${route}: Connections did not open the reusable connection interface directly`);
  }
  await expectText(page, "s3://example-geodata/", "reusable fixture S3 target");
  await page.locator(".platform-connection-record").first().locator("summary").click();
  await expectText(page, "Live S3 verification", "truthful unverified connection disclosure");
  await page.getByRole("navigation", {name: "Account settings", exact: true})
    .getByRole("link", {name: "Teams", exact: true}).click();
  await page.getByRole("heading", {name: "Account teams", exact: true}).waitFor();
  if (await page.locator("#teams[open]").count() !== 1) {
    failures.push(`${route}: Teams did not open account membership administration directly`);
  }
  await expectText(page, "A person can belong to a team without gaining any project access.", "team membership does not grant project access");
  await expectText(page, "A project owner separately grants that team an owner, editor, reviewer, or viewer role.", "explicit resource grant scope");
  if (await page.locator("#teams .platform-compact-record").count() === 0
    || await page.locator("#teams").getByRole("button", {name: "Create team", exact: true}).count() !== 1
    || await page.locator(".platform-project-directory").count() !== 0) {
    failures.push(`${route}: account team records or administrator controls were missing or mixed with access-container administration`);
  }
  await navigation.getByRole("link", {name: "Publications", exact: true}).click();
  await page.getByRole("heading", {name: "Publications", exact: true}).waitFor();
  await expectText(page, "New publication", "durable publication creation entry");
  await navigation.getByRole("link", {name: "Projects", exact: true}).focus();
  await page.keyboard.press("Enter");
  await page.locator('.composition-directory[data-state="ready"]').waitFor();
  if (await navigation.locator('[aria-current="page"]').innerText() !== "Projects") {
    failures.push(`${route}: keyboard return did not restore Projects navigation`);
  }
}

async function assertGovernedRegionalBasemapWorkflow(page, route, {projectId, mapId}) {
  browserRegionalBasemapRequests.length = 0;
  await page.getByRole("button", {name: /Background · /}).click();
  let dialog = page.getByRole("dialog", {name: "Change basemap"});
  await dialog.waitFor();
  await dialog.locator(".gis-basemap-source-tools > summary").click();
  const regionalForm = dialog.locator(".gis-basemap-source-tools .gis-editor-section").first();
  await regionalForm.getByLabel("Name").fill("Mountain district imagery");
  await regionalForm.getByLabel("XYZ tile URL")
    .fill("https://regional.example.test/{z}/{x}/{y}.png");
  await regionalForm.getByLabel("Attribution").fill("Example mapping agency");
  await regionalForm.getByLabel("License or terms reference").fill("CC-BY-4.0");
  await regionalForm.getByLabel("Coverage · west, south, east, north").fill("80, 26, 89, 31");
  await regionalForm.getByRole("button", {name: "Register and use basemap"}).click();

  dialog = page.getByRole("dialog", {name: "Change basemap"});
  const regionalCard = dialog.locator(
    '.gis-basemap-card[aria-pressed="true"]',
    {hasText: "Mountain district imagery"}
  );
  try {
    await regionalCard.waitFor();
  } catch (error) {
    const status = await page.locator(".gis-statusbar strong")
      .innerText()
      .catch(() => "status unavailable");
    throw new Error(
      `governed regional basemap was not selected; current status: ${status}`,
      {cause: error}
    );
  }
  const feedback = await dialog.getByRole("status").innerText();
  if (!feedback.includes("governed revision 1") || !feedback.includes("selected")) {
    failures.push(`${route}: governed regional source selection did not retain its revision feedback`);
  }
  await page.waitForFunction(() => Boolean(
    document.querySelector(".opengeo-workbench")?.__opengeoMap?.getSource("basemap")
  ));
  if (!browserRegionalBasemapRequests.length) {
    failures.push(`${route}: selected governed regional basemap issued no browser tile request`);
  }

  await dialog.getByRole("button", {name: "Done"}).click();
  lastMapUpdate = null;
  await page.getByRole("button", {name: "Save", exact: true}).click();
  await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
  const saved = lastMapUpdate?.definition?.basemaps?.find(({visible}) => visible);
  if (
    saved?.kind !== "governed-raster"
    || saved?.datasetId !== IDS.regionalSourceDataset
    || saved?.sourceType !== "xyz-raster"
    || saved?.sourceVersion !== 1
    || saved?.sourceUrl !== "https://regional.example.test/{z}/{x}/{y}.png"
    || saved?.sourceConfiguration?.presentationRole !== "regional_basemap"
    || saved?.sourceConfiguration?.license !== "CC-BY-4.0"
    || saved?.sourceConfiguration?.coordinateBehavior !== "wgs84_web_mercator"
    || JSON.stringify(saved?.sourceConfiguration?.coverageBounds) !== "[80,26,89,31]"
    || saved?.attribution !== "Example mapping agency"
  ) {
    failures.push(`${route}: saved regional basemap did not retain the exact governed source snapshot (${JSON.stringify(saved)})`);
  }
  const stored = browserMapOverrides.get(`${projectId}:${mapId}`)?.definition?.basemaps?.find(
    ({visible}) => visible
  );
  if (JSON.stringify(stored) !== JSON.stringify(saved)) {
    failures.push(`${route}: regional basemap was not committed to the authoritative project map`);
  }
}

async function assertPlanetaryProjectWorkflow(page, route, {projectId, mapId}) {
  const projectRoute = `/workspaces?project=${projectId}&map=${mapId}`;
  await page.getByRole("button", {name: /Background · /}).click();
  let dialog = page.getByRole("dialog", {name: "Change basemap"});
  await dialog.locator('[data-catalog-group="moon"] > summary').click();
  const lunarCanvas = dialog.locator(
    '.gis-basemap-card[data-catalog-id="planetary-blank-moon"]'
  );
  if (await lunarCanvas.getAttribute("data-unavailable") !== null) {
    failures.push(`${route}: empty project did not offer the network-free lunar canvas`);
  }
  await lunarCanvas.click();
  await page.locator('.opengeo-workbench[data-spatial-body="moon"]').waitFor();
  if (await dialog.locator("[data-basemap-current]").innerText() !== "Blank lunar map"
    || !await dialog.innerText().then((text) => text.includes("Moon"))) {
    failures.push(`${route}: lunar selection did not update the chooser's current project context`);
  }
  await dialog.getByRole("button", {name: "Done"}).click();

  await page.getByRole("button", {name: "Measure", exact: true}).click();
  await page.locator(".gis-panel-right").getByRole("button", {name: "Line", exact: true}).click();
  const canvas = page.locator(".gis-map .maplibregl-canvas");
  await canvas.click({position: {x: 420, y: 320}});
  await canvas.click({position: {x: 560, y: 320}});
  await page.locator(".gis-statusbar strong").filter({hasText: "on Moon"}).waitFor();
  await page.locator(".gis-measurement-guide").getByRole("button", {name: "Cancel", exact: true}).click();

  lastMapUpdate = null;
  await page.getByRole("button", {name: "Save", exact: true}).click();
  await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
  const saved = lastMapUpdate?.definition;
  const expectedBody = spatialBodyDefinition("moon");
  const savedCanvas = saved?.basemaps?.find(({visible}) => visible);
  if (JSON.stringify(saved?.spatialBody) !== JSON.stringify(expectedBody)
    || savedCanvas?.kind !== "planetary-blank"
    || savedCanvas?.spatialBodyId !== "moon"
    || savedCanvas?.basemapId !== "planetary-blank-moon"
    || /url|endpoint|token|credential/i.test(JSON.stringify(savedCanvas))) {
    failures.push(`${route}: saved Moon project was not an exact network-free spatial-body record (${JSON.stringify(saved)})`);
  }
  const stored = browserMapOverrides.get(`${projectId}:${mapId}`)?.definition;
  if (JSON.stringify(stored?.spatialBody) !== JSON.stringify(expectedBody)
    || stored?.basemaps?.[0]?.basemapId !== "planetary-blank-moon") {
    failures.push(`${route}: Moon project did not reach the authoritative fixture map store`);
  }

  await visit(page, `${new URL(page.url()).origin}${projectRoute}`, `${route} lunar reopen`);
  await page.locator('.opengeo-workbench[data-spatial-body="moon"]').waitFor();
  await page.getByRole("button", {name: /Background · Blank lunar map/}).click();
  dialog = page.getByRole("dialog", {name: "Change basemap"});
  await dialog.locator(
    '.gis-basemap-card[data-catalog-id="planetary-blank-moon"][aria-pressed="true"]'
  ).waitFor();

  await dialog.locator(".gis-basemap-card", {has: page.getByText("Fiord", {exact: true})}).click();
  await page.locator('.opengeo-workbench[data-spatial-body="earth"]').waitFor();
  await dialog.getByRole("button", {name: "Done"}).click();
  lastMapUpdate = null;
  await page.getByRole("button", {name: "Save", exact: true}).click();
  await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
  if (lastMapUpdate?.definition?.spatialBody?.id !== "earth") {
    failures.push(`${route}: empty lunar project could not intentionally return to an Earth basemap`);
  }
}

async function assertWorkbenchInteractions(page, route, colorScheme) {
  resetBrowserAuthoringState();
  const mapUrl = new URL(page.url());
  if (mapUrl.searchParams.get("adapter") === "fixture") {
    await page.evaluate((organizationId) => {
      sessionStorage.setItem("opengeo.accessToken", "browser.test.token");
      sessionStorage.setItem("opengeo.accessTokenExpiresAt", String(Date.now() + 3_600_000));
      sessionStorage.setItem("opengeo.organizationId", organizationId);
    }, IDS.organization);
    mapUrl.searchParams.delete("adapter");
    mapUrl.searchParams.set("map", IDS.maps[0]);
  }
  const dataUrl = new URL(mapUrl);
  dataUrl.searchParams.set("manage", "data");
  dataUrl.hash = "project-data";
  await visit(page, dataUrl.href, `${route} project data`);
  await page.locator(".project-datasets").waitFor();
  const editableDataset = page.locator(".project-dataset-card", {
    hasText: "Access Road Network"
  });
  await editableDataset.getByRole("button", {name: "Edit features"}).click();
  try {
    await editableDataset.locator(".project-feature-editor").waitFor();
  } catch {
    throw new Error(
      `feature editor did not open: ${await editableDataset.innerText()}`
    );
  }
  const initializeCollection = editableDataset.getByRole("button", {
    name: "Create empty feature collection"
  });
  if (await initializeCollection.count()) {
    await initializeCollection.click();
    await editableDataset.locator(".project-feature-form").waitFor();
  }
  await editableDataset.getByText("Schema-driven properties").waitFor();
  const featureMap = editableDataset.locator(".project-feature-map");
  await featureMap.locator(".maplibregl-canvas").waitFor();
  await editableDataset.getByRole("button", {name: "Draw new"}).click();
  await featureMap.click({position: {x: 120, y: 120}});
  await featureMap.click({position: {x: 320, y: 190}});
  await editableDataset.getByRole("button", {name: "Finish geometry"}).click();
  await editableDataset.getByText("Geometry captured in the form").waitFor();
  await editableDataset.getByRole("button", {name: "Create feature"}).click();
  await editableDataset.locator(".project-feature-record").first().waitFor();
  const featureText = await editableDataset.innerText();
  if (!featureText.includes("generation 2") || !featureText.includes("v1")) {
    failures.push(`${route}: governed feature capture did not expose generation and version`);
  }
  if (screenshotsEnabled) {
    await editableDataset.screenshot({
      path: join(artifactRoot, `feature-editor-${colorScheme}.png`)
    });
  }

  await editableDataset.getByRole("button", {name: "Field capture"}).click();
  await editableDataset.getByText("Offline field capture and review").waitFor();
  await editableDataset.getByRole("button", {name: "Create version 1 form"}).click();
  await editableDataset.getByText(/form v1/).waitFor();
  await editableDataset.getByRole("button", {name: "Save to device queue"}).click();
  try {
    await editableDataset.getByText(/saved only on this device/).waitFor();
  } catch (error) {
    const renderedState = (await editableDataset.innerText()).replaceAll(/\s+/g, " ").trim();
    throw new Error(
      `${route}: offline field capture never exposed its durable queue/replay receipt; rendered dataset state: ${renderedState}`,
      {cause: error}
    );
  }
  await editableDataset.getByRole("button", {name: "Sync device queue"}).click();
  try {
    await editableDataset.getByRole("button", {name: "Start review"}).waitFor();
  } catch {
    throw new Error(
      `field-capture sync did not reach review: ${await editableDataset.innerText()}`
    );
  }
  await editableDataset.getByRole("button", {name: "Start review"}).click();
  await editableDataset.getByRole("button", {name: "Accept and promote"}).waitFor();
  await editableDataset.getByRole("button", {name: "Accept and promote"}).click();
  await editableDataset.getByText(/accepted · rv3/).waitFor();
  const captureText = await editableDataset.innerText();
  if (!captureText.includes("No access token is stored") || !captureText.includes("accepted · rv3")) {
    failures.push(`${route}: offline field capture did not retain auth boundary and review evidence`);
  }
  if (screenshotsEnabled) {
    await editableDataset.screenshot({
      path: join(artifactRoot, `field-capture-${colorScheme}.png`)
    });
  }
  await editableDataset.getByRole("button", {name: "Edit features"}).click();
  const featureView = editableDataset.locator('.project-dataset-inspection-view:not([hidden])');
  await featureView.getByText(/generation 2/).waitFor();
  // Switching views preserves the loaded editor and any unfinished draft.
  // Explicitly reload before checking the separately promoted field record.
  page.once("dialog", async (dialog) => {
    if (dialog.type() !== "confirm" || !dialog.message().includes("unsaved changes")) {
      failures.push(`${route}: reloading the feature editor did not explain draft discard`);
    }
    await dialog.accept();
  });
  await featureView.getByRole("button", {name: "Reload view", exact: true}).click();
  await featureView.getByText(/generation 3/).waitFor();
  if (await featureView.locator(".project-feature-record").count() !== 2) {
    failures.push(`${route}: accepted field submission did not promote one stable feature`);
  }

  await visit(page, mapUrl.href, `${route} map after data editing`);
  await page.locator(".opengeo-workbench").waitFor();
  await assertGovernedQueryWorkflow(page, route, colorScheme);

  const firstLayer = page.locator(".gis-layer-row").first();
  await firstLayer.getByRole("button", {name: /^Open layer properties for /}).click();
  await firstLayer.locator("summary[aria-label^='Layer actions for ']").click();
  await firstLayer.getByRole("button", {name: "Style layer"}).click();
  await page.getByLabel("Layer name").fill("Access roads renamed");
  await page.getByLabel("Layer name").press("Tab");
  let bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Access roads renamed")) failures.push(`${route}: layer name editor did not update the layer stack`);

  await page.getByRole("button", {name: "Derived palette"}).click();
  await page.getByLabel("Show labels on map").check();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Text size") || !bodyText.includes("Halo width")) failures.push(`${route}: label editor controls were not visible`);

  await page.getByRole("button", {name: "Project", exact: true}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Save to browser draft") || !bodyText.includes("Save authoritative map")) {
    failures.push(`${route}: Project menu did not expose save actions`);
  }
  if (!bodyText.includes("Open Project file…") || !bodyText.includes("Save as / export…")) {
    failures.push(`${route}: Project menu did not expose Project file interchange`);
  }
  await page.getByRole("menuitem", {name: /^Save as \/ export…/}).click();
  const projectExport = page.getByRole("dialog", {name: "Save as or export Project", exact: true});
  const formats = await projectExport.getByRole("combobox", {name: "Project export format"})
    .locator("option").evaluateAll(options => options.map(option => option.value));
  if (!["geolibre", "geomoose", "wmc", "png", "html"].every(format => formats.includes(format))) {
    failures.push(`${route}: Project export chooser did not expose the supported formats`);
  }
  if (!await projectExport.getByRole("button", {name: "Download conversion report", exact: true}).count()) {
    failures.push(`${route}: Project export chooser omitted the conversion report`);
  }
  await projectExport.getByRole("button", {name: "Close", exact: true}).click();

  await page.getByRole("button", {name: "Layer", exact: true}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Add data…") || !bodyText.includes("Layer properties")) {
    failures.push(`${route}: Layer menu did not expose GIS layer actions`);
  }
  await page.locator('.gis-menu-wrap[data-menu="layer"] .gis-menu-item', {hasText: "Layer properties"}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Layer identity")) failures.push(`${route}: Layer properties action did not open the inspector`);

  await page.getByRole("button", {name: "Polygon", exact: true}).click();
  const polygonGuide = page.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]');
  await polygonGuide.waitFor();
  const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
  await mapCanvas.click({position: {x: 180, y: 210}});
  await mapCanvas.click({position: {x: 360, y: 220}});
  await mapCanvas.click({position: {x: 300, y: 360}});
  await assertWorkbenchLayoutConflicts(page, route, 1440);
  if (screenshotsEnabled) {
    await page.locator(".opengeo-workbench").screenshot({
      path: join(artifactRoot, `workbench-polygon-authoring-${colorScheme}.png`)
    });
  }
  await mapCanvas.hover({position: {x: 181, y: 211}});
  if (await mapCanvas.evaluate((canvas) => canvas.style.cursor) !== "pointer") failures.push(`${route}: polygon closure cursor was not shown`);
  await mapCanvas.click({position: {x: 180, y: 210}});
  const polygonAuthoring = page.locator('.gis-places-editor[open]');
  await polygonAuthoring.waitFor();
  const polygonPositions = await page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoData.get("kml-places").features.find(({properties}) => properties.name === "Polygon").geometry.coordinates[0].map((point) => point.join(",")));
  if (polygonPositions.length !== 4 || polygonPositions[0] !== polygonPositions.at(-1)) {
    failures.push(`${route}: Polygon canvas command did not capture and close the drawn ring`);
  }
  await polygonAuthoring.locator('[data-kml-editing-field="name"]').fill("Unsaved polygon name");
  await polygonAuthoring.getByRole("button", {name: "Edit shape on map"}).click();
  const vertex = page.getByRole("button", {name: "Part 1 vertex 1", exact: true});
  await vertex.press("ArrowRight");
  if (await polygonAuthoring.locator('[data-kml-editing-field="name"]').inputValue() !== "Unsaved polygon name") failures.push(`${route}: geometry editing discarded metadata draft`);
  await page.getByRole("button", {name: "Finish shape editing"}).click();
  await polygonAuthoring.getByRole("button", {name: "Apply place edits"}).click();

  await checkDirectImageOverlay(page, route);
  const firstLayerOrder = page.locator(".gis-layer-row").first().locator(".gis-layer-order-controls");
  if (await firstLayerOrder.count() !== 1) {
    failures.push(`${route}: layer stack did not expose immediate up/down ordering controls`);
  }

  await page.getByRole("button", {name: "Change basemap"}).click();
  const basemapDialog = page.getByRole("dialog", {name: "Change basemap"});
  bodyText = await basemapDialog.innerText();
  if (!bodyText.includes("OpenFreeMap") || !bodyText.includes("Protomaps") || !bodyText.includes("Public and project sources")) {
    failures.push(`${route}: focused basemap chooser did not expose the progressive source catalog`);
  }
  await basemapDialog.getByRole("button", {name: "Close basemap chooser"}).click();

  await page.getByRole("button", {name: "Catalog"}).first().click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.toLowerCase().includes("workspace directory")) failures.push(`${route}: catalog panel did not expose workspace navigation`);
  if (!bodyText.includes("s3://dev.storage.opengeo.tools/dev/")) failures.push(`${route}: catalog panel did not expose AWS dev storage target`);

  await page.getByRole("button", {name: "Add Data", exact: true}).click();
  await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {hasText: "PMTiles layer"}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("PMTiles HTTPS URL")) failures.push(`${route}: PMTiles source form did not render`);

  await page.getByRole("button", {name: "Add Data", exact: true}).click();
  await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {hasText: "XYZ tile layer"}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Tile URL")) failures.push(`${route}: Add Data menu did not open the XYZ source panel`);

  await page.getByRole("button", {name: "Controls", exact: true}).click();
  await page.locator(".gis-menu-dropdown .gis-menu-item", {hasText: "Show graticule"}).click();
  bodyText = await page.locator("body").innerText();
  if (!bodyText.includes("Graticule enabled")) failures.push(`${route}: graticule control did not update workbench status`);

  await page.locator('.gis-menu-wrap[data-menu="controls"] > button').click();
  await page.getByRole("menuitem", {name: "Imagery history", exact: true}).click();
  const historyPanel = page.locator(".gis-panel-right .gis-history-panel");
  await historyPanel.waitFor();
  const historyText = await historyPanel.innerText();
  for (const expected of [
    "Imagery timeline",
    "MODIS Terra true color",
    "Before and after",
    "Sunlight guide",
    "Spatial pixel availability is not confirmed"
  ]) {
    if (!historyText.includes(expected)) failures.push(`${route}: historical imagery panel is missing ${expected}`);
  }
  await assertWorkbenchLayoutConflicts(page, route, 1440, colorScheme);

  await page.getByRole("button", {name: "Processing", exact: true}).click();
  await page.locator('.gis-menu-wrap[data-menu="processing"] .gis-menu-item', {hasText: "Create centroid layer"}).click();
  await page.getByRole("button", {name: "Run"}).click();
  const centroidRows = await page.locator(".gis-layer-row", {hasText: "centroids"}).count();
  if (!centroidRows) failures.push(`${route}: processing tool did not create a centroid layer`);
  const processingPanel = page.locator('.gis-panel-right .gis-panel-body[data-processing-tool="centroids"]');
  await processingPanel.waitFor();
  const processingPanelText = await processingPanel.innerText();
  if (await processingPanel.getAttribute("data-processing-registry") !== "opengeo.processing-registry.1.0.0"
    || await processingPanel.getAttribute("data-processing-tool-version") !== "1.0.0"
    || !processingPanelText.includes("browser-memory · tool 1.0.0 · registry opengeo.processing-registry.1.0.0")) {
    failures.push(`${route}: processing panel did not identify the exact bounded registry and tool version`);
  }
  const processingReceipt = processingPanel.locator('[data-processing-tool="centroids"][data-processing-status="success"]');
  if (await processingPanel.getAttribute("data-processing-history-count") !== "1"
    || await processingReceipt.count() !== 1
    || !processingPanelText.includes("Project processing history")
    || !processingPanelText.includes("Create centroid layer · success")) {
    failures.push(`${route}: successful browser processing did not create visible portable project history`);
  }

  const centroidRow = page.locator(".gis-layer-row", {hasText: "centroids"}).first();
  await centroidRow.locator(".gis-layer-more > summary").click();
  await centroidRow.getByRole("button", {name: "Remove"}).click();
  const remainingCentroidRows = await page.locator(".gis-layer-row", {hasText: "centroids"}).count();
  if (remainingCentroidRows) failures.push(`${route}: layer remove control did not update the layer stack`);

  await page.getByRole("button", {name: "Save", exact: true}).click();
  await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
}

async function assertGovernedQueryWorkflow(page, route, colorScheme) {
  await page.getByRole("button", {name: "Add data", exact: true}).click();
  const choice = page.locator(".gis-project-dataset-choice", {hasText: "Access Road Network"});
  await choice.locator('summary[aria-label="Editable feature collection for Access Road Network"]').click();
  await choice.getByRole("button", {
    name: "Add authoritative features for Access Road Network",
    exact: true
  }).click();
  const layer = page.locator(".gis-layer-row", {
    hasText: "Access Road Network · authoritative features"
  });
  await layer.waitFor();
  await page.getByRole("button", {name: "Query", exact: true}).click();
  const panel = page.locator('.gis-panel-right [data-query-state="draft"]');
  await panel.waitFor();
  await panel.getByLabel("Value").fill("value");

  const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
  await panel.getByRole("button", {name: "Select by point", exact: true}).click();
  await mapCanvas.click({position: {x: 310, y: 250}});
  const pointStep = panel.locator(".gis-query-step", {hasText: "Point selection"});
  await pointStep.waitFor();
  await pointStep.getByRole("button", {name: "Modify selection", exact: true}).click();
  await mapCanvas.click({position: {x: 320, y: 260}});
  if (await panel.locator(".gis-query-step", {hasText: "Point selection"}).count() !== 1) {
    failures.push(`${route}: modifying a point selection did not replace its reproducible query step`);
  }
  await panel.locator(".gis-query-step", {hasText: "Point selection"})
    .getByRole("button", {name: "Remove condition", exact: true}).click();

  await panel.getByRole("button", {name: "Select by line", exact: true}).click();
  await mapCanvas.click({position: {x: 260, y: 220}});
  await mapCanvas.click({position: {x: 380, y: 310}});
  const lineGuide = page.locator('.gis-query-drawing-guide[data-query-geometry="LineString"]');
  await lineGuide.getByRole("button", {name: "Finish selection", exact: true}).click();
  const lineStep = panel.locator(".gis-query-step", {hasText: "line selection"});
  await lineStep.waitFor();
  await lineStep.getByRole("button", {name: "Remove condition", exact: true}).click();

  await panel.getByRole("button", {name: "Select by polygon", exact: true}).click();
  await mapCanvas.click({position: {x: 240, y: 210}});
  await mapCanvas.click({position: {x: 390, y: 220}});
  await mapCanvas.click({position: {x: 330, y: 340}});
  const polygonGuide = page.locator('.gis-query-drawing-guide[data-query-geometry="Polygon"]');
  await assertWorkbenchLayoutConflicts(page, route, 1440, colorScheme);
  await polygonGuide.getByRole("button", {name: "Finish selection", exact: true}).click();
  const polygonStep = panel.locator(".gis-query-step", {hasText: "polygon or box selection"});
  await polygonStep.waitFor();
  await polygonStep.getByRole("button", {name: "Remove condition", exact: true}).click();

  await panel.getByRole("button", {name: "Run query", exact: true}).click();
  const results = page.locator('.gis-panel-right [data-query-state="ready"]');
  await results.getByText("2 of 2 matching features at generation 3.").waitFor();
  const receiptText = await results.locator(".gis-query-receipt").innerText();
  if (!/SHA-256 [0-9a-f]{64}/.test(receiptText)) {
    failures.push(`${route}: governed query did not expose its exact parameter receipt`);
  }
  if (await results.locator(".gis-query-result-table tbody tr").count() !== 2) {
    failures.push(`${route}: governed query did not render its bounded result table`);
  }
  await results.locator(".gis-query-result-table tbody tr").first().click();
  const linked = await page.locator(".opengeo-workbench").evaluate((shell) => {
    const source = shell.__opengeoMap?.getSource("opengeo-query-result-source");
    return source?._data?.geojson?.features?.filter(
      (feature) => feature.properties?.opengeoQuerySelected === true
    ).length ?? 0;
  });
  if (linked !== 1) {
    failures.push(`${route}: selecting a query table row did not select the same map feature`);
  }

  const csvDownload = page.waitForEvent("download");
  await results.getByRole("button", {name: "Download CSV", exact: true}).click();
  const csv = await csvDownload;
  const csvPath = await csv.path();
  const csvText = csvPath ? await readFile(csvPath, "utf8") : "";
  if (csv.suggestedFilename() !== "access-road-network-authoritative-features-query.csv"
    || !csvText.startsWith('"feature_id","feature_version","geometry_type","name"\r\n')
    || csvText.trimEnd().split("\r\n").length !== 3) {
    failures.push(`${route}: bounded query CSV was not deterministic (${csv.suggestedFilename()})`);
  }

  await page.setViewportSize({width: 390, height: 900});
  await assertWorkbenchLayoutConflicts(page, route, 390, colorScheme);
  await assertReadable(page, `${route} governed query ${colorScheme}`);
  await page.setViewportSize({width: 1440, height: 950});
}

async function assertGeoMooseQueryWorkflow(browser, baseUrl) {
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const receipt = await geoMooseSavedQueryReceipt();
  const viewports = [
    {label: "desktop 1440×950", width: 1440, height: 950, compact: false},
    {label: "phone 390×844", width: 390, height: 844, compact: true},
    {label: "short landscape 844×390", width: 844, height: 390, compact: true}
  ];

  for (const colorScheme of ["dark", "light"]) {
    installGeoMooseQueryMap(colorScheme);
    browserGeoMooseQueryRequests.length = 0;
    browserGeoMooseDelayedQueryResponses = 2;
    browserExpectedFeatureQueryAborts = 2;
    await withPlatformPage(browser, baseUrl, {
      token: "browser.test.token",
      colorScheme,
      viewport: {width: viewports[0].width, height: viewports[0].height},
      hasTouch: true
    }, async (page) => {
      const label = `GeoMoose query ${colorScheme}`;
      capturePageErrors(page, label);
      await visit(page, `${baseUrl}${route}`, label);
      const workbench = page.locator(".opengeo-workbench");
      const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
      await workbench.waitFor();
      await mapCanvas.waitFor();
      await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());
      await page.locator('.gis-layer-row[data-layer-id="geomoose-water-quality"]').waitFor();
      await page.locator('.gis-layer-row[data-layer-id="geomoose-priority-habitat"]').waitFor();
      await page.waitForFunction(() => {
        const shell = document.querySelector(".opengeo-workbench");
        return shell?.__opengeoMap?.getSource("geomoose-water-quality-source")
          && shell?.__opengeoMap?.getSource("geomoose-priority-habitat-source");
      });

      const pointerStart = browserGeoMooseQueryRequests.length;
      await mapCanvas.click({position: {x: 480, y: 300}});
      for (let attempt = 0; attempt < 100
        && browserGeoMooseQueryRequests.length < pointerStart + 2; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      await mapCanvas.click({position: {x: 520, y: 330}});
      const identify = page.locator('.gis-identify-panel[data-identify-state="ready"]');
      await identify.waitFor();
      const groups = identify.locator(".gis-identify-layer");
      if (await groups.count() !== 2) {
        failures.push(`${label}: map pointer identify did not return one response group per visible governed layer`);
      }
      for (const expected of [
        {title: "MassGIS water quality monitoring", matches: "2 of 2 matches"},
        {title: "MassGIS priority habitats", matches: "1 of 1 matches"}
      ]) {
        const group = groups.filter({hasText: expected.title});
        if (await group.count() !== 1 || !(await group.innerText()).includes(expected.matches)) {
          failures.push(`${label}: identify response for ${expected.title} was missing or incomplete`);
        }
      }
      const pointerRequests = browserGeoMooseQueryRequests.slice(pointerStart);
      for (let attempt = 0; attempt < 100
        && browserExpectedFeatureQueryAborts > 0; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      const latestPointerRequests = pointerRequests.slice(-2);
      const firstLocation = pointerRequests[0]?.query.steps[0]?.geometry.coordinates;
      const latestLocation = latestPointerRequests[0]?.query.steps[0]?.geometry.coordinates;
      if (pointerRequests.length !== 4
        || browserExpectedFeatureQueryAborts !== 0
        || JSON.stringify(firstLocation) === JSON.stringify(latestLocation)
        || new Set(latestPointerRequests.map(({datasetId}) => datasetId)).size !== 2
        || latestPointerRequests.some(({query}) => (
          query.steps.length !== 1
          || query.steps[0].kind !== "spatial"
          || query.steps[0].geometry.type !== "Point"
          || query.steps[0].buffer_meters !== 25
          || query.expected_generation !== 7
          || query.limit !== 10
          || query.offset !== 0
        ))) {
        failures.push(`${label}: rapid pointer identify did not abort the first batch and render one bounded latest-location query per dataset (${JSON.stringify({requests: pointerRequests.length, expectedAbortsRemaining: browserExpectedFeatureQueryAborts, firstLocation, latestLocation})})`);
      }
      if (await page.locator(".maplibregl-popup").count() !== 0) {
        failures.push(`${label}: governed map identify also opened a duplicate MapLibre feature popup`);
      }

      await page.getByRole("button", {name: "Query", exact: true}).click();
      const savedInput = page.getByLabel("Open saved query receipt");
      await savedInput.setInputFiles({
        name: "massgis-water-quality-query.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(receipt))
      });
      const saved = page.locator('.gis-saved-query-item[data-query-hash="' + receipt.query_sha256 + '"]');
      await saved.waitFor();
      if (!(await saved.innerText()).includes("Generation 7")) {
        failures.push(`${label}: opened query receipt did not present its bound collection generation`);
      }
      const focusedAfterOpen = await page.evaluate(() => (
        document.activeElement?.closest(".gis-query-step") !== null
      ));
      if (!focusedAfterOpen) {
        failures.push(`${label}: opening a saved query receipt did not move focus into the editable query`);
      }

      const replayStart = browserGeoMooseQueryRequests.length;
      await saved.getByRole("button", {name: "Replay exact query", exact: true}).click();
      const results = page.locator('.gis-query-panel[data-query-state="ready"]');
      await results.getByText("2 of 2 matching features at generation 7.").waitFor();
      const replayRequests = browserGeoMooseQueryRequests.slice(replayStart);
      if (replayRequests.length !== 1
        || replayRequests[0].datasetId !== IDS.dataset
        || replayRequests[0].query.expected_generation !== 7
        || await featureQuerySha256(replayRequests[0].query) !== receipt.query_sha256) {
        failures.push(`${label}: saved receipt replay changed its dataset, generation, or canonical query`);
      }
      const tableRows = results.locator(".gis-query-result-table tbody tr");
      if (await tableRows.count() !== 2) {
        failures.push(`${label}: exact replay did not present its bounded linked result table`);
      }
      const tableFeatureIds = await tableRows.evaluateAll((rows) => rows.map((row) => row.dataset.featureId));
      const mapFeatureIds = await workbench.evaluate((shell) => {
        const source = shell.__opengeoMap?.getSource("opengeo-query-result-source");
        return source?._data?.geojson?.features?.map(({id}) => String(id)) ?? [];
      });
      const resultMapTarget = await workbench.evaluate((shell) => {
        const map = shell.__opengeoMap;
        const source = map?.getSource("opengeo-query-result-source");
        const feature = source?._data?.geojson?.features?.[1];
        const coordinates = feature?.geometry?.coordinates;
        if (!map || !feature || feature.geometry?.type !== "LineString" || !coordinates?.length) {
          return null;
        }
        const point = map.project(coordinates.at(-1));
        return {featureId: feature.id, x: point.x, y: point.y};
      });
      const requestsBeforeResultClick = browserGeoMooseQueryRequests.length;
      if (!resultMapTarget) {
        failures.push(`${label}: rendered query result could not be projected for pointer selection`);
      } else {
        await mapCanvas.click({position: {x: resultMapTarget.x, y: resultMapTarget.y}});
        await page.waitForFunction((featureId) => {
          const source = document.querySelector(".opengeo-workbench")
            ?.__opengeoMap?.getSource("opengeo-query-result-source");
          return source?._data?.geojson?.features?.some((feature) => (
            feature.id === featureId && feature.properties?.opengeoQuerySelected === true
          ));
        }, resultMapTarget.featureId);
        await page.waitForTimeout(100);
        if (browserGeoMooseQueryRequests.length !== requestsBeforeResultClick) {
          failures.push(`${label}: clicking a rendered query result also launched cross-layer identify requests`);
        }
        if (await results.count() !== 1 || await page.locator(".gis-identify-panel").count() !== 0) {
          failures.push(`${label}: clicking a rendered query result replaced the Query panel with Identify Results`);
        }
        if (await page.locator(".maplibregl-popup").count() !== 0) {
          failures.push(`${label}: clicking a rendered query result opened a duplicate feature popup`);
        }
      }
      const firstRow = tableRows.first();
      const secondRow = tableRows.nth(1);
      const firstFeatureId = await firstRow.getAttribute("data-feature-id");
      const secondFeatureId = await secondRow.getAttribute("data-feature-id");
      await firstRow.focus();
      await firstRow.press("Enter");
      await page.waitForFunction((featureId) => (
        document.activeElement?.dataset.featureId === featureId
        && document.activeElement?.getAttribute("aria-selected") === "true"
      ), firstFeatureId);
      await page.waitForFunction(() => !document.querySelector(".opengeo-workbench")?.__opengeoMap?.isMoving?.());
      await page.locator(`.gis-query-result-table tbody tr[data-feature-id="${firstFeatureId}"]`).press("ArrowDown");
      if (await page.evaluate((featureId) => document.activeElement?.dataset.featureId === featureId, secondFeatureId) !== true) {
        failures.push(`${label}: ArrowDown did not move the linked result grid focus to the next feature`);
      }
      await page.locator(`.gis-query-result-table tbody tr[data-feature-id="${secondFeatureId}"]`).press(" ");
      await page.waitForFunction((featureId) => (
        document.activeElement?.dataset.featureId === featureId
        && document.activeElement?.getAttribute("aria-selected") === "true"
      ), secondFeatureId);
      await page.waitForFunction(() => !document.querySelector(".opengeo-workbench")?.__opengeoMap?.isMoving?.());
      const selectedMapFeatureIds = await workbench.evaluate((shell) => {
        const source = shell.__opengeoMap?.getSource("opengeo-query-result-source");
        return source?._data?.geojson?.features?.filter(
          (feature) => feature.properties?.opengeoQuerySelected === true
        ).map(({id}) => String(id)) ?? [];
      });
      if (selectedMapFeatureIds.length !== 1 || selectedMapFeatureIds[0] !== secondFeatureId) {
        failures.push(`${label}: keyboard-selecting a replay result row did not select the same map feature`);
      }

      const csvDownload = page.waitForEvent("download");
      await results.getByRole("button", {name: "Download CSV", exact: true}).click();
      const csv = await csvDownload;
      const csvPath = await csv.path();
      const csvText = csvPath ? await readFile(csvPath, "utf8") : "";
      const csvFeatureIds = csvText.trimEnd().split("\r\n").slice(1).map((row) => {
        const match = /^"((?:[^"]|"")*)"/.exec(row);
        return match?.[1].replaceAll('""', '"') ?? null;
      });
      if (csv.suggestedFilename() !== "massgis-water-quality-monitoring-query.csv"
        || new TextEncoder().encode(csvText).byteLength > 262_144
        || !csvText.startsWith('"feature_id","feature_version","geometry_type","name","status"\r\n')
        || csvText.trimEnd().split("\r\n").length !== 3
        || JSON.stringify(csvFeatureIds) !== JSON.stringify(tableFeatureIds)
        || JSON.stringify(csvFeatureIds) !== JSON.stringify(mapFeatureIds)) {
        failures.push(`${label}: replay CSV was not deterministic and bounded (${csv.suggestedFilename()})`);
      }

      for (const selectionTool of [
        "Select by point",
        "Select multiple points",
        "Select by line",
        "Select by polygon",
        "Select by box",
        "Select visible area",
        "Modify selection"
      ]) {
        if (await results.getByRole("button", {name: selectionTool, exact: true}).count() !== 1) {
          failures.push(`${label}: governed query did not expose ${selectionTool}`);
        }
      }
      await results.getByRole("button", {name: "Copy results as selection", exact: true}).click();
      const copiedSelection = page.locator(".gis-query-selection-clipboard");
      await copiedSelection.waitFor();
      if (!(await copiedSelection.innerText()).includes("2 bounded features")
        || !(await copiedSelection.innerText()).includes("generation 7")) {
        failures.push(`${label}: copied result selection omitted its bounded source identity`);
      }
      await copiedSelection.getByRole("button", {name: "Add result selection", exact: true}).click();
      const copiedStep = page.locator(".gis-query-step").filter({hasText: "copied result selection"});
      await copiedStep.waitFor();
      await copiedStep.getByLabel("Buffer (meters)").fill("250");
      const promotedStart = browserGeoMooseQueryRequests.length;
      await page.getByRole("button", {name: "Run query", exact: true}).click();
      await page.locator('.gis-query-panel[data-query-state="ready"]').waitFor();
      const promotedRequests = browserGeoMooseQueryRequests.slice(promotedStart);
      const promoted = promotedRequests[0]?.query?.steps?.[0];
      if (promotedRequests.length !== 1
        || promoted?.geometry?.type !== "GeometryCollection"
        || promoted.geometry.geometries.length !== 2
        || promoted.buffer_meters !== 250
        || promotedRequests[0].query.schema_version !== "opengeo.feature-query.1.1.0") {
        failures.push(`${label}: copied results did not become one exact bounded 1.1 buffered selection (${JSON.stringify(promotedRequests)})`);
      }

      const expectedState = await geoMooseQueryState(page);
      for (const viewport of viewports) {
        await page.setViewportSize({width: viewport.width, height: viewport.height});
        await settleMobileViewport(page, viewport.width, viewport.height);
        await assertGeoMooseQueryViewport(page, route, colorScheme, viewport);
        const retained = await geoMooseQueryState(page);
        if (retained.queryHash !== expectedState.queryHash
          || retained.queryRows !== expectedState.queryRows
          || retained.savedReceipts !== expectedState.savedReceipts
          || retained.selectedResults !== expectedState.selectedResults
          || retained.layerCount !== expectedState.layerCount
          || !mobileCameraMatches(expectedState, retained)) {
          failures.push(`${label} ${viewport.label}: resize/orientation change discarded query, map, or layer state (${JSON.stringify({expectedState, retained})})`);
        }
      }
    });
  }
}

async function assertGeoMooseTemporaryGeometryWorkflow(browser, baseUrl) {
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const viewports = [
    {label: "desktop 1440×950", width: 1440, height: 950, compact: false},
    {label: "phone 390×844", width: 390, height: 844, compact: true},
    {label: "short landscape 844×390", width: 844, height: 390, compact: true}
  ];

  for (const colorScheme of ["dark", "light"]) {
    await withPlatformPage(browser, baseUrl, {
      token: "browser.test.token",
      colorScheme,
      viewport: {width: viewports[0].width, height: viewports[0].height},
      hasTouch: true
    }, async (page) => {
      const label = `GeoMoose temporary geometry ${colorScheme}`;
      capturePageErrors(page, label);
      await visit(page, `${baseUrl}${route}`, label);
      const workbench = page.locator(".opengeo-workbench");
      const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
      await workbench.waitFor();
      await mapCanvas.waitFor();
      await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());

      await page.locator('.gis-menubar [data-menu="edit"] > button').click();
      await page.locator('.gis-menu-wrap[data-menu="edit"] .gis-menu-item', {
        hasText: "Temporary annotations and uploads…"
      }).click();
      const panel = page.locator(".gis-panel-right");
      await panel.getByText("Browser-only scratch work").waitFor();
      await panel.locator('.gis-file-drop input[accept^=".geojson"]').setInputFiles({
        name: "field-review-line.geojson",
        mimeType: "application/geo+json",
        buffer: Buffer.from(JSON.stringify({
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {name: "Field review line"},
            geometry: {type: "LineString", coordinates: [[-71.1, 42.3], [-71, 42.4]]}
          }]
        }))
      });
      const temporaryRow = panel.locator(".gis-temporary-work-item", {hasText: "field-review-line"});
      await temporaryRow.waitFor();
      const originalStored = await temporaryStorageGeojson(page);
      await temporaryRow.getByRole("button", {name: "Edit geometry", exact: true}).click();
      const editor = panel.locator('[data-temporary-editor="active"]');
      await editor.waitFor();
      await editor.getByRole("button", {name: /^Vertex 1:/}).click();
      const focusedCoordinate = await page.evaluate(() => document.activeElement?.dataset.temporaryCoordinate);
      if (focusedCoordinate !== "longitude") {
        failures.push(`${label}: selecting a vertex did not move keyboard focus to its exact-coordinate field`);
      }

      await editor.getByLabel("Longitude").fill("-70.85");
      await editor.getByLabel("Latitude").fill("42.55");
      await editor.getByRole("button", {name: "Apply coordinate", exact: true}).click();
      const draftState = await temporaryEditBrowserState(page);
      if (JSON.stringify(draftState.draftCoordinates) !== JSON.stringify([[-70.85, 42.55], [-71, 42.4]])
        || JSON.stringify(draftState.layerCoordinates) !== JSON.stringify([[-71.1, 42.3], [-71, 42.4]])
        || JSON.stringify((await temporaryStorageGeojson(page)).features[0].geometry.coordinates)
          !== JSON.stringify(originalStored.features[0].geometry.coordinates)) {
        failures.push(`${label}: a temporary edit draft changed the rendered or stored source before explicit save (${JSON.stringify(draftState)})`);
      }
      const initialEditComposition = await temporaryEditComposition(page);
      if (!initialEditComposition.complete) {
        failures.push(`${label}: temporary edit overlay was incomplete before a style change (${JSON.stringify(initialEditComposition)})`);
      }

      await page.getByRole("button", {name: "Change basemap", exact: true}).click();
      const basemapDialog = page.getByRole("dialog", {name: "Change basemap"});
      await basemapDialog.waitFor();
      const blankBasemap = basemapDialog.locator('.gis-basemap-card[data-catalog-id="blank"]');
      const blankGroup = blankBasemap.locator("xpath=ancestor::details[1]");
      if (await blankGroup.getAttribute("open") === null) await blankGroup.locator("summary").click();
      await blankBasemap.click();
      await page.waitForFunction(() => (
        document.querySelector(".opengeo-workbench")?.dataset.basemapActivationState === "active"
        && document.querySelector('.gis-basemap-card[data-catalog-id="blank"]')?.getAttribute("aria-pressed") === "true"
      ));
      await page.waitForFunction(() => {
        const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
        return map?.getSource("opengeo-temporary-edit-source")
          && map.getLayer("opengeo-temporary-edit-fill")
          && map.getLayer("opengeo-temporary-edit-line")
          && map.getLayer("opengeo-temporary-edit-vertices");
      });
      const restoredEditComposition = await temporaryEditComposition(page);
      if (!restoredEditComposition.complete) {
        failures.push(`${label}: basemap style replacement did not restore the temporary edit overlay (${JSON.stringify(restoredEditComposition)})`);
      }
      await basemapDialog.getByRole("button", {name: "Done", exact: true}).click();

      const expected = await temporaryEditBrowserState(page);
      for (const viewport of viewports) {
        await page.setViewportSize({width: viewport.width, height: viewport.height});
        await settleMobileViewport(page, viewport.width, viewport.height);
        await assertWorkbenchLayoutConflicts(page, route, viewport.width, colorScheme);
        await assertReadable(page, `${label} ${viewport.label}`);
        await assertTemporaryEditViewport(page, route, colorScheme, viewport);
        const retained = await temporaryEditBrowserState(page);
        if (JSON.stringify(retained.draftCoordinates) !== JSON.stringify(expected.draftCoordinates)
          || JSON.stringify(retained.layerCoordinates) !== JSON.stringify(expected.layerCoordinates)
          || retained.editSourceFeatures !== expected.editSourceFeatures
          || retained.guideVisible !== true
          || !mobileCameraMatches(expected, retained)) {
          failures.push(`${label} ${viewport.label}: resize/orientation change discarded the edit draft, overlay, or map state (${JSON.stringify({expected, retained})})`);
        }
      }

      await page.setViewportSize({width: 1440, height: 950});
      await settleMobileViewport(page, 1440, 950);
      await page.locator('.gis-temporary-edit-guide[data-temporary-edit="active"]')
        .getByRole("button", {name: "Save geometry changes", exact: true}).click();
      const saved = await temporaryStorageGeojson(page);
      if (JSON.stringify(saved.features[0].geometry.coordinates) !== JSON.stringify([[-70.85, 42.55], [-71, 42.4]])) {
        failures.push(`${label}: explicit save did not update project-scoped temporary storage`);
      }
      await page.reload({waitUntil: "domcontentloaded"});
      await page.locator(".opengeo-workbench").waitFor();
      await page.locator('.gis-menubar [data-menu="edit"] > button').click();
      await page.locator('.gis-menu-wrap[data-menu="edit"] .gis-menu-item', {
        hasText: "Temporary annotations and uploads…"
      }).click();
      const restoredRow = page.locator(".gis-temporary-work-item", {hasText: "field-review-line"});
      await restoredRow.waitFor();
      await restoredRow.getByRole("button", {name: "Edit geometry", exact: true}).click();
      const restoredEditor = page.locator('[data-temporary-editor="active"]');
      await restoredEditor.getByRole("button", {name: /^Vertex 1:/}).click();
      if (await restoredEditor.getByLabel("Longitude").inputValue() !== "-70.85"
        || await restoredEditor.getByLabel("Latitude").inputValue() !== "42.55") {
        failures.push(`${label}: a saved temporary edit did not restore after reload`);
      }
      await restoredEditor.getByLabel("Longitude").fill("-69");
      await restoredEditor.getByLabel("Latitude").fill("41");
      await restoredEditor.getByRole("button", {name: "Apply coordinate", exact: true}).click();
      await page.locator('[data-temporary-editor="active"]')
        .getByRole("button", {name: "Cancel geometry editing", exact: true}).click();
      if (JSON.stringify((await temporaryStorageGeojson(page)).features[0].geometry.coordinates)
        !== JSON.stringify(saved.features[0].geometry.coordinates)) {
        failures.push(`${label}: cancel changed saved temporary geometry`);
      }
      const returnedFocus = await page.evaluate(() => document.activeElement?.textContent?.trim());
      if (returnedFocus !== "Edit geometry") {
        failures.push(`${label}: cancel did not return keyboard focus to the temporary layer action`);
      }
    });
  }
}

async function assertCameraTourWorkflow(browser, baseUrl) {
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const viewports = [
    {label: "desktop 1440×950", width: 1440, height: 950, compact: false},
    {label: "phone 390×844", width: 390, height: 844, compact: true},
    {label: "short landscape 844×390", width: 844, height: 390, compact: true}
  ];
  for (const colorScheme of ["dark", "light"]) {
    await withPlatformPage(browser, baseUrl, {
      token: "browser.test.token",
      colorScheme,
      viewport: {width: 1440, height: 950},
      hasTouch: true
    }, async (page) => {
      const label = `camera tour ${colorScheme}`;
      capturePageErrors(page, label);
      await visit(page, `${baseUrl}${route}`, label);
      const shell = page.locator(".opengeo-workbench");
      const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
      await shell.waitFor();
      await mapCanvas.waitFor();
      await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());
      await page.locator('.gis-menubar [data-menu="controls"] > button').click();
      await page.locator('.gis-menu-wrap[data-menu="controls"] .gis-menu-item', {hasText: "Camera tour"}).first().click();
      const panel = page.locator(".gis-camera-tour-panel");
      await panel.waitFor();
      await panel.getByRole("button", {name: "Start camera tour", exact: true}).click();

      let editor = panel.locator('[data-camera-tour-editor="view-1"]');
      await editor.waitFor();
      const startingCamera = await page.locator(".opengeo-workbench").evaluate((workbench) => {
        const map = workbench.__opengeoMap;
        const center = map.getCenter();
        return {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
      });
      await editor.getByLabel("Hold time (seconds)").fill("0");
      await editor.getByRole("button", {name: "Apply timing", exact: true}).click();
      await page.locator(".opengeo-workbench").evaluate((workbench) => {
        workbench.__opengeoMap.jumpTo({center: [-70, 43], zoom: 9, pitch: 40, bearing: 30});
      });
      await panel.getByRole("button", {name: "Add current view", exact: true}).click();
      editor = panel.locator('[data-camera-tour-editor="view-2"]');
      await editor.waitFor();
      await editor.getByLabel("Travel time (seconds)").fill("0.2");
      await editor.getByLabel("Hold time (seconds)").fill("0.1");
      await editor.getByRole("button", {name: "Apply timing", exact: true}).click();

      const timeline = panel.locator('[data-camera-tour-timeline="elapsed"]');
      await timeline.evaluate((input) => {
        input.value = "100";
        input.dispatchEvent(new Event("input", {bubbles: true}));
      });
      const scrubbed = await cameraTourBrowserState(page);
      const west = Math.min(startingCamera.center[0], -70);
      const east = Math.max(startingCamera.center[0], -70);
      if (scrubbed.keyframes !== 2
        || scrubbed.elapsed !== 100
        || scrubbed.phase !== "transition"
        || scrubbed.center[0] <= west
        || scrubbed.center[0] >= east) {
        failures.push(`${label}: deterministic scrub did not interpolate between the recorded cameras (${JSON.stringify(scrubbed)})`);
      }

      await panel.getByRole("button", {name: "Play tour", exact: true}).click();
      await page.waitForFunction(() => (
        document.querySelector(".opengeo-workbench")?.dataset.cameraTourPhase === "finished"
        && document.querySelector(".gis-camera-tour-panel")?.dataset.playbackState === "stopped"
      ));
      const finished = await cameraTourBrowserState(page);
      if (Math.abs(finished.center[0] - (-70)) > 0.000001
        || Math.abs(finished.center[1] - 43) > 0.000001
        || finished.elapsed !== 300) {
        failures.push(`${label}: playback did not finish at the exact recorded camera and duration (${JSON.stringify(finished)})`);
      }

      for (const viewport of viewports) {
        await page.setViewportSize({width: viewport.width, height: viewport.height});
        await settleMobileViewport(page, viewport.width, viewport.height);
        if (viewport.compact && !(await page.locator(".gis-panel-right").isVisible())) {
          await page.getByRole("button", {name: "Actions", exact: true}).click();
          const sheet = page.getByRole("dialog", {name: "Actions"});
          await sheet.getByRole("button", {name: "Camera tour", exact: true}).click();
        }
        await assertWorkbenchLayoutConflicts(page, route, viewport.width, colorScheme);
        await assertReadable(page, `${label} ${viewport.label}`);
        await assertCameraTourViewport(page, route, colorScheme, viewport);
        const retained = await cameraTourBrowserState(page);
        if (retained.keyframes !== 2 || retained.elapsed !== 300 || Math.abs(retained.center[0] - (-70)) > 0.000001) {
          failures.push(`${label} ${viewport.label}: responsive transition lost the tour, elapsed position, or camera (${JSON.stringify(retained)})`);
        }
      }
    });
  }
}

async function cameraTourBrowserState(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => {
    const map = shell.__opengeoMap;
    const center = map.getCenter();
    return {
      keyframes: shell.querySelectorAll("[data-camera-tour-keyframe]").length,
      elapsed: Number(shell.dataset.cameraTourElapsed ?? 0),
      phase: shell.dataset.cameraTourPhase ?? null,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      selected: shell.querySelector('[data-camera-tour-keyframe][aria-pressed="true"]')?.dataset.cameraTourKeyframe ?? null
    };
  });
}

async function assertCameraTourViewport(page, route, colorScheme, viewport) {
  const metrics = await page.locator(".gis-camera-tour-panel").evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    const targets = [...panel.querySelectorAll('button:not([disabled]), input[type="range"]')].map((element) => {
      const rectangle = element.getBoundingClientRect();
      return {label: element.getAttribute("aria-label") ?? element.textContent.trim(), width: rectangle.width, height: rectangle.height};
    });
    return {
      viewport: {width: innerWidth, height: innerHeight},
      bounds: bounds.toJSON(),
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      targets
    };
  });
  if (metrics.bounds.left < -1
    || metrics.bounds.right > metrics.viewport.width + 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${colorScheme} ${viewport.label}: camera tour panel escaped the viewport (${JSON.stringify(metrics)})`);
  }
  if (viewport.compact) {
    const undersized = metrics.targets.filter(({width, height}) => width < 44 || height < 44);
    if (undersized.length) {
      failures.push(`${route} ${colorScheme} ${viewport.label}: camera tour targets are smaller than 44px (${JSON.stringify(undersized)})`);
    }
  }
}

async function assertFlightSimulatorWorkflow(browser, baseUrl) {
  const started = performance.now();
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const viewports = [
    {label: "desktop 1440×950", width: 1440, height: 950, compact: false},
    {label: "phone 390×844", width: 390, height: 844, compact: true},
    {label: "short landscape 844×390", width: 844, height: 390, compact: true}
  ];
  for (const colorScheme of ["dark", "light"]) {
    await withPlatformPage(browser, baseUrl, {
      token: "browser.test.token",
      colorScheme,
      viewport: {width: 1440, height: 950},
      hasTouch: true
    }, async (page) => {
      const label = `flight simulator ${colorScheme}`;
      capturePageErrors(page, label);
      await visit(page, `${baseUrl}${route}`, label);
      const shell = page.locator(".opengeo-workbench");
      await shell.waitFor();
      await page.locator(".gis-map .maplibregl-canvas").waitFor();
      await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.());
      await page.locator('.gis-menubar [data-menu="controls"] > button').click();
      await page.locator('.gis-menu-wrap[data-menu="controls"] .gis-menu-item', {hasText: "Flight simulator"}).first().click();
      const panel = page.locator(".gis-flight-panel");
      await panel.waitFor();
      await panel.getByRole("button", {name: "Enable globe and governed terrain", exact: true}).click();
      await page.locator('.opengeo-workbench[data-terrain="enabled"]').waitFor();

      // The browser fixture makes terrain height deterministic while retaining the
      // exact governed terrain source and the renderer's unexaggerated query path.
      await shell.evaluate((workbench) => {
        workbench.__opengeoMap.queryTerrainElevation = () => 100;
        workbench.dispatchEvent(new Event("workbench:render"));
      });
      await panel.locator('[data-flight-readiness="ready"]').waitFor();
      const startingCenter = await shell.evaluate((workbench) => workbench.__opengeoMap.getCenter().toArray());
      await panel.getByLabel("Starting height above terrain (metres)").fill("300");
      await panel.getByLabel("Starting heading (degrees)").fill("90");
      await panel.getByRole("button", {name: "Start flight", exact: true}).click();
      await page.locator('.opengeo-workbench[data-flight-phase="flying"]').waitFor();
      const hud = page.locator(".gis-flight-hud");
      await hud.waitFor();
      await hud.focus();
      await page.keyboard.down("ArrowDown");
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(350);
      await page.keyboard.up("ArrowRight");
      await page.keyboard.up("ArrowDown");
      await page.keyboard.press("Escape");
      await page.locator('.opengeo-workbench[data-flight-phase="paused"]').waitFor();
      const controlled = await flightBrowserState(page);
      if (controlled.elapsed < 250
        || Math.abs(controlled.heading - 90) < 0.01
        || coordinatesNear(controlled.center, startingCenter, 0.000001)) {
        failures.push(`${label}: focused keyboard input did not advance and turn the deterministic flight (${JSON.stringify({startingCenter, controlled})})`);
      }

      await panel.getByRole("button", {name: "Reset flight", exact: true}).click();
      let reset = await flightBrowserState(page);
      if (reset.phase !== "paused"
        || reset.elapsed !== 0
        || reset.heading !== 90
        || !coordinatesNear(reset.center, startingCenter, 0.000001)) {
        failures.push(`${label}: reset did not restore the exact initial aircraft state (${JSON.stringify({startingCenter, reset})})`);
      }

      await shell.evaluate((workbench) => {
        workbench.__opengeoMap.queryTerrainElevation = () => null;
      });
      await panel.getByRole("button", {name: "Resume flight", exact: true}).click();
      await page.locator('.opengeo-workbench[data-flight-phase="terrain_unavailable"]').waitFor();
      const failedSafe = await flightBrowserState(page);
      if (failedSafe.elapsed !== 50 || failedSafe.phase !== "terrain_unavailable") {
        failures.push(`${label}: missing terrain did not stop on the first bounded physics step (${JSON.stringify(failedSafe)})`);
      }
      await shell.evaluate((workbench) => {
        workbench.__opengeoMap.queryTerrainElevation = () => 100;
      });
      await panel.getByRole("button", {name: "Reset flight", exact: true}).click();

      for (const viewport of viewports) {
        await page.setViewportSize({width: viewport.width, height: viewport.height});
        await settleMobileViewport(page, viewport.width, viewport.height);
        if (viewport.compact && !(await page.locator(".gis-panel-right").isVisible())) {
          await page.getByRole("button", {name: "Actions", exact: true}).click();
          const sheet = page.getByRole("dialog", {name: "Actions"});
          const controls = sheet.locator('[data-mobile-command-category="controls"]');
          await controls.locator("summary").click();
          await controls.getByRole("menuitem", {name: "Flight simulator", exact: true}).click();
        }
        await assertWorkbenchLayoutConflicts(page, route, viewport.width, colorScheme);
        await assertReadable(page, `${label} ${viewport.label}`);
        await assertFlightSimulatorViewport(page, route, colorScheme, viewport);
        reset = await flightBrowserState(page);
        if (reset.phase !== "paused"
          || reset.elapsed !== 0
          || reset.heading !== 90
          || !coordinatesNear(reset.center, startingCenter, 0.000001)) {
          failures.push(`${label} ${viewport.label}: resize or orientation change lost the paused aircraft state (${JSON.stringify(reset)})`);
        }
      }
      await panel.getByRole("button", {name: "End flight", exact: true}).click();
      await page.locator(".gis-flight-hud").waitFor({state: "detached"});
      const ended = await shell.evaluate((workbench) => ({
        phase: workbench.dataset.flightPhase ?? null,
        elapsed: workbench.dataset.flightElapsed ?? null,
        heading: workbench.dataset.flightHeading ?? null,
        agl: workbench.dataset.flightAgl ?? null
      }));
      if (Object.values(ended).some((value) => value !== null)) {
        failures.push(`${label}: ending flight retained stale simulator presentation state (${JSON.stringify(ended)})`);
      }
    });
  }
  acceptedFlightSimulation = {
    distRoot,
    viewports: viewports.map(({width, height}) => `${width}x${height}`),
    colorModes: ["dark", "light"],
    durationMilliseconds: Math.round(performance.now() - started),
    requests: flightBrowserRequests,
    terrain: "deterministic renderer query; provider accuracy is not measured",
    cleanup: "both contexts, browser and local fixture server closed before reporting"
  };
}

async function flightBrowserState(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => {
    const center = shell.__opengeoMap.getCenter();
    return {
      phase: shell.dataset.flightPhase ?? null,
      elapsed: Number(shell.dataset.flightElapsed ?? -1),
      heading: Number(shell.dataset.flightHeading ?? -1),
      aglFeet: Number(shell.dataset.flightAgl ?? -1),
      center: [center.lng, center.lat]
    };
  });
}

function coordinatesNear(left, right, tolerance) {
  return left.length === right.length
    && left.every((coordinate, index) => Math.abs(coordinate - right[index]) <= tolerance);
}

async function assertFlightSimulatorViewport(page, route, colorScheme, viewport) {
  const metrics = await page.locator(".opengeo-workbench").evaluate((shell) => {
    const visibleBounds = (selector) => {
      const element = shell.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || bounds.height === 0
        ? null
        : bounds.toJSON();
    };
    const targets = [...shell.querySelectorAll('.gis-flight-panel button:not([disabled])')].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {label: element.textContent.trim(), width: bounds.width, height: bounds.height};
    });
    return {
      viewport: {width: innerWidth, height: innerHeight},
      dock: visibleBounds(".gis-panel-right"),
      panel: visibleBounds(".gis-flight-panel"),
      hud: visibleBounds(".gis-flight-hud"),
      controls: visibleBounds(".gis-map-control-stack"),
      toolbar: visibleBounds(".gis-mobile-toolbar"),
      panelOverflowX: Math.max(0, (shell.querySelector(".gis-flight-panel")?.scrollWidth ?? 0)
        - (shell.querySelector(".gis-flight-panel")?.clientWidth ?? 0)),
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      targets
    };
  });
  const withinViewport = (bounds) => bounds
    && bounds.left >= -1
    && bounds.top >= -1
    && bounds.right <= metrics.viewport.width + 1
    && bounds.bottom <= metrics.viewport.height + 1;
  const panelHorizontallyBounded = metrics.panel
    && metrics.panel.left >= -1
    && metrics.panel.right <= metrics.viewport.width + 1;
  if (!withinViewport(metrics.dock)
    || !panelHorizontallyBounded
    || !withinViewport(metrics.hud)
    || metrics.panelOverflowX > 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${colorScheme} ${viewport.label}: flight interface escaped the viewport (${JSON.stringify(metrics)})`);
  }
  if (viewport.compact) {
    const undersized = metrics.targets.filter(({width, height}) => width < 44 || height < 44);
    if (undersized.length) {
      failures.push(`${route} ${colorScheme} ${viewport.label}: flight targets are smaller than 44px (${JSON.stringify(undersized)})`);
    }
  }
}

async function temporaryStorageGeojson(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("opengeo.temporary-work."));
    const document = key ? JSON.parse(localStorage.getItem(key)) : null;
    return document?.entries?.[0]?.geojson ?? null;
  });
}

async function temporaryEditBrowserState(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => {
    const layer = shell.__opengeoLayers.find(({temporaryWork}) => temporaryWork);
    const map = shell.__opengeoMap;
    const sourceData = (source) => source?._data?.geojson ?? source?._data ?? null;
    const editData = sourceData(map?.getSource("opengeo-temporary-edit-source"));
    const layerData = sourceData(map?.getSource(`${layer?.layerId}-source`));
    return {
      draftCoordinates: editData?.features?.find(({properties}) => properties?.editRole === "shape")?.geometry?.coordinates ?? null,
      layerCoordinates: layerData?.features?.[0]?.geometry?.coordinates ?? null,
      editSourceFeatures: editData?.features?.length ?? 0,
      guideVisible: Boolean(shell.querySelector('.gis-temporary-edit-guide[data-temporary-edit="active"]')),
      center: map?.getCenter?.().toArray?.() ?? [],
      zoom: map?.getZoom?.() ?? null,
      pitch: map?.getPitch?.() ?? null,
      bearing: map?.getBearing?.() ?? null
    };
  });
}

async function temporaryEditComposition(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => {
    const map = shell.__opengeoMap;
    const source = Boolean(map?.getSource("opengeo-temporary-edit-source"));
    const temporaryLayer = shell.__opengeoLayers.find(({temporaryWork}) => temporaryWork);
    const layers = ["opengeo-temporary-edit-fill", "opengeo-temporary-edit-line", "opengeo-temporary-edit-vertices"]
      .filter((layerId) => map?.getLayer(layerId));
    return {
      complete: source && layers.length === 3,
      styleLoaded: map?.isStyleLoaded?.() ?? false,
      source,
      layers,
      temporaryLayerCount: shell.__opengeoLayers.filter(({temporaryWork}) => temporaryWork).length,
      temporaryDataSource: Boolean(map?.getSource(`${temporaryLayer?.layerId}-source`)),
      mapLayerCount: map?.getStyle?.()?.layers?.length ?? 0,
      guideVisible: Boolean(shell.querySelector('[data-temporary-edit="active"]'))
    };
  });
}

async function assertTemporaryEditViewport(page, route, colorScheme, viewport) {
  const metrics = await page.locator('.gis-temporary-edit-guide[data-temporary-edit="active"]').evaluate((guide) => {
    const bounds = guide.getBoundingClientRect();
    const targets = [...guide.querySelectorAll('button:not([disabled])')].map((button) => {
      const rectangle = button.getBoundingClientRect();
      return {label: button.textContent.trim(), width: rectangle.width, height: rectangle.height};
    });
    return {
      viewport: {width: innerWidth, height: innerHeight},
      bounds: bounds.toJSON(),
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      targets
    };
  });
  if (metrics.bounds.left < -1
    || metrics.bounds.right > metrics.viewport.width + 1
    || metrics.bounds.top < -1
    || metrics.bounds.bottom > metrics.viewport.height + 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${colorScheme} ${viewport.label}: temporary edit guide escaped the viewport (${JSON.stringify(metrics)})`);
  }
  if (viewport.compact) {
    const undersized = metrics.targets.filter(({width, height}) => width < 44 || height < 44);
    if (undersized.length) {
      failures.push(`${route} ${colorScheme} ${viewport.label}: temporary edit targets are smaller than 44px (${JSON.stringify(undersized)})`);
    }
  }
}

function installGeoMooseQueryMap(colorMode) {
  const map = mapPayloadForProject(IDS.projects[0]);
  browserMapOverrides.set(`${IDS.projects[0]}:${IDS.maps[0]}`, {
    ...map,
    definition: {
      schemaVersion: "1.0.0",
      mapViews: [{
        id: "default",
        title: "MassGIS screening",
        center: [-71.08, 42.38],
        zoom: 9,
        pitch: 0,
        bearing: 0
      }],
      basemaps: [],
      bookmarks: [],
      activeLayerId: "geomoose-water-quality",
      projection: "mercator",
      colorMode,
      layers: [
        {
          layerId: "geomoose-water-quality",
          datasetId: IDS.dataset,
          title: "MassGIS water quality monitoring",
          sourceType: "governed-dataset",
          sourceVersion: 1,
          geometryType: "LineString",
          visible: true,
          opacity: 0.92,
          order: 1,
          style: {stroke: "#2563eb", strokeWidth: 4},
          labels: {enabled: false, field: null}
        },
        {
          layerId: "geomoose-priority-habitat",
          datasetId: IDS.geomooseQueryDataset,
          title: "MassGIS priority habitats",
          sourceType: "governed-dataset",
          sourceVersion: 4,
          geometryType: "Polygon",
          visible: true,
          opacity: 0.72,
          order: 2,
          style: {fill: "#22c55e", stroke: "#166534", strokeWidth: 2},
          labels: {enabled: false, field: null}
        }
      ]
    }
  });
}

async function geoMooseSavedQueryReceipt() {
  const query = normalizeFeatureQuery({
    steps: [{
      kind: "spatial",
      relation: "intersects",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-71.18, 42.3], [-70.98, 42.3], [-70.98, 42.46], [-71.18, 42.3]
        ]]
      },
      bufferMeters: 50
    }],
    expectedGeneration: 7,
    limit: 2,
    offset: 0
  });
  return createSavedFeatureQueryReceipt({
    datasetId: IDS.dataset,
    layerTitle: "MassGIS water quality monitoring",
    result: {query, querySha256: await featureQuerySha256(query), generation: 7}
  });
}

async function geoMooseQueryState(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => ({
    queryHash: shell.querySelector('.gis-query-panel[data-query-state="ready"]')?.dataset.queryHash
      ?? shell.querySelector(".gis-query-results")?.dataset.queryHash
      ?? null,
    queryRows: shell.querySelectorAll(".gis-query-result-table tbody tr").length,
    savedReceipts: shell.querySelectorAll(".gis-saved-query-item").length,
    selectedResults: shell.__opengeoMap?.getSource("opengeo-query-result-source")?._data?.geojson?.features?.filter(
      (feature) => feature.properties?.opengeoQuerySelected === true
    ).length ?? 0,
    layerCount: shell.querySelectorAll(".gis-layer-row").length,
    center: shell.__opengeoMap?.getCenter?.().toArray?.() ?? [],
    zoom: shell.__opengeoMap?.getZoom?.() ?? null,
    pitch: shell.__opengeoMap?.getPitch?.() ?? null,
    bearing: shell.__opengeoMap?.getBearing?.() ?? null
  }));
}

async function assertGeoMooseQueryViewport(page, route, colorScheme, viewport) {
  await assertWorkbenchLayoutConflicts(page, route, viewport.width, colorScheme);
  await assertReadable(page, `${route} ${viewport.label} ${colorScheme} query`);
  const metrics = await page.locator(".gis-query-panel").evaluate((panel, compact) => {
    const container = panel.closest(".gis-panel-right");
    const containerBounds = container?.getBoundingClientRect() ?? panel.getBoundingClientRect();
    const workbenchBounds = panel.closest(".opengeo-workbench")?.getBoundingClientRect()
      ?? containerBounds;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rectangle.width > 0
        && rectangle.height > 0
        && Math.min(rectangle.right, containerBounds.right) - Math.max(rectangle.left, containerBounds.left) > 1
        && Math.min(rectangle.bottom, containerBounds.bottom) - Math.max(rectangle.top, containerBounds.top) > 1;
    };
    const bounds = containerBounds;
    const targets = [...panel.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="range"]), select:not([disabled]), summary'
    )].filter(visible).map((element) => {
      const rectangle = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label") || element.textContent.trim().replace(/\s+/g, " ").slice(0, 48) || element.type,
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
        bottom: rectangle.bottom,
        width: rectangle.width,
        height: rectangle.height
      };
    });
    const overlaps = [];
    for (let left = 0; left < targets.length; left += 1) {
      for (let right = left + 1; right < targets.length; right += 1) {
        const a = targets[left];
        const b = targets[right];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          overlaps.push(`${a.label} <> ${b.label}`);
        }
      }
    }
    return {
      viewport: {width: innerWidth, height: innerHeight},
      workbench: workbenchBounds.toJSON(),
      panel: bounds.toJSON(),
      overflowX: panel.scrollWidth - panel.clientWidth,
      containerOverflowX: container ? container.scrollWidth - container.clientWidth : 0,
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      targets,
      overlaps,
      compact
    };
  }, viewport.compact);
  if (metrics.panel.left < metrics.workbench.left - 1
    || metrics.panel.right > metrics.workbench.right + 1
    || metrics.panel.top < metrics.workbench.top - 1
    || metrics.panel.bottom > metrics.workbench.bottom + 1
    || metrics.overflowX > 1
    || metrics.containerOverflowX > 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${viewport.label} ${colorScheme}: query surface escaped or overflowed its viewport (${JSON.stringify(metrics)})`);
  }
  if (metrics.overlaps.length) {
    failures.push(`${route} ${viewport.label} ${colorScheme}: query controls overlap (${metrics.overlaps.join(", ")})`);
  }
  if (viewport.compact) {
    for (const target of metrics.targets) {
      if (target.width < 44 || target.height < 44) {
        failures.push(`${route} ${viewport.label} ${colorScheme}: ${target.label} target is smaller than 44px (${Math.round(target.width)}×${Math.round(target.height)})`);
      }
    }
  }
}

async function assertDataPreservationWorkflow(browser, baseUrl) {
  const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
  const initialFailureCount = failures.length;
  browserProtectedCopyEstimateRequests.length = 0;
  browserProtectedCopyQueueRequests.length = 0;
  browserSourceDiscoveryRequests.length = 0;
  const viewports = [
    {
      id: "desktop",
      viewport: {width: 1440, height: 950},
      alternate: {width: 1280, height: 800},
      compact: false
    },
    {
      id: "phone",
      viewport: {width: 390, height: 844},
      alternate: {width: 844, height: 390},
      compact: true
    },
    {
      id: "short-landscape",
      viewport: {width: 844, height: 390},
      alternate: {width: 390, height: 844},
      compact: true
    }
  ];
  const exercised = [];
  let liveOnlyExits = 0;
  let queuedCopies = 0;

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    for (const colorScheme of ["dark", "light"]) {
      for (const [index, configuration] of viewports.entries()) {
        const label = `${configuration.id} ${colorScheme}`;
        await page.setViewportSize(configuration.viewport);
        await visit(page, `${baseUrl}${route}`, `${route} protected copy ${label}`);
        await page.locator(".opengeo-workbench").waitFor();
        await page.waitForFunction(() => Boolean(
          document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.()
        ));
        await setDataPreservationColorMode(page, colorScheme);

        const sourceName = `Protected WMS ${colorScheme} ${configuration.id}`;
        await openWmsPreservationPrompt(page, sourceName);
        const dialog = page.getByRole("dialog", {name: "Keep a protected copy?"});
        await dialog.waitFor();
        await page.locator('.opengeo-workbench[data-preservation-dialog-state="choice"]').waitFor();
        await assertDataPreservationDialogLayout(page, route, label, configuration.compact);

        const bodyText = await dialog.innerText();
        if (!bodyText.includes("Live connection saved")
          || !bodyText.includes("one PNG of the current map extent")) {
          failures.push(`${route} ${label}: protected-copy choice did not explain live persistence and bounded WMS custody`);
        }
        if (containsStorageAuthority(bodyText)) {
          failures.push(`${route} ${label}: protected-copy choice exposed a bucket, key, or storage endpoint`);
        }

        await dialog.focus();
        await page.keyboard.press("Shift+Tab");
        const wrappedToLast = await page.evaluate(() => document.activeElement?.textContent?.trim());
        if (wrappedToLast !== "Review protected copy") {
          failures.push(`${route} ${label}: backward Tab did not wrap to the final protected-copy action`);
        }
        await page.keyboard.press("Tab");
        const wrappedToFirst = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
        if (wrappedToFirst !== "Close protected copy dialog") {
          failures.push(`${route} ${label}: forward Tab did not wrap to the protected-copy close action`);
        }

        const expectedScope = {
          bounds: "-73.5, 42, -70, 43",
          width: "1024",
          height: "768"
        };
        await page.getByLabel("WGS84 bounds · west, south, east, north").fill(expectedScope.bounds);
        await page.getByLabel("Output width").fill(expectedScope.width);
        await page.getByLabel("Output height").fill(expectedScope.height);
        const cameraBeforeResize = await mobileWorkbenchSnapshot(page);

        await page.setViewportSize(configuration.alternate);
        await settleMobileViewport(page, configuration.alternate.width, configuration.alternate.height);
        await assertPreservationScope(page, route, `${label} alternate`, expectedScope);
        const cameraAtAlternate = await mobileWorkbenchSnapshot(page);
        if (!mobileCameraMatches(cameraBeforeResize, cameraAtAlternate)) {
          failures.push(`${route} ${label}: protected-copy resize moved the active map camera (${JSON.stringify({cameraBeforeResize, cameraAtAlternate})})`);
        }
        await page.setViewportSize(configuration.viewport);
        await settleMobileViewport(page, configuration.viewport.width, configuration.viewport.height);
        await assertPreservationScope(page, route, `${label} restored`, expectedScope);
        const cameraAfterResize = await mobileWorkbenchSnapshot(page);
        if (!mobileCameraMatches(cameraBeforeResize, cameraAfterResize)) {
          failures.push(`${route} ${label}: protected-copy resize round trip did not preserve map state (${JSON.stringify({cameraBeforeResize, cameraAfterResize})})`);
        }
        await assertDataPreservationDialogLayout(page, route, `${label} restored`, configuration.compact);

        const queueThisCopy = colorScheme === "dark" && index === 0;
        if (queueThisCopy) {
          const estimatesBefore = browserProtectedCopyEstimateRequests.length;
          await dialog.getByRole("button", {name: "Review protected copy", exact: true}).click();
          await page.locator('.opengeo-workbench[data-preservation-dialog-state="review"]').waitFor();
          await assertDataPreservationDialogLayout(page, route, `${label} review`, false);
          const estimateRequest = browserProtectedCopyEstimateRequests.at(-1);
          if (browserProtectedCopyEstimateRequests.length !== estimatesBefore + 1
            || estimateRequest?.payload?.source_type !== "wms"
            || JSON.stringify(estimateRequest?.payload?.scope) !== JSON.stringify({
              kind: "bounded_image",
              bounds: [-73.5, 42, -70, 43],
              width: 1024,
              height: 768
            })) {
            failures.push(`${route} ${label}: review did not use the exact server-bounded WMS estimate request (${JSON.stringify(estimateRequest)})`);
          }
          if (containsStorageAuthority(JSON.stringify(estimateRequest?.payload ?? {}))) {
            failures.push(`${route} ${label}: browser estimate request accepted client storage authority`);
          }
          const reviewText = await dialog.innerText();
          if (!reviewText.includes("One bounded PNG")
            || !reviewText.includes("$0.000420")
            || !reviewText.includes("I confirm that this project may retain these source bytes.")) {
            failures.push(`${route} ${label}: estimate review omitted method, cost limit, or rights confirmation`);
          }
          if (containsStorageAuthority(reviewText)) {
            failures.push(`${route} ${label}: estimate review exposed a bucket, key, or storage endpoint`);
          }
          await page.getByLabel("Rights basis").fill("MassGIS public-data terms permit an archival project copy");
          await page.getByLabel("I confirm that this project may retain these source bytes.").check();
          await page.getByLabel("I accept the bounded request, byte, and cost limits shown above.").check();
          const queuesBefore = browserProtectedCopyQueueRequests.length;
          const responsePromise = page.waitForResponse((response) => (
            response.request().method() === "POST"
            && /\/protected-copies$/.test(new URL(response.url()).pathname)
          ));
          await dialog.getByRole("button", {name: "Create protected copy", exact: true}).click();
          const queueResponse = await responsePromise;
          await page.locator('.opengeo-workbench[data-preservation-dialog-state="queued"]').waitFor();
          if (queueResponse.status() !== 202
            || browserProtectedCopyQueueRequests.length !== queuesBefore + 1) {
            failures.push(`${route} ${label}: protected-copy confirmation did not make exactly one 202 Accepted queue request`);
          }
          const queueRequest = browserProtectedCopyQueueRequests.at(-1);
          if (containsStorageAuthority(JSON.stringify(queueRequest?.payload ?? {}))) {
            failures.push(`${route} ${label}: protected-copy queue request accepted client bucket or key authority`);
          }
          const queuedText = await dialog.innerText();
          if (!queuedText.includes("Protected copy queued")
            || !queuedText.includes("The request is durable")
            || !queuedText.includes("Archive path")
            || !queuedText.includes("Server assigned")
            || !queuedText.includes(IDS.protectedCopyJob)) {
            failures.push(`${route} ${label}: queued confirmation omitted its durable job and server-assigned archive disclosure`);
          }
          if (containsStorageAuthority(queuedText)) {
            failures.push(`${route} ${label}: queued confirmation exposed a bucket, key, or storage endpoint`);
          }
          await dialog.getByRole("button", {name: "Done", exact: true}).click();
          await dialog.waitFor({state: "detached"});
          queuedCopies += 1;
        } else {
          const queuesBefore = browserProtectedCopyQueueRequests.length;
          await dialog.getByRole("button", {name: "Keep live connection only", exact: true}).click();
          await dialog.waitFor({state: "detached"});
          if (browserProtectedCopyQueueRequests.length !== queuesBefore) {
            failures.push(`${route} ${label}: live-only closure queued a protected-copy job`);
          }
          liveOnlyExits += 1;
        }
        const persistentSource = browserSources.find(({name, source_type: sourceType}) => (
          name === sourceName && sourceType === "wms"
        ));
        const persistentLayer = await page.locator(".opengeo-workbench").evaluate((shell, title) => (
          shell.__opengeoLayers?.some((layer) => layer.title === title && layer.sourceType === "wms-raster")
        ), sourceName);
        if (!persistentSource || !persistentLayer) {
          failures.push(`${route} ${label}: live-only closure did not retain the governed WMS source and map layer`);
        }
        const restoredFocus = await page.evaluate(() => ({
          tag: document.activeElement?.tagName ?? null,
          primaryCommand: document.activeElement?.dataset?.primaryCommand ?? null,
          visible: document.activeElement instanceof HTMLElement
            && document.activeElement.getBoundingClientRect().width > 0
            && document.activeElement.getBoundingClientRect().height > 0
        }));
        const expectedReturnCommand = configuration.compact ? "more" : "add-data";
        if (restoredFocus.tag !== "BUTTON"
          || restoredFocus.primaryCommand !== expectedReturnCommand
          || !restoredFocus.visible) {
          failures.push(`${route} ${label}: protected-copy closure did not restore a visible semantic source-workflow initiator (${JSON.stringify({expectedReturnCommand, restoredFocus})})`);
        }
        await assertArcgisDiscoverySurface(page, route, label, configuration.compact);
        exercised.push({viewport: configuration.id, colorScheme});
      }
    }

    await page.setViewportSize({width: 1440, height: 950});
    await visit(page, `${baseUrl}${route}`, `${route} ArcGIS protected copy desktop dark`);
    await page.locator(".opengeo-workbench").waitFor();
    await page.waitForFunction(() => Boolean(
      document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded?.()
    ));
    await setDataPreservationColorMode(page, "dark");
    await openArcgisPreservationPrompt(page, "Protected ArcGIS collection");
    const featureDialog = page.getByRole("dialog", {name: "Keep a protected copy?"});
    await featureDialog.waitFor();
    await assertDataPreservationDialogLayout(page, route, "ArcGIS desktop dark", false);
    await page.getByLabel("WGS84 bounds · west, south, east, north")
      .fill("-73.5, 42, -70, 43");
    await page.getByLabel("Maximum features · up to 50000").fill("5000");
    await page.getByLabel("Page size · up to 2000").fill("1000");
    const estimatesBefore = browserProtectedCopyEstimateRequests.length;
    await featureDialog.getByRole("button", {name: "Review protected copy", exact: true}).click();
    await page.locator('.opengeo-workbench[data-preservation-dialog-state="review"]').waitFor();
    const featureEstimate = browserProtectedCopyEstimateRequests.at(-1);
    if (browserProtectedCopyEstimateRequests.length !== estimatesBefore + 1
      || JSON.stringify(featureEstimate?.payload) !== JSON.stringify({
        source_type: "arcgis",
        scope: {
          kind: "bounded_features",
          bounds: [-73.5, 42, -70, 43],
          maximum_features: 5000,
          page_size: 1000
        }
      })) {
      failures.push(`${route} ArcGIS desktop dark: review did not use the exact bounded-feature estimate request (${JSON.stringify(featureEstimate)})`);
    }
    const featureReviewText = await featureDialog.innerText();
    if (!featureReviewText.includes("Bounded GeoJSON features")
      || !featureReviewText.includes("5")
      || containsStorageAuthority(featureReviewText)) {
      failures.push(`${route} ArcGIS desktop dark: feature-copy review omitted the bounded method/request count or exposed storage authority`);
    }
    await featureDialog.getByRole("button", {name: "Back", exact: true}).click();
    await featureDialog.getByRole("button", {name: "Keep live connection only", exact: true}).click();
    await featureDialog.waitFor({state: "detached"});
    exercised.push({viewport: "desktop", colorScheme: "dark", sourceType: "arcgis"});
  });

  if (browserProtectedCopyEstimateRequests.length !== 2
    || browserProtectedCopyQueueRequests.length !== 1
    || browserSourceDiscoveryRequests.length !== 12
    || queuedCopies !== 1
    || liveOnlyExits !== 5) {
    failures.push(`${route}: expected one reviewed/queued WMS copy, one reviewed ArcGIS copy, six two-step ArcGIS discoveries, and five responsive live-only exits (${JSON.stringify({estimates: browserProtectedCopyEstimateRequests.length, queues: browserProtectedCopyQueueRequests.length, discoveries: browserSourceDiscoveryRequests.length, queuedCopies, liveOnlyExits})})`);
  }
  if (failures.length === initialFailureCount) {
    acceptedDataPreservation = {
      schemaVersion: "opengeo.browser-data-preservation-acceptance.1.0.0",
      sourceTypes: ["wms", "arcgis"],
      environment: "managed Chromium with local deterministic API fixture",
      exercised,
      assertions: {
        oneBlockingDialog: true,
        containedWithoutHorizontalOverflow: true,
        compactTargetsAtLeast44Pixels: true,
        textContrastAtLeast4_5: true,
        focusTrapAndRestore: true,
        scopeAndMapStateSurviveResize: true,
        clientStorageAuthorityAbsent: true,
        liveOnlyQueueRequests: 0,
        reviewUsesServerSealedEstimate: true,
        queuedRequestStatus: 202,
        serverAssignedArchivePath: true,
        twoStepArcgisDiscovery: true,
        discoveryReviewBeforeRegistration: true
      },
      estimateRequests: browserProtectedCopyEstimateRequests.length,
      queueRequests: browserProtectedCopyQueueRequests.length,
      discoveryRequests: browserSourceDiscoveryRequests.length,
      screenshots: false,
      limitations: [
        "The 202 response is from the local deterministic API fixture; no outbound source copy or AWS queue was exercised.",
        "The ArcGIS path reviews but does not enqueue a copy; exact enqueue behavior remains covered by the jsdom workbench suite.",
        "ArcGIS discovery uses completed local deterministic jobs; live DNS, TLS, provider latency, retry, and queue activation remain deployment evidence.",
        "The managed vector-to-PMTiles queue remains covered by the jsdom workbench suite rather than this Chromium path."
      ]
    };
  }
}

async function setDataPreservationColorMode(page, expectedMode) {
  const currentMode = await page.locator(".opengeo-workbench").getAttribute("data-color-mode");
  if (currentMode === expectedMode) return;
  const actions = page.getByRole("button", {name: "Actions", exact: true});
  if (await actions.isVisible()) {
    await actions.click();
    const sheet = page.getByRole("dialog", {name: "Actions"});
    const settings = sheet.locator('[data-mobile-command-category="settings"]');
    await settings.locator("summary").click();
    await settings.getByRole("menuitem", {name: `Theme: ${expectedMode}`, exact: true}).click();
  } else {
    await page.getByRole("button", {name: "Settings", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="settings"] .gis-menu-item', {
      hasText: `Theme: ${expectedMode}`
    }).click();
  }
  await page.locator(`.opengeo-workbench[data-color-mode="${expectedMode}"]`).waitFor();
}

async function openWmsPreservationPrompt(page, sourceName) {
  const actions = page.getByRole("button", {name: "Actions", exact: true});
  if (await actions.isVisible()) {
    await actions.click();
    const sheet = page.getByRole("dialog", {name: "Actions"});
    await sheet.waitFor();
    const addCategory = sheet.locator('[data-mobile-command-category="add"]');
    await addCategory.locator("summary").click();
    await addCategory.getByRole("menuitem", {name: "WMS layer", exact: true}).click();
  } else {
    await page.getByRole("button", {name: "Add Data", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {hasText: "WMS layer"}).click();
  }
  await page.getByLabel("WMS endpoint").waitFor();
  await page.getByLabel("Layer title").fill(sourceName);
  await page.getByLabel("WMS endpoint").fill("https://tiles.example.test/wms");
  await page.getByLabel("Layer names").fill("workspace:layer");
  await page.getByRole("button", {name: "Register WMS source", exact: true}).click();
}

async function assertArcgisDiscoverySurface(page, route, label, compact) {
  const requestsBefore = browserSourceDiscoveryRequests.length;
  const actions = page.getByRole("button", {name: "Actions", exact: true});
  if (await actions.isVisible()) {
    await actions.click();
    const sheet = page.getByRole("dialog", {name: "Actions"});
    await sheet.waitFor();
    const addCategory = sheet.locator('[data-mobile-command-category="add"]');
    await addCategory.locator("summary").click();
    await addCategory.getByRole("menuitem", {name: "ArcGIS layer", exact: true}).click();
  } else {
    await page.getByRole("button", {name: "Add Data", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {
      hasText: "ArcGIS layer"
    }).click();
  }

  const serviceUrl = "https://services.example.test/arcgis/rest/services/environment/FeatureServer";
  await page.getByLabel("ArcGIS service URL").waitFor();
  await page.getByLabel("ArcGIS service URL").fill(serviceUrl);
  await page.getByRole("button", {name: "Find available layers", exact: true}).click();
  await page.getByRole("button", {name: "Inspect layer", exact: true}).waitFor();
  await page.getByRole("button", {name: "Inspect layer", exact: true}).click();
  await page.getByRole("button", {name: "Register ArcGIS layer", exact: true}).waitFor();

  const requests = browserSourceDiscoveryRequests.slice(requestsBefore);
  if (requests.length !== 2
    || JSON.stringify(requests.map(({payload}) => ({
      sourceType: payload.source_type,
      kind: payload.kind,
      serviceUrl: payload.service_url,
      collectionRef: payload.collection_ref
    }))) !== JSON.stringify([
      {sourceType: "arcgis", kind: "catalog", serviceUrl, collectionRef: null},
      {sourceType: "arcgis", kind: "collection", serviceUrl, collectionRef: "7"}
    ])) {
    failures.push(`${route} ${label}: ArcGIS discovery did not use one catalog job followed by one selected-layer job (${JSON.stringify(requests)})`);
  }
  if (containsStorageAuthority(JSON.stringify(requests.map(({payload}) => payload)))) {
    failures.push(`${route} ${label}: ArcGIS discovery request exposed client storage authority`);
  }

  const panelText = await page.locator(".gis-panel-right").innerText();
  for (const expected of [
    "Data Source Manager",
    "Available layers",
    "Environmental screening areas",
    "Confirm the selected fields, stable identity/order, rights, and attribution",
    "I reviewed the source terms, attribution, fields, and stable paging identity."
  ]) {
    if (!panelText.includes(expected)) {
      failures.push(`${route} ${label}: ArcGIS discovery review omitted ${JSON.stringify(expected)}`);
    }
  }
  if (containsStorageAuthority(panelText)) {
    failures.push(`${route} ${label}: ArcGIS discovery surface exposed bucket, key, or storage authority`);
  }
  const selectedFields = await page.locator(".gis-source-discovery")
    .getByLabel("Fields · comma separated")
    .inputValue();
  if (selectedFields !== "OBJECTID,name,screening_score") {
    failures.push(`${route} ${label}: ArcGIS discovery review did not preserve the server-selected field list (${JSON.stringify(selectedFields)})`);
  }

  const metrics = await page.locator(".gis-panel-right").evaluate((panel, expectedCompact) => {
    const panelBounds = panel.getBoundingClientRect();
    const visible = (candidate) => {
      const style = getComputedStyle(candidate);
      const bounds = candidate.getBoundingClientRect();
      const clipped = clippedBounds(candidate, bounds);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && bounds.width > 0
        && bounds.height > 0
        && clipped.right - clipped.left > 1
        && clipped.bottom - clipped.top > 1;
    };
    const discovery = panel.querySelector(".gis-source-discovery");
    const discoveryBounds = discovery?.getBoundingClientRect();
    const selector = 'button:not([disabled]), a[href], input:not([disabled]):not([type="range"]), select:not([disabled]), textarea:not([disabled]), summary';
    const discoveryTargets = discovery ? [...discovery.querySelectorAll(selector)] : [];
    const headerTargets = [...panel.querySelectorAll(".gis-panel-header button:not([disabled])")];
    const targets = [...discoveryTargets, ...headerTargets].filter(visible).map((candidate) => {
      const target = ["checkbox", "radio"].includes(candidate.type)
        ? candidate.closest("label") ?? candidate
        : candidate;
      const bounds = target.getBoundingClientRect();
      const clipped = clippedBounds(target, bounds);
      return {
        region: discovery?.contains(candidate) ? "discovery" : "header",
        label: candidate.getAttribute("aria-label")
          || target.textContent?.trim().replace(/\s+/g, " ").slice(0, 60)
          || candidate.tagName.toLowerCase(),
        left: clipped.left,
        right: clipped.right,
        top: clipped.top,
        bottom: clipped.bottom,
        width: bounds.width,
        height: bounds.height
      };
    });
    const overlaps = [];
    for (let left = 0; left < targets.length; left += 1) {
      for (let right = left + 1; right < targets.length; right += 1) {
        const a = targets[left];
        const b = targets[right];
        if (a.region === b.region
          && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          overlaps.push(`${a.label} <> ${b.label}`);
        }
      }
    }
    const contrast = [...(discovery?.querySelectorAll("h2, h3, p, strong, small, span, label, button, summary") ?? [])]
      .filter((candidate) => visible(candidate)
        && [...candidate.childNodes].some((node) => (
          node.nodeType === Node.TEXT_NODE && node.textContent.trim()
        )))
      .map((candidate) => {
        const foreground = parseColor(getComputedStyle(candidate).color);
        const background = resolvedBackground(candidate);
        return {
          label: candidate.textContent.trim().replace(/\s+/g, " ").slice(0, 60),
          ratio: contrastRatio(composite(foreground, background), background)
        };
      })
      .sort((left, right) => left.ratio - right.ratio);
    return {
      compact: expectedCompact,
      viewport: {width: innerWidth, height: innerHeight},
      panel: panelBounds.toJSON(),
      discovery: discoveryBounds?.toJSON() ?? null,
      panelOverflowX: panel.scrollWidth - panel.clientWidth,
      discoveryOverflowX: discovery ? discovery.scrollWidth - discovery.clientWidth : null,
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      targets,
      overlaps,
      lowestContrast: contrast[0] ?? null
    };

    function clippedBounds(target, bounds) {
      const clipped = {
        left: Math.max(0, panelBounds.left, bounds.left),
        right: Math.min(innerWidth, panelBounds.right, bounds.right),
        top: Math.max(0, panelBounds.top, bounds.top),
        bottom: Math.min(innerHeight, panelBounds.bottom, bounds.bottom)
      };
      for (let current = target.parentElement; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        const clipX = ["auto", "hidden", "scroll", "clip"].includes(style.overflowX);
        const clipY = ["auto", "hidden", "scroll", "clip"].includes(style.overflowY);
        if (clipX || clipY) {
          const ancestor = current.getBoundingClientRect();
          if (clipX) {
            clipped.left = Math.max(clipped.left, ancestor.left);
            clipped.right = Math.min(clipped.right, ancestor.right);
          }
          if (clipY) {
            clipped.top = Math.max(clipped.top, ancestor.top);
            clipped.bottom = Math.min(clipped.bottom, ancestor.bottom);
          }
        }
        if (current === panel) break;
      }
      return clipped;
    }

    function parseColor(value) {
      if (!value || value === "transparent") return {r: 0, g: 0, b: 0, a: 0};
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return {r, g, b, a};
      }
      const srgb = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
      if (srgb) {
        const [, r, g, b, a = "1"] = srgb;
        return {r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a)};
      }
      return {r: 0, g: 0, b: 0, a: 1};
    }

    function resolvedBackground(element) {
      for (let candidate = element; candidate; candidate = candidate.parentElement) {
        const color = parseColor(getComputedStyle(candidate).backgroundColor);
        if (color.a > 0) return composite(color, {r: 255, g: 255, b: 255, a: 1});
      }
      return {r: 255, g: 255, b: 255, a: 1};
    }

    function composite(top, bottom) {
      const alpha = top.a + bottom.a * (1 - top.a);
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha
      };
    }

    function contrastRatio(left, right) {
      const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function luminance(color) {
      const channels = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }
  }, compact);

  if (!metrics.discovery
    || metrics.panel.left < -1
    || metrics.panel.right > metrics.viewport.width + 1
    || metrics.panel.top < -1
    || metrics.panel.bottom > metrics.viewport.height + 1
    || metrics.panelOverflowX > 1
    || (metrics.discoveryOverflowX ?? 0) > 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${label}: ArcGIS discovery escaped or overflowed its panel (${JSON.stringify(metrics)})`);
  }
  if (metrics.overlaps.length) {
    failures.push(`${route} ${label}: ArcGIS discovery controls overlap (${metrics.overlaps.join(", ")})`);
  }
  if (metrics.lowestContrast && metrics.lowestContrast.ratio < 4.5) {
    failures.push(`${route} ${label}: ArcGIS discovery text contrast is below 4.5:1 (${JSON.stringify(metrics.lowestContrast)})`);
  }
  if (compact) {
    for (const target of metrics.targets) {
      if (target.width < 44 || target.height < 44) {
        failures.push(`${route} ${label}: ArcGIS discovery target ${JSON.stringify(target.label)} is smaller than 44px (${Math.round(target.width)}×${Math.round(target.height)})`);
      }
    }
  }
}

async function openArcgisPreservationPrompt(page, sourceName) {
  await page.getByRole("button", {name: "Add Data", exact: true}).click();
  await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {
    hasText: "ArcGIS layer"
  }).click();
  await page.locator(".gis-source-manual-registration summary").click();
  await page.getByLabel("ArcGIS layer URL").waitFor();
  await page.getByLabel("Layer title").fill(sourceName);
  await page.getByLabel("ArcGIS layer URL")
    .fill("https://services.example.test/arcgis/rest/services/environment/FeatureServer/0");
  await page.getByLabel("Object ID field").fill("OBJECTID");
  await page.locator(".gis-source-manual-registration")
    .getByLabel("Fields · comma separated")
    .fill("OBJECTID,name");
  await page.getByLabel("Geometry").selectOption("Polygon");
  await page.getByLabel("Page size · 1–2000").fill("1000");
  await page.getByLabel("Attribution", {exact: true}).fill("Example environmental agency");
  await page.getByRole("button", {name: "Register ArcGIS feature source", exact: true}).click();
}

async function assertPreservationScope(page, route, label, expected) {
  const dialog = page.getByRole("dialog", {name: "Keep a protected copy?"});
  if (await dialog.count() !== 1) {
    failures.push(`${route} ${label}: protected-copy dialog did not survive the viewport change`);
    return;
  }
  const actual = {
    bounds: await page.getByLabel("WGS84 bounds · west, south, east, north").inputValue(),
    width: await page.getByLabel("Output width").inputValue(),
    height: await page.getByLabel("Output height").inputValue()
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${route} ${label}: bounded WMS scope changed across resize (${JSON.stringify({expected, actual})})`);
  }
}

async function assertDataPreservationDialogLayout(page, route, label, compact) {
  const dialog = page.getByRole("dialog", {name: "Keep a protected copy?"});
  const metrics = await dialog.evaluate((element) => {
    const visible = (candidate) => {
      const style = getComputedStyle(candidate);
      const rectangle = candidate.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rectangle.width > 0
        && rectangle.height > 0;
    };
    const rectangle = element.getBoundingClientRect();
    const body = element.querySelector(".gis-preservation-body");
    const backdrop = element.closest(".gis-preservation-backdrop")?.getBoundingClientRect();
    const targets = [...element.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]):not([type="range"]), select:not([disabled]), textarea:not([disabled]), summary'
    )].filter(visible).map((candidate) => {
      const target = ["checkbox", "radio"].includes(candidate.type)
        ? candidate.closest("label") ?? candidate
        : candidate;
      const bounds = target.getBoundingClientRect();
      const clipped = clippedBounds(target, bounds);
      return {
        label: candidate.getAttribute("aria-label")
          || target.textContent?.trim().replace(/\s+/g, " ").slice(0, 60)
          || candidate.tagName.toLowerCase(),
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
        visibleLeft: clipped.left,
        visibleRight: clipped.right,
        visibleTop: clipped.top,
        visibleBottom: clipped.bottom
      };
    });
    const intersectingTargets = targets.filter((target) => (
      target.visibleRight - target.visibleLeft > 1
      && target.visibleBottom - target.visibleTop > 1
    ));
    const overlaps = [];
    for (let left = 0; left < intersectingTargets.length; left += 1) {
      for (let right = left + 1; right < intersectingTargets.length; right += 1) {
        const a = intersectingTargets[left];
        const b = intersectingTargets[right];
        if (Math.min(a.visibleRight, b.visibleRight) - Math.max(a.visibleLeft, b.visibleLeft) > 1
          && Math.min(a.visibleBottom, b.visibleBottom) - Math.max(a.visibleTop, b.visibleTop) > 1) {
          overlaps.push(`${a.label} <> ${b.label}`);
        }
      }
    }
    const textContrast = [...element.querySelectorAll("h2, p, strong, span, label, button")]
      .filter((candidate) => visible(candidate)
        && [...candidate.childNodes].some((node) => (
          node.nodeType === Node.TEXT_NODE && node.textContent.trim()
        )))
      .map((candidate) => {
        const foreground = parseColor(getComputedStyle(candidate).color);
        const background = resolvedBackground(candidate);
        return {
          label: candidate.textContent.trim().replace(/\s+/g, " ").slice(0, 60),
          ratio: contrastRatio(composite(foreground, background), background)
        };
      });
    const lowestContrast = textContrast.sort((left, right) => left.ratio - right.ratio)[0] ?? null;
    const shell = element.closest(".opengeo-workbench");
    const modalLayer = element.closest(".gis-modal-layer");
    const inertBackground = [...shell.children]
      .filter((child) => child !== modalLayer)
      .every((child) => child.inert && child.getAttribute("aria-hidden") === "true");
    return {
      viewport: {width: innerWidth, height: innerHeight},
      dialog: rectangle.toJSON(),
      backdrop: backdrop?.toJSON() ?? null,
      dialogOverflowX: element.scrollWidth - element.clientWidth,
      bodyOverflowX: body ? body.scrollWidth - body.clientWidth : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight + 1 : false,
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      blockingDialogs: [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible).length,
      inertBackground,
      targets,
      overlaps,
      lowestContrast
    };

    function clippedBounds(target, bounds) {
      const clipped = {
        left: Math.max(0, bounds.left),
        right: Math.min(innerWidth, bounds.right),
        top: Math.max(0, bounds.top),
        bottom: Math.min(innerHeight, bounds.bottom)
      };
      for (let current = target.parentElement; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        const clipX = ["auto", "hidden", "scroll", "clip"].includes(style.overflowX);
        const clipY = ["auto", "hidden", "scroll", "clip"].includes(style.overflowY);
        if (clipX || clipY) {
          const ancestor = current.getBoundingClientRect();
          if (clipX) {
            clipped.left = Math.max(clipped.left, ancestor.left);
            clipped.right = Math.min(clipped.right, ancestor.right);
          }
          if (clipY) {
            clipped.top = Math.max(clipped.top, ancestor.top);
            clipped.bottom = Math.min(clipped.bottom, ancestor.bottom);
          }
        }
        if (current === element) break;
      }
      return clipped;
    }

    function parseColor(value) {
      if (!value || value === "transparent") return {r: 0, g: 0, b: 0, a: 0};
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return {r, g, b, a};
      }
      const srgb = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
      if (srgb) {
        const [, r, g, b, a = "1"] = srgb;
        return {r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a)};
      }
      return {r: 0, g: 0, b: 0, a: 1};
    }

    function resolvedBackground(candidate) {
      let background = {r: 0, g: 0, b: 0, a: 0};
      for (let current = candidate; current; current = current.parentElement) {
        background = composite(background, parseColor(getComputedStyle(current).backgroundColor));
        if (background.a >= 0.999) return background;
      }
      return composite(background, {r: 255, g: 255, b: 255, a: 1});
    }

    function composite(top, bottom) {
      const alpha = top.a + bottom.a * (1 - top.a);
      if (!alpha) return {r: 0, g: 0, b: 0, a: 0};
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha
      };
    }

    function contrastRatio(left, right) {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    }

    function luminance(color) {
      const channels = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }
  });
  if (metrics.blockingDialogs !== 1 || !metrics.inertBackground) {
    failures.push(`${route} ${label}: expected one blocking dialog with an inert background (${JSON.stringify({dialogs: metrics.blockingDialogs, inert: metrics.inertBackground})})`);
  }
  if (!metrics.backdrop
    || metrics.backdrop.left > 1
    || metrics.backdrop.top > 1
    || metrics.backdrop.right < metrics.viewport.width - 1
    || metrics.backdrop.bottom < metrics.viewport.height - 1
    || metrics.dialog.left < -1
    || metrics.dialog.top < -1
    || metrics.dialog.right > metrics.viewport.width + 1
    || metrics.dialog.bottom > metrics.viewport.height + 1
    || metrics.dialogOverflowX > 1
    || metrics.bodyOverflowX > 1
    || metrics.documentOverflowX > 1) {
    failures.push(`${route} ${label}: protected-copy dialog escaped or overflowed its viewport (${JSON.stringify(metrics)})`);
  }
  if (metrics.overlaps.length) {
    failures.push(`${route} ${label}: protected-copy controls overlap (${metrics.overlaps.join(", ")})`);
  }
  if (compact) {
    for (const target of metrics.targets) {
      if (target.width < 44 || target.height < 44) {
        failures.push(`${route} ${label}: ${target.label} target is smaller than 44px (${target.width.toFixed(1)}×${target.height.toFixed(1)})`);
      }
    }
  }
  if (!metrics.lowestContrast || metrics.lowestContrast.ratio < 4.5) {
    failures.push(`${route} ${label}: protected-copy text contrast is ${metrics.lowestContrast?.ratio.toFixed(2) ?? "unavailable"}:1 for ${metrics.lowestContrast?.label ?? "unknown text"}`);
  }
}

function containsStorageAuthority(value) {
  return /(?:s3:\/\/|amazonaws\.com|\bbucket\b|\bobject[_ -]?key\b|\bdestination[_ -]?key\b)/i.test(String(value));
}

async function assertBasemapGovernanceWorkflow(browser, baseUrl) {
  const projectId = IDS.projects[1];
  const mapId = IDS.maps[1];
  const key = `${projectId}:${mapId}`;
  const previous = browserMapOverrides.get(key);
  const baseline = mapPayloadForProject(projectId);
  browserMapOverrides.set(key, {
    ...baseline,
    definition: {
      ...baseline.definition,
      basemaps: [{
        basemapId: "carto-positron",
        title: "CARTO Positron",
        kind: "raster",
        url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        attribution: "CARTO, OpenStreetMap contributors",
        visible: true,
        opacity: 1
      }]
    }
  });
  try {
    await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
      const route = `/workspaces?project=${projectId}&map=${mapId}`;
      await page.route("https://tiles.openfreemap.org/**", async (requestRoute) => {
        await requestRoute.fulfill({status: 204, body: ""});
      });
      await page.route("https://tiles.openfreemap.org/styles/**", async (requestRoute) => {
        await requestRoute.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({version: 8, name: "Governed replacement", sources: {}, layers: []})
        });
      });
      await visit(page, `${baseUrl}${route}`, `${route} retired basemap governance`);
      const shell = page.locator('.opengeo-workbench[data-basemap-lifecycle="retired"]');
      await shell.waitFor();
      await page.getByRole("button", {name: /Background · CARTO Positron/}).waitFor();
      if (!/retired/i.test(await page.locator(".gis-statusbar").innerText())) {
        failures.push(`${route}: restored retired basemap did not explain its catalog lifecycle`);
      }

      lastMapUpdate = null;
      await page.getByRole("button", {name: "Save", exact: true}).click();
      await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
      const retained = lastMapUpdate?.definition?.basemaps?.find(({visible}) => visible);
      if (retained?.basemapId !== "carto-positron"
        || retained?.url !== "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
        || retained?.attribution !== "CARTO, OpenStreetMap contributors") {
        failures.push(`${route}: saving a retired source did not preserve its exact project record`);
      }

      await page.getByRole("button", {name: /Background · CARTO Positron/}).click();
      const dialog = page.getByRole("dialog", {name: "Change basemap"});
      await dialog.waitFor();
      const retired = dialog.locator('.gis-basemap-card[data-catalog-id="carto-positron"]');
      if (await retired.getAttribute("data-availability") !== "retired"
        || await retired.getAttribute("aria-pressed") !== "true") {
        failures.push(`${route}: exact retired selection was not retained as the active catalog record`);
      }
      lastMapUpdate = null;
      await retired.click();
      await dialog.getByRole("button", {name: "Use Positron instead"}).waitFor();
      if (lastMapUpdate !== null) {
        failures.push(`${route}: inspecting retirement silently rewrote the saved project map`);
      }
      if (screenshotsEnabled) {
        await page.screenshot({
          path: join(artifactRoot, "basemap-governance-retired-dark.png"),
          fullPage: true
        });
      }
      await dialog.getByRole("button", {name: "Keep exact saved selection"}).click();
      await dialog.getByText("No project map was changed.", {exact: false}).waitFor();
      await retired.click();
      await dialog.getByRole("button", {name: "Use Positron instead"}).click();
      await page.waitForFunction(() => (
        document.querySelector('.gis-basemap-card[data-catalog-id="openfreemap-positron"]')
          ?.getAttribute("aria-pressed") === "true"
      ));
      if (browserMapOverrides.get(key)?.definition?.basemaps?.find(({visible}) => visible)?.basemapId !== "carto-positron"
        || lastMapUpdate !== null) {
        failures.push(`${route}: replacement changed authoritative state before explicit Save`);
      }
      if (screenshotsEnabled) {
        await page.screenshot({
          path: join(artifactRoot, "basemap-governance-explicit-replacement-dark.png"),
          fullPage: true
        });
      }
      await dialog.getByRole("button", {name: "Done"}).click();
      await page.getByRole("button", {name: "Save", exact: true}).click();
      await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
      if (lastMapUpdate?.definition?.basemaps?.find(({visible}) => visible)?.basemapId !== "openfreemap-positron") {
        failures.push(`${route}: explicit reviewed replacement was not saved`);
      }
      await page.reload({waitUntil: "domcontentloaded"});
      await page.locator('.opengeo-workbench[data-basemap-lifecycle="active"]').waitFor();
      await page.getByRole("button", {name: /Background · Positron/}).waitFor();
    });
  } finally {
    if (previous) browserMapOverrides.set(key, previous);
    else browserMapOverrides.delete(key);
  }
}

async function assertBasemapProviderConnectionWorkflow(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const route = "/workspaces?view=sources";
    await visit(page, `${baseUrl}${route}`, `${route} Protomaps connection setup`);
    await page.getByRole("heading", {name: "Connections", exact: true}).waitFor();
    const providers = page.locator(".platform-basemap-connections");
    await providers.getByRole("button", {name: "Save provider connection"}).click();
    let record = providers.locator(".platform-connection-record", {hasText: "Protomaps hosted API"});
    await record.waitFor();
    await record.locator(":scope > summary").click();
    await record.getByLabel("Protomaps API key").fill("browser-check-origin-key");
    await record.getByRole("button", {name: "Store browser key"}).click();
    record = providers.locator(".platform-connection-record", {hasText: "Protomaps hosted API"});
    await record.locator(".badge.configured").waitFor();
    await record.locator(":scope > summary").click();
    const bindingForm = record.locator(".platform-inline-admin-form");
    await bindingForm.locator("select").selectOption(IDS.projects[0]);
    await bindingForm.getByRole("button", {name: "Add to project"}).click();
    await bindingForm.getByText("Basemap provider added. No key was copied into the project.").waitFor();
    if ((await page.locator("body").innerText()).includes("browser-check-origin-key")) {
      failures.push(`${route}: write-only Protomaps browser key was rendered in account connection UI`);
    }
    if (await record.getByLabel("Protomaps API key").inputValue()) {
      failures.push(`${route}: Protomaps browser key remained in the password input after rotation`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, "platform-protomaps-connection-dark.png"),
        fullPage: true
      });
    }
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    const providerRequestsBefore = browserProtomapsRequests.length;
    await visit(page, `${baseUrl}${route}`, `${route} connected Protomaps basemap`);
    await page.locator(".opengeo-workbench").waitFor();
    await page.getByRole("button", {name: /Background · /}).click();
    const dialog = page.getByRole("dialog", {name: "Change basemap"});
    await dialog.waitFor();
    if (!await dialog.innerText().then((value) => value.includes("1 configured"))) {
      failures.push(`${route}: chooser did not report its configured basemap-provider connection`);
    }
    const dark = dialog.locator('.gis-basemap-card[data-catalog-id^="provider-protomaps-"][data-catalog-id$="-dark"]', {
      has: page.getByText("Dark", {exact: true})
    });
    if (await dark.getAttribute("data-unavailable") === "true") {
      failures.push(`${route}: configured Protomaps Dark remained unavailable`);
    }
    await dark.click();
    await page.waitForFunction(() => document.querySelector(
      '.gis-basemap-card[data-catalog-id^="provider-protomaps-"][data-catalog-id$="-dark"]'
    )?.getAttribute("aria-pressed") === "true");
    if (browserProtomapsRequests.length <= providerRequestsBefore) {
      failures.push(`${route}: selecting Protomaps Dark did not request the authorized provider style`);
    }
    await dialog.getByRole("button", {name: "Done"}).click();
    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const savedBasemap = lastMapUpdate?.definition?.basemaps?.find(({visible}) => visible);
    if (savedBasemap?.kind !== "provider-style"
      || savedBasemap?.provider !== "protomaps"
      || savedBasemap?.connectionBindingId !== IDS.basemapConnectionBinding
      || savedBasemap?.flavor !== "dark"
      || Object.hasOwn(savedBasemap ?? {}, "url")
      || Object.hasOwn(savedBasemap ?? {}, "styleUrl")
      || JSON.stringify(lastMapUpdate?.definition).includes("browser-check-origin-key")) {
      failures.push(`${route}: saved provider basemap did not retain only its binding and flavor`);
    }
    await page.reload({waitUntil: "domcontentloaded"});
    await page.locator(".opengeo-workbench").waitFor();
    await page.getByRole("button", {name: /Background · Protomaps Dark/}).waitFor();
    if ((await page.locator("body").innerText()).includes("browser-check-origin-key")) {
      failures.push(`${route}: resolved Protomaps browser key was rendered after map reload`);
    }
    if (screenshotsEnabled) {
      await page.screenshot({
        path: join(artifactRoot, "workbench-protomaps-connected-dark.png"),
        fullPage: true
      });
    }
  });
}

async function assertGeoLibreRendererImport(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    let providerFixtures = 0, requests = 0;
    page.on("request", () => { requests++; });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl) return route.fallback();
      // These exact URLs are handled by withPlatformPage's upload fixtures.
      if (url.href === "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools") return route.fallback();
      providerFixtures++;
      assert.ok(providerFixtures <= 100, "Bounded external-response fixtures");
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({contentType: "text/css", body: ""});
      return route.fulfill({contentType: "application/json", body: JSON.stringify({version: 8, sources: {}, layers: []})});
    });
    const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    await visit(page, `${baseUrl}${route}`, "GeoLibre renderer import");
    await page.locator(".opengeo-workbench").waitFor();
    const project = JSON.parse(geolibreProjectBytes);
    project.primaryRenderer = "cesium";
    // One embedded dataset exercises the shared upload/bind/finalize path.
    // Existing source-family evidence covers external-source registration.
    project.layers = [project.layers[0]];
    const projectMenu = page.locator('.gis-menu-wrap[data-menu="project"]');
    await projectMenu.locator(".gis-menu-button").click();
    const choosingProject = page.waitForEvent("filechooser");
    await projectMenu.getByRole("menuitem", {name: /^Open Project file…/}).click();
    await (await choosingProject).setFiles({name: "renderer.geolibre.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project))});
    const review = page.getByRole("dialog", {name: "Review Project file", exact: true});
    await review.getByText("GeoLibre Project", {exact: false}).waitFor();
    await review.getByRole("button", {name: "Download conversion report", exact: true}).waitFor();
    assert.equal(browserImports.size, 0, "Inspection must not create an import");
    await review.getByRole("button", {name: "Open in this Project", exact: true}).click();
    await page.locator(".gis-layer-row", {hasText: project.layers[0].name}).waitFor();
    const operation = [...browserImports.values()][0];
    assert.equal(operation.state, "completed");
    assert.equal(operation.request.source_version, "3.0.0");
    assert.deepEqual(importedMapDefinition.extensions.opengeoRenderer, {id: "cesium"});
    assert.equal(importedMapDefinition.layers[0].datasetId, IDS.importEmbeddedDataset);
    assert.equal(JSON.stringify(importedMapDefinition.layers).includes('"import:'), false);
    const retained = structuredClone(importedMapDefinition);
    await page.reload({waitUntil: "load"});
    await page.locator(".gis-layer-row", {hasText: project.layers[0].name}).waitFor();
    await projectMenu.locator(".gis-menu-button").click();
    await projectMenu.getByRole("menuitem", {name: /^Save as \/ export…/}).click();
    const exportDialog = page.getByRole("dialog", {name: "Save as or export Project", exact: true});
    await exportDialog.getByRole("combobox", {name: "Project export format"}).selectOption("geolibre");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportDialog.getByRole("button", {name: "Export file", exact: true}).click()
    ]).catch(async (error) => {
      throw new Error(`${error.message}; export status: ${await page.locator(".gis-statusbar").innerText()}`);
    });
    const bytes = await readFile(await download.path());
    const exported = JSON.parse(bytes);
    await exportDialog.getByRole("button", {name: "Close", exact: true}).click();
    assert.equal(exported.primaryRenderer, "cesium");
    assert.equal(exported.layers[0].id, project.layers[0].id);
    assert.deepEqual(exported.metadata.opengeo.definitionExtensions.opengeoRenderer, {id: "cesium"});
    assert.deepEqual(importedMapDefinition, retained, "Reopening/exporting must not mutate saved state");
    await page.locator(".gis-statusbar", {hasText: "GeoLibre 3.0.0 project exported"}).waitFor();
    mkdirSync(artifactRoot, {recursive: true});
    await writeFile(resolve(artifactRoot, "geolibre-renderer-export.json"), bytes);
    console.log(JSON.stringify({status: "pass", workflow: "geolibre-renderer-import", inspectedWithoutWrite: true, embeddedDatasetBound: true, referenceVersion: "3.0.0", reopenAndExport: true, requests, providerFixtures, externalRequests: 0, limits: "Built Studio with fixture identity/API/storage; one embedded dataset; not upstream desktop or deployed acceptance."}));
  });
}

async function assertPlatformStates(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: null}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "/workspaces unauthenticated");
    await page.waitForURL(/\/oauth2\/authorize/);
    const transaction = await page.evaluate(() => JSON.parse(
      sessionStorage.getItem("opengeo.oauthTransaction")
    ));
    if (transaction?.returnTo !== "/workspaces") {
      failures.push("unauthenticated project directory: protected destination was not retained");
    }
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "/workspaces live API");
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    await expectText(page, "Live API adapter · PostgreSQL-backed records", "live adapter banner");
    await expectText(page, "Nepal Energy Access", "API-backed project directory");
    if (await page.getByRole("button", {name: "Sign out", exact: true}).count() !== 1) {
      failures.push("API-backed project directory: expected one visible Sign out control");
    }
    const navigation = page.getByRole("navigation", {name: "Studio navigation", exact: true});
    await navigation.getByRole("link", {name: "Catalog", exact: true}).click();
    await navigation.locator('a[aria-current="page"]', {hasText: "Catalog"}).waitFor();
    await page.getByLabel("Search organization datasets").fill("Access Road");
    await page.getByRole("button", {name: "Search catalog"}).click();
    await page.locator(".platform-catalog-table").first().waitFor();
    await page.getByText("1 authorized dataset found.", {exact: true}).waitFor();
    await expectText(page, "1 authorized dataset found", "organization catalog discovery");
    await expectText(page, "Access Road Network", "organization catalog result");
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const staleProjectId = "a111a1f2-bf60-43a3-8d6e-97a440985cb7";
    const route = `/workspaces?project=${staleProjectId}`;
    const expectedProjects = allProjectPayloads().slice(0, 10);
    await visit(page, `${baseUrl}${route}`, `${route} stale project recovery`);
    await page.locator('.platform-state[data-state="not_found"] .platform-project-recovery-list').waitFor();
    await expectText(page, "Project not found", "stale project recovery explanation");
    await expectText(page, "Projects currently visible to you", "stale project recovery directory");
    const links = page.locator(".platform-project-recovery-list a");
    if (await links.count() !== expectedProjects.length) {
      failures.push(`${route}: stale project recovery did not retain the authorized project directory`);
    }
    for (const project of expectedProjects) {
      if (await links.filter({hasText: project.name}).count() !== 1) {
        failures.push(`${route}: stale project recovery omitted ${project.name}`);
      }
    }
    const recoveryLayout = await page.locator(".platform-project-recovery-list").evaluate((container) => ({
      overflow: container.scrollWidth - container.clientWidth,
      links: [...container.querySelectorAll("a")].map((link) => ({
        text: link.textContent.trim(),
        width: link.getBoundingClientRect().width,
        height: link.getBoundingClientRect().height
      }))
    }));
    if (recoveryLayout.overflow > 1 || recoveryLayout.links.some(({width, height}) => width < 44 || height < 44)) {
      failures.push(`${route}: stale project recovery overflowed or exposed a target smaller than 44 pixels`);
    }
  });

  await assertBasemapProviderConnectionWorkflow(browser, baseUrl);

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const route = `/workspaces?project=${IDS.projects[0]}&manage=data#project-data`;
    await visit(page, `${baseUrl}${route}`, `${route} managed upload`);
    await page.locator(".project-datasets").waitFor();
    const pdfOption = page.getByRole("option", {name: "PDF document"});
    if (await pdfOption.count() !== 2) {
      failures.push(`${route}: expected PDF in upload and catalog format controls`);
    }
    const odtOption = page.getByRole("option", {name: "OpenDocument text"});
    if (await odtOption.count() !== 2) {
      failures.push(`${route}: expected ODT in upload and catalog format controls`);
    }
    await expectText(page, "Access Road Network", "API-backed dataset catalog");
    await expectText(page, "Field report", "governed ODF dataset");
    const odtCard = page.locator(`[data-dataset-id="${IDS.odtDataset}"]`);
    await odtCard.getByRole("button", {name: "Version history"}).click();
    await odtCard.getByRole("button", {name: "Read accessible preview"}).click();
    await odtCard.locator(".project-document-preview-content").waitFor();
    const odtText = await odtCard.innerText();
    if (!odtText.includes("नेपाल field report")) {
      failures.push("Unicode ODF preview title was not rendered");
    }
    if (!odtText.includes("Kathmandu")) {
      failures.push("semantic ODF table content was not rendered");
    }
    if (await odtCard.locator("th[scope=col]").count() !== 2) {
      failures.push(`${route}: expected scoped ODF table headers`);
    }
    const pdfCard = page.locator(`[data-dataset-id="${IDS.pdfDataset}"]`);
    await pdfCard.getByRole("button", {name: "Version history"}).click();
    await pdfCard.getByRole("button", {name: "Read accessible preview"}).click();
    await pdfCard.locator(".project-document-preview-content").waitFor();
    const pdfText = await pdfCard.innerText();
    if (!pdfText.includes("All-page semantic PDF 1.7 text")) {
      failures.push("all-page PDF semantic disclosure was not rendered");
    }
    if (!pdfText.includes("Exact first-page PDF text")) {
      failures.push("semantic PDF page text was not rendered");
    }
    if (!pdfText.includes("No extractable text was found on this page")) {
      failures.push("empty PDF page accessibility limitation was not rendered");
    }
    await expectText(page, "Convert it to a COG", "actionable worker validation result");
    await expectText(page, "Error code: cog_layout_required", "safe worker error code");
    await visit(
      page,
      `${baseUrl}/workspaces?project=${IDS.projects[0]}&manage=resources#project-resources`,
      `${route} project resources`
    );
    await page.locator(".project-resources").waitFor();
    await expectText(page, "Project resources", "governed publishing catalog");
    await visit(
      page,
      `${baseUrl}/workspaces?project=${IDS.projects[0]}&manage=publishing#project-publishing`,
      `${route} project publishing`
    );
    await page.locator(".project-sites").waitFor();
    await expectText(page, "Project sites and portable editions", "general site publishing");
    await expectText(page, "Research field report · research-field-report", "durable site identity");
    await expectText(page, "map optional", "non-map site publishing boundary");
    await expectText(page, "Positioned multi-frame pages", "durable positioned print editor");
    const starterLayout = page.getByRole("button", {
      name: "Insert accessible starter layout"
    });
    const positionedEditor = starterLayout.locator("xpath=ancestor::fieldset[1]");
    await starterLayout.click();
    await positionedEditor.locator(
      '.project-positioned-layout-preview[data-state="valid"]'
    ).waitFor();
    await expectText(page, "positioned page", "positioned layout preview validation");
    await positionedEditor.locator(".project-positioned-layout-frame-select").first().click();
    await positionedEditor.getByRole("button", {name: "Rotate +15°"}).click();
    await positionedEditor.getByLabel("Advanced layout JSON").waitFor();
    if (!await positionedEditor.getByLabel("Advanced layout JSON").inputValue().then((value) => (
      value.includes('"schemaVersion": "opengeo.print-layout.1.1.0"')
      && value.includes('"rotation": 15')
      && value.includes('"clip": true')
    ))) throw new Error("rich positioned layout controls did not update the sealed 1.1 contract");
    await expectText(page, "Observable Framework projects", "Observable source project workspace");
    await expectText(page, "network deny_all", "credential-free compiler policy");
    try {
      await page.getByLabel("Source files").setInputFiles([
        {
          name: "index.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Browser Observable source")
        },
        {
          name: "package-lock.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"lockfileVersion":3}')
        }
      ]);
    } catch {
      throw new Error(
        `Observable source editor was unavailable: ${await page.locator(".observable-source-workspace").innerText()}`
      );
    }
    await page.getByRole("button", {name: "Commit exact source revision"}).click();
    await page.getByText(/source revision 1/).waitFor();
    if (browserObservableSourceRevisions.length !== 1) {
      failures.push(`${route}: exact Observable source revision was not committed`);
    }
    await page.getByRole("button", {name: "Stage private preview build"}).click();
    await page.getByText(/API execution not_configured\. Nothing was published\./).waitFor();
    if (browserObservableBuilds[0]?.state !== "pending") {
      failures.push(`${route}: Observable preview did not remain an inert pending build record`);
    }
    await expectText(page, "Publication remains blocked", "public resource publication gate");
    await page.getByRole("button", {name: "Submit revision for review"}).click();
    await page.locator('.project-site-card[data-state="review"]').waitFor();
    const publishSite = page.getByRole("button", {name: "Publish reviewed edition"});
    if (!(await publishSite.isDisabled())) {
      failures.push(`${route}: site publication bypassed the public resource gate`);
    }
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const route = `/workspaces?project=${IDS.projects[0]}&manage=services#project-services`;
    await visit(page, `${baseUrl}${route}`, `${route} administered services`);
    await page.locator(".project-services").waitFor();
    try {
      const serviceHeading = page.locator(".project-service-card-heading");
      await serviceHeading.getByRole("heading", {name: "Research atlas"}).waitFor();
      await serviceHeading.getByText("active · research-atlas").waitFor();
    } catch (error) {
      const renderedState = (await page.locator(".project-services").innerText())
        .replaceAll(/\s+/g, " ")
        .trim();
      throw new Error(
        `${route}: administered service catalog never reached its resolved state; rendered service state: ${renderedState}`,
        {cause: error}
      );
    }
    await expectText(page, "Administered spatial services", "administered service catalog");
    await expectText(page, "active · research-atlas", "service identifier and status");
    await page.getByText("Published objects · 2", {exact: true}).click();
    await expectText(page, "roads · sealed and current", "immutable service collection seal");
    await expectText(page, "g3 / profile v2", "service seal versions");
    await page.locator(".project-service-binding", {hasText: "roads · sealed and current"})
      .locator(":scope > summary").click();
    await expectText(page, "Bounded WMTS seed plans", "bounded tile seed plan catalog");
    await expectText(page, "inactive compute cost is $0", "zero-idle tile seed boundary");
    const extentMap = page.getByRole("application", {name: "CRS84 tile seed extent map"});
    await extentMap.locator("canvas.maplibregl-canvas").waitFor();
    try {
      await page.locator(
        '.tile-seed-extent-map[data-ready="true"]'
      ).waitFor({timeout: 5_000});
    } catch (error) {
      const status = await page.locator(".tile-seed-extent-status").textContent();
      throw new Error(
        `Tile seed extent map did not become ready; status=${status}; pageErrors=${failures.join(" | ")}`,
        {cause: error}
      );
    }
    await page.getByRole("button", {name: "Draw seed extent"}).click();
    const extentBox = await extentMap.boundingBox();
    if (!extentBox) {
      failures.push(`${route}: map-drawn tile seed extent had no browser bounds`);
    } else {
      await page.mouse.move(
        extentBox.x + extentBox.width * 0.3,
        extentBox.y + extentBox.height * 0.35
      );
      await page.mouse.down();
      await page.mouse.move(
        extentBox.x + extentBox.width * 0.62,
        extentBox.y + extentBox.height * 0.68,
        {steps: 6}
      );
      await page.mouse.up();
    }
    await page.getByLabel("Maximum zoom").fill("1");
    const west = await page.getByLabel("West longitude").inputValue();
    const south = await page.getByLabel("South latitude").inputValue();
    const east = await page.getByLabel("East longitude").inputValue();
    const north = await page.getByLabel("North latitude").inputValue();
    if (!west || !south || !east || !north
      || !(Number(west) < Number(east) && Number(south) < Number(north))) {
      throw new Error(
        `${route}: map drag did not produce an ordered CRS84 extent: ${JSON.stringify({west, south, east, north})}`
      );
    }
    await page.getByRole("button", {name: "Preview drawn extent seed plan"}).click();
    try {
      await page.getByRole(
        "button", {name: "Confirm and activate render workers"}
      ).waitFor({timeout: 5_000});
    } catch (error) {
      const feedback = await page.locator(
        ".tile-seed-plan-catalog .project-resource-feedback"
      ).allTextContents();
      throw new Error(`Tile seed extent preview did not reach confirmation: ${feedback.join(" | ")}`, {
        cause: error
      });
    }
    await expectText(page, "2 exact tiles will be queued", "tile seed preview target count");
    await page.getByRole("button", {name: "Confirm and activate render workers"}).click();
    await page.getByText(/queued · 2 targets/).waitFor();
    await expectText(page, "explicit confirmation", "tile seed activation boundary");
    await expectText(page, "Retired WMTS render outputs", "retired cache catalog");
    await expectText(page, "Reads and timers never queue deletion", "cache activation boundary");
    await page.getByRole("button", {name: "Preview retired-cache reclamation"}).click();
    await page.getByRole(
      "button", {name: "Confirm exact render-version deletion"}
    ).waitFor();
    await expectText(page, "1 exact storage version totaling 67 bytes", "cache byte preview");
    await expectText(
      page, "Render jobs, cache generations, coordinates, and audit history remain",
      "cache history retention"
    );
    await page.getByRole("button", {name: "Confirm exact render-version deletion"}).click();
    const queuedCacheGeneration = page.getByText(/cache generation 1.*reclamation queued/);
    try {
      await queuedCacheGeneration.waitFor();
    } catch (error) {
      const management = await page.locator("body").evaluate((body) => {
        const workspace = body.querySelector(".platform-workspace");
        return {
          state: workspace?.querySelector("[data-state]")?.dataset.state ?? null,
          text: body.innerText.slice(-4_000)
        };
      });
      throw new Error(
        `${route}: refreshed cache reclamation state was not visible: ${JSON.stringify(management)}; failures=${failures.join(" | ")}`,
        {cause: error}
      );
    }
    await expectText(page, "reclamation queued", "explicit cache reclamation confirmation");
    await expectText(page, "at least 24 hours old", "bounded physical reclamation age");
    await expectText(page, "inactive fixed-cost change is $0", "zero-idle reclamation boundary");
    await expectText(page, "elevation · sealed and current", "exact coverage seal");
    await page.locator(".project-service-binding", {hasText: "elevation · sealed and current"})
      .locator(":scope > summary").click();
    await page.getByRole("button", {name: "Preview physical reclamation"}).click();
    await page.getByRole("button", {name: "Confirm exact-version deletion"}).waitFor();
    await expectText(page, "exact 8,192-byte COG", "physical reclamation byte preview");
    await expectText(page, "request and result metadata remain", "retained reclamation history");
    await page.getByRole("button", {name: "Confirm exact-version deletion"}).click();
    try {
      await page.getByText(
        "Physical reclamation: queued. Derivative history remains retained."
      ).waitFor();
    } catch (error) {
      const state = await page.locator("body").evaluate((body) => ({
        workspaceState: body.querySelector(".platform-workspace [data-state]")?.dataset.state ?? null,
        services: body.querySelector(".project-services")?.innerText.slice(-2_000) ?? null
      }));
      throw new Error(
        `${route}: refreshed coverage reclamation state was not visible: ${JSON.stringify(state)}; failures=${failures.join(" | ")}`,
        {cause: error}
      );
    }
    await expectText(page, "Physical reclamation: queued", "explicit reclamation confirmation");
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    const route = `/workspaces?project=${IDS.projects[0]}&manage=resources#project-resources`;
    await visit(page, `${baseUrl}${route}`, `${route} governed page authoring`);
    await page.locator(".project-resources").waitFor();
    await expectText(page, "Standalone catalog · GeoNode 5.1 migration boundary", "GeoNode standalone boundary");
    await page.getByLabel("Record language").fill("ne");
    await page.getByRole("button", {name: "Search interoperable records"}).click();
    await page.getByText(/2 returned · 2 matched/).waitFor();
    await expectText(page, "नेपाल ऊर्जा पहुँच कथा", "language-negotiated OGC record");
    await expectText(page, "Nepal energy access story", "GeoNode-origin story discovery");
    await expectText(page, "geonode · 5.1.0:resource:42", "preserved GeoNode identity");
    await page.getByLabel("Search project resources").fill("energy access");
    await page.getByRole("button", {name: "Search resources"}).click();
    await page.getByText(/1 matching resource/).waitFor();
    if (await page.locator(".project-resource-card").count() !== 1) {
      failures.push(`${route}: governed resource search did not preserve the authorized match`);
    }
    await page.getByRole("button", {name: "Open resource"}).click();
    await page.locator(
      '.project-resource-detail[data-state="ready"], .project-resource-detail[data-state="error"]'
    ).waitFor();
    if (await page.locator('.project-resource-detail[data-state="error"]').count()) {
      throw new Error(
        `governed resource detail failed: ${await page.locator(".project-resource-detail").innerText()}`
      );
    }
    await expectText(page, "Metadata and rights", "governed resource metadata editor");
    await expectText(page, "Markdown page source", "governed Markdown page studio");
    const advancedContent = page.locator(".project-resource-advanced-content");
    if (await advancedContent.getAttribute("open") !== null) {
      failures.push(`${route}: advanced mixed-content JSON should start collapsed`);
    }
    await page.getByLabel("Markdown source").fill([
      "# Browser-safe page",
      "",
      '<img src=x onerror="globalThis.opengeoUnsafe=true">',
      "",
      "```js",
      "globalThis.opengeoUnsafe = true;",
      "```"
    ].join("\n"));
    await page.getByText(/Private recovery revision 1 saved at/).waitFor({timeout: 10_000});
    if (!browserPageDrafts.has(IDS.resource)) {
      failures.push(`${route}: debounced page recovery did not persist a private revision`);
    }
    await page.getByRole("button", {name: "Close", exact: true}).click();
    await page.getByRole("button", {name: "Open resource"}).click();
    await page.locator('.project-resource-detail[data-state="ready"]').waitFor();
    await page.getByText(/Recovered private revision 1/).waitFor();
    if (!await page.getByLabel("Markdown source").inputValue().then(
      (value) => value.includes("Browser-safe page") && value.includes("opengeoUnsafe")
    )) {
      failures.push(`${route}: reopening Page Studio did not restore the private Markdown revision`);
    }
    if (await page.locator(".markdown-source-studio").getAttribute("data-unapplied") !== "true") {
      failures.push(`${route}: unapplied Markdown source was not marked dirty`);
    }
    if (await page.locator(".markdown-source-preview img, .markdown-source-preview script").count()) {
      failures.push(`${route}: Markdown preview created executable HTML`);
    }
    await page.getByRole("button", {name: "Apply Markdown to draft"}).click();
    await page.getByText(/is in the draft\. Save new version to commit it\./).waitFor();
    if (await page.locator(".markdown-source-studio").getAttribute("data-unapplied") !== "false") {
      failures.push(`${route}: applied Markdown source remained marked dirty`);
    }
    if (!JSON.parse(await page.getByLabel(/Mixed content \(JSON/).inputValue()).blocks
      .some((block) => block.type === "markdown" && block.markdown.includes("Browser-safe page"))) {
      failures.push(`${route}: Markdown source was not applied to the governed content draft`);
    }
    await expectText(page, "Add page structure and navigation", "declarative page structure controls");
    await page.getByLabel("Heading text").fill("Detailed findings");
    await page.getByRole("button", {name: "Add structural heading"}).click();
    await page.getByLabel("Callout tone").selectOption("warning");
    await page.getByLabel("Callout title").fill("Review context");
    await page.getByLabel("Callout Markdown").fill(
      "Confirm the [source](https://evidence.example.test/source)."
    );
    await page.getByRole("button", {name: "Add safe callout"}).click();
    await page.getByLabel("Navigation heading targets").selectOption(["heading-1"]);
    await page.getByRole("button", {name: "Add in-page navigation"}).click();
    await expectText(page, "Add a governed map or dataset", "declarative governed resource insertion");
    await page.getByLabel("Map or dataset caption").fill("Browser-verified access map");
    await page.getByRole("button", {name: "Add governed reference"}).click();
    const authoredBlocks = JSON.parse(
      await page.getByLabel(/Mixed content \(JSON/).inputValue()
    ).blocks;
    const authoredMap = authoredBlocks.find((block) => block.type === "map");
    if (authoredMap?.resourceId !== IDS.mapResource || authoredMap?.resourceVersionNumber !== 1) {
      failures.push(`${route}: declarative map insertion did not retain the exact governed version pin`);
    }
    await page.getByLabel("Citation title").fill("Road access study");
    await page.getByLabel("Citation DOI").fill("10.1234/road-access");
    await page.getByRole("button", {name: "Add citation"}).click();
    await page.getByLabel("Table caption").fill("Coverage by district");
    await page.getByLabel("Table columns (comma separated)").fill("District, Coverage");
    await page.getByLabel("Table rows (one comma-separated row per line)").fill(
      "East, 0.75\nWest, 0.5"
    );
    await page.getByRole("button", {name: "Add data table"}).click();
    await page.getByLabel("Chart title").fill("Coverage chart");
    await page.getByLabel("Chart text alternative").fill(
      "East coverage is 75 percent and West coverage is 50 percent."
    );
    await page.getByRole("button", {name: "Add accessible chart"}).click();
    const structuredBlocks = JSON.parse(
      await page.getByLabel(/Mixed content \(JSON/).inputValue()
    ).blocks;
    if (!structuredBlocks.some((block) => block.type === "citation"
      && block.doi === "10.1234/road-access")) {
      failures.push(`${route}: declarative citation insertion did not retain its DOI`);
    }
    const authoredTable = structuredBlocks.find((block) => block.type === "table");
    const authoredChart = structuredBlocks.find((block) => block.type === "chart");
    const authoredHeading = structuredBlocks.find((block) => block.type === "heading");
    const authoredCallout = structuredBlocks.find((block) => block.type === "callout");
    const authoredNavigation = structuredBlocks.find((block) => block.type === "navigation");
    if (authoredTable?.rows?.[0]?.[1] !== 0.75
      || authoredChart?.tableBlockId !== authoredTable?.id
      || authoredChart?.yColumns?.[0] !== "Coverage") {
      failures.push(`${route}: declarative table/chart insertion lost its typed data binding`);
    }
    if (authoredHeading?.level !== 2 || authoredCallout?.tone !== "warning"
      || authoredNavigation?.headingBlockIds?.[0] !== authoredHeading?.id) {
      failures.push(`${route}: structural heading/callout/navigation binding was not preserved`);
    }
    await page.getByRole("button", {name: "Render pinned page preview"}).click();
    const previewFrame = page.locator('iframe[title="Pinned safe page preview"]');
    await previewFrame.waitFor({state: "visible"});
    if (await previewFrame.getAttribute("sandbox") !== "") {
      failures.push(`${route}: pinned page preview iframe weakened its empty sandbox`);
    }
    const previewDocument = page.frameLocator('iframe[title="Pinned safe page preview"]');
    await previewDocument.getByRole("heading", {name: "Nepal energy access story"}).waitFor();
    if (!await previewDocument.locator("body").innerText().then(
      (value) => value.includes("Browser-safe page")
        && value.includes("Verified access map")
        && value.includes("Road access study")
        && value.includes("Coverage by district")
        && value.includes("Coverage chart")
        && value.includes("Detailed findings")
        && value.includes("Review context")
        && value.includes("On this page")
    )) {
      failures.push(`${route}: pinned shared renderer omitted authored Markdown or map dependency`);
    }
    if (await previewDocument.locator("script, iframe, form").count()) {
      failures.push(`${route}: pinned shared renderer emitted an active document node`);
    }
    await page.getByText(/opengeo-page-renderer-1\.1\.0 · 1 governed dependencies/).waitFor();
    await page.getByLabel("Change summary").fill("Verify browser-safe page source");
    await page.getByRole("button", {name: "Save new version"}).click();
    try {
      await page.getByText("1 exact source version available.", {exact: true}).waitFor({
        timeout: 10_000
      });
    } catch {
      throw new Error(
        `durable page source commit did not finish: ${await page.locator(".project-resource-detail").innerText()}`
      );
    }
    if (browserPageDrafts.has(IDS.resource)) {
      failures.push(`${route}: successful page checkpoint did not clear its matching private draft`);
    }
    await page.getByText(/Recovery autosave is ready/).waitFor();
    const inspectSource = page.locator(".page-source-history-list button").first();
    if (!await inspectSource.count()) {
      throw new Error(
        `durable page source history has no inspect control: ${await page.locator(".project-resource-detail").innerText()}`
      );
    }
    await inspectSource.click();
    await page.getByText(/Verified v\d+ · SHA-256/).waitFor();
    if (!await page.locator(".page-source-history-output").innerText().then(
      (value) => value.includes("Browser-safe page")
    )) {
      failures.push(`${route}: exact page source could not be inspected after commit`);
    }
    await expectText(page, "Add a governed project asset", "governed site asset picker");
    for (const target of [
      "dcat_3", "stac_1_1", "ogc_records_1_0", "iso_19115_3",
      "schema_org_dataset", "datacite_4_7", "datacite_4_7_xml", "geodcat_ap_3_1"
    ]) {
      if (await page.getByLabel("Metadata format", {exact: true}).locator(`option[value="${target}"]`).count() !== 1) {
        failures.push(`${route}: ${target} metadata format is unavailable`);
      }
    }
    if (await page.getByRole("button", {name: "Prepare metadata export", exact: true}).count() !== 1) {
      failures.push(`${route}: metadata export action is unavailable`);
    }
    await expectText(page, "Editorial workflow", "governed editorial controls");
    await expectText(page, "Portable styles", "portable style attachment boundary");
    await expectText(page, "Deterministic map renders", "activation-only map rendering boundary");
    await expectText(page, "stories and documents may embed", "map-optional publishing boundary");
    await expectText(page, "View · edit · publish · manage", "resource access roles");
    const dataRoute = `/workspaces?project=${IDS.projects[0]}&manage=data#project-data`;
    await visit(page, `${baseUrl}${dataRoute}`, `${dataRoute} governed dataset operations`);
    await page.locator(".project-datasets").waitFor();
    const accessRoadCard = page.locator(".project-dataset-card", {hasText: "Access Road Network"});
    await accessRoadCard.getByRole("button", {name: "Version history"}).click();
    await accessRoadCard.locator(".project-version-history").waitFor();
    await expectText(page, "Logical version history", "authorized logical version history");
    await accessRoadCard.getByRole("button", {name: "Download"}).click();
    await accessRoadCard.getByText("Short-lived exact-version download authorized.").waitFor();
    await expectText(page, "Short-lived exact-version download authorized", "exact-version download boundary");
    await accessRoadCard.getByRole("button", {name: "Dataset access"}).click();
    await accessRoadCard.locator(".project-permission-editor").waitFor();
    await expectText(page, "Explicit dataset grants", "dataset permission editor");
    await expectText(page, "Browser Member", "dataset permission records");
    await page.getByLabel("Dataset, image, or document file").setInputFiles({
      name: "browser-roads.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from('{"type":"FeatureCollection","features":[]}')
    });
    await page.getByLabel("Dataset, image, or document name").fill("Browser uploaded roads");
    await page.getByRole("button", {name: "Hash and upload"}).click();
    await page.locator(".project-dataset-card", {hasText: "Browser uploaded roads"}).waitFor();
    await expectText(page, "queued", "verified upload processing state");
    await page.getByLabel("Search datasets").fill("Invalid raster");
    await page.getByRole("button", {name: "Apply filters"}).click();
    await page.getByText(/1 matching dataset/).waitFor();
    await expectText(page, "1 matching dataset", "server-side catalog search count");
    const filteredCards = await page.locator(".project-dataset-card").count();
    if (filteredCards !== 1) failures.push(`${dataRoute}: catalog search did not replace results with the authorized match`);

    const mapRoute = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    await visit(page, `${baseUrl}${mapRoute}`, `${mapRoute} governed map and exchange operations`);
    await page.locator(".opengeo-workbench").waitFor();
    browserSourceRequests.length = 0;
    await page.locator('.gis-menu-wrap[data-menu="add"] > .gis-menu-button').click();
    await page.locator('.gis-menu-wrap[data-menu="add"] .gis-menu-item', {hasText: "XYZ tile layer"}).click();
    await page.getByLabel("Layer title").fill("Governed browser tiles");
    await page.getByLabel("Tile URL").fill("https://tiles.example.test/{z}/{x}/{y}.png");
    await page.getByRole("button", {name: "Register XYZ source"}).click();
    await page.locator(".gis-layer-row", {hasText: "Governed browser tiles"}).waitFor();
    await expectText(page, "registered as governed source revision 1", "governed source registration");
    await page.waitForTimeout(250);
    if (!browserSourceRequests.length) failures.push(`${route}: governed XYZ layer issued no browser tile request`);

    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const savedSource = lastMapUpdate?.definition?.layers?.find(
      (layer) => layer.datasetId === IDS.sourceDataset
    );
    if (
      savedSource?.sourceVersion !== 1
      || savedSource?.sourceUrl !== "https://tiles.example.test/{z}/{x}/{y}.png"
      || savedSource?.sourceConfiguration?.scheme !== "xyz"
      || JSON.stringify(savedSource).toLowerCase().includes("authorization")
    ) {
      failures.push(`${route}: governed source map snapshot was missing, stale, or credential-widened`);
    }

    const mapVersionBeforeGeoLibreInspection = importedMapVersion;
    await page.getByRole("button", {name: "Project", exact: true}).click();
    const choosingGeoLibre = page.waitForEvent("filechooser");
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Open Project file…"}).click();
    await (await choosingGeoLibre).setFiles({
      name: "geolibre-2.6-project.geolibre.json",
      mimeType: "application/json",
      buffer: geolibreProjectBytes
    });
    const geolibreReview = page.getByRole("dialog", {name: "Review Project file", exact: true});
    await geolibreReview.getByText("GeoLibre Project", {exact: false}).waitFor();
    await geolibreReview.getByRole("button", {name: "Download conversion report", exact: true}).waitFor();
    if (importedMapVersion !== mapVersionBeforeGeoLibreInspection) failures.push(`${route}: GeoLibre inspection changed the saved map before confirmation`);
    await geolibreReview.getByRole("button", {name: "Open in this Project", exact: true}).click();
    let selectedMapLabel = "unavailable";
    try {
      await page.locator(".gis-layer-row", {hasText: "Public PMTiles"}).waitFor({timeout: 10_000});
      const selectedMap = mapPayloadsForProject(IDS.projects[0]).find(
        ({id}) => id === IDS.maps[0]
      );
      selectedMapLabel = selectedMap ? `${selectedMap.name} · v${selectedMap.version}` : "unavailable";
      if (!importedMapVersion || !selectedMapLabel.includes(`v${importedMapVersion}`)) {
        throw new Error(`selected map was ${selectedMapLabel}`);
      }
    } catch {
      failures.push(`${mapRoute}: governed GeoLibre browser import did not refresh to finalized map v${importedMapVersion ?? "?"}; selected map was ${JSON.stringify(selectedMapLabel)}; status was ${JSON.stringify(await page.locator(".gis-statusbar").innerText())}`);
    }
    if (!importedMapDefinition?.layers?.length || JSON.stringify(importedMapDefinition).includes('"import:')) {
      failures.push(`${route}: governed GeoLibre import did not atomically replace placeholder identities`);
    }
    const importedDatasetIds = importedMapDefinition?.layers?.map((layer) => layer.datasetId) ?? [];
    if (!importedDatasetIds.includes(IDS.importEmbeddedDataset) || !IDS.importSourceDatasets.every((id) => importedDatasetIds.includes(id))) {
      failures.push(`${route}: governed GeoLibre import did not persist all real dataset identities`);
    }

    const mapUpdateBeforeGeoMooseInspection = JSON.stringify(lastMapUpdate);
    await page.getByRole("button", {name: "Project", exact: true}).click();
    const choosingGeoMoose = page.waitForEvent("filechooser");
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Open Project file…"}).click();
    await (await choosingGeoMoose).setFiles({
      name: "geomoose-3.15.2-mapbook.xml",
      mimeType: "application/xml",
      buffer: geomooseMapbookBytes
    });
    const geomooseReview = page.getByRole("dialog", {name: "Review Project file", exact: true});
    await geomooseReview.getByText("GeoMoose mapbook", {exact: false}).first().waitFor();
    if (!(await geomooseReview.innerText()).includes("18 sources")) {
      failures.push(`${route}: offline GeoMoose inspection did not report the pinned mapbook source count`);
    }
    if (JSON.stringify(lastMapUpdate) !== mapUpdateBeforeGeoMooseInspection) {
      failures.push(`${route}: GeoMoose inspection changed the saved map before confirmation`);
    }
    await geomooseReview.getByRole("button", {name: "Download conversion report", exact: true}).waitFor();
    await geomooseReview.getByRole("button", {name: "Open in this Project", exact: true}).click();
    const portal = page.locator('.gis-portal-configuration[data-sources="18"][data-catalog-nodes="22"]'
      + '[data-tools="17"][data-searches="4"][data-services="8"]'
      + '[data-catalog-layers="18"][data-direct-catalog-layers="2"]'
      + '[data-unresolved-catalog-layers="1"]');
    await portal.waitFor();
    if (await portal.getAttribute("data-governed-catalog-layers") !== "0") {
      failures.push(`${route}: GeoMoose catalog started with an unexpected governed binding`);
    }
    await portal.getByText("County Layers", {exact: true}).waitFor();
    const openStreetMap = portal.locator('.gis-portal-catalog-layer', {hasText: "OpenStreetMap"});
    const blankBackground = portal.locator('.gis-portal-catalog-layer', {hasText: "No background"});
    if (!await blankBackground.getByRole("button", {name: "Source unresolved", exact: true}).isDisabled()) {
      failures.push(`${route}: unresolved GeoMoose catalog source was presented as executable`);
    }
    browserPortalSourceRequests.length = 0;
    await openStreetMap.getByRole("button", {name: "Register governed source", exact: true}).click();
    try {
      await page.locator('.gis-portal-configuration[data-governed-catalog-layers="1"]'
        + '[data-displayed-catalog-layers="1"]').waitFor({timeout: 5_000});
    } catch {
      throw new Error(
        `${route}: GeoMoose source binding did not render (${await page.locator(".gis-statusbar").innerText()})`
      );
    }
    await page.locator('.gis-layer-row', {hasText: "OpenStreetMap"}).waitFor();
    for (let attempt = 0; attempt < 10 && !browserPortalSourceRequests.length; attempt += 1) {
      await page.waitForTimeout(100);
    }
    if (!browserPortalSourceRequests.length) {
      const observed = await page.locator(".opengeo-workbench").evaluate((shell) => {
        const layer = shell.__opengeoLayers?.find(({title}) => title === "OpenStreetMap");
        const source = layer ? shell.__opengeoMap?.getSource(`${layer.layerId}-source`) : null;
        return {
          layer,
          source: source?.serialize?.() ?? null,
          styleLoaded: shell.__opengeoMap?.isStyleLoaded?.() ?? false,
          zoom: shell.__opengeoMap?.getZoom?.() ?? null
        };
      });
      failures.push(`${route}: governed GeoMoose XYZ layer issued no browser tile request (${JSON.stringify(observed)})`);
    }
    const visibility = openStreetMap.getByRole("checkbox", {name: "Show OpenStreetMap", exact: true});
    await visibility.uncheck();
    await page.locator('.gis-portal-configuration[data-displayed-catalog-layers="0"]').waitFor();
    await visibility.check();
    await page.locator('.gis-portal-configuration[data-displayed-catalog-layers="1"]').waitFor();
    await openStreetMap.getByRole("slider", {name: "OpenStreetMap opacity", exact: true}).fill("0.55");
    await openStreetMap.getByText("Legend", {exact: true}).click();
    await openStreetMap.getByText("Legend hidden by the mapbook configuration.", {exact: true}).waitFor();
    await portal.getByRole("button", {name: "Save current view", exact: true}).click();
    await page.locator('.gis-portal-configuration[data-locations="1"]').waitFor();
    await page.getByRole("button", {name: "Light", exact: true}).click();
    await page.locator('.opengeo-workbench[data-color-mode="light"]').waitFor();
    await page.locator(".gis-portal-configuration", {hasText: "OpenGeo light"}).waitFor();
    await page.setViewportSize({width: 390, height: 844});
    await assertWorkbenchLayoutConflicts(page, route, 390, "light");
    await page.setViewportSize({width: 1440, height: 950});
    await portal.getByRole("button", {name: "Measure", exact: true}).click();
    await page.locator(".gis-statusbar", {hasText: "Measurement tools opened"}).waitFor();
    await expectText(page, "Measurements & Elevation", `${route}: configured measurement inspector`);
    const inactiveStreetView = portal.getByRole("button", {name: "3D View", exact: true});
    if (!await inactiveStreetView.isDisabled()) {
      failures.push(`${route}: unbound GeoMoose service tool was presented as executable`);
    }

    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    if (lastMapUpdate?.definition?.portal?.schemaVersion !== "opengeo.portal-configuration.1.0.0"
      || lastMapUpdate?.definition?.portal?.sources?.length !== 18
      || lastMapUpdate?.definition?.portal?.searches?.length !== 4
      || lastMapUpdate?.definition?.portal?.locations?.length !== 1
      || lastMapUpdate?.definition?.portal?.theme?.colorMode !== "light"
      || lastMapUpdate?.definition?.portal?.revision !== 3
      || lastMapUpdate?.definition?.extensions?.geomoose?.conversionReport?.summary?.rejected !== 4
      || JSON.stringify(lastMapUpdate?.definition).includes("Your Key Here")) {
      failures.push(`${route}: authoritative save did not retain the bounded credential-scrubbed portal configuration`);
    }
    const catalogLayer = lastMapUpdate?.definition?.layers?.find(
      (layer) => layer.portalCatalogSource === "openstreetmap/osm_mapnik"
    );
    if (catalogLayer?.datasetId !== IDS.sourceDataset
      || catalogLayer?.sourceVersion !== 1
      || catalogLayer?.sourceType !== "xyz-raster"
      || catalogLayer?.sourceUrl !== "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"
      || catalogLayer?.sourceConfiguration?.scheme !== "xyz"
      || catalogLayer?.opacity !== 0.55
      || JSON.stringify(catalogLayer).toLowerCase().includes("authorization")) {
      failures.push(`${route}: governed GeoMoose catalog binding was missing its exact source revision or safe presentation state`);
    }

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", {name: "Project", exact: true}).click();
    await page.locator('.gis-menu-wrap[data-menu="project"] .gis-menu-item', {hasText: "Save as / export…"}).click();
    const exportDialog = page.getByRole("dialog", {name: "Save as or export Project", exact: true});
    await exportDialog.getByRole("combobox", {name: "Project export format"}).selectOption("geomoose");
    await exportDialog.getByRole("button", {name: "Export file", exact: true}).click();
    const download = await downloadPromise;
    if (!download.suggestedFilename().endsWith(".mapbook.xml")) {
      failures.push(`${route}: GeoMoose export did not use the mapbook filename`);
    }
    await exportDialog.getByRole("button", {name: "Close", exact: true}).click();

    await page.reload({waitUntil: "load"});
    await page.locator(".opengeo-workbench").waitFor();
    await page.locator(".gis-portal-configuration-disclosure > summary").click();
    await page.locator('.gis-portal-configuration[data-sources="18"][data-catalog-nodes="22"]'
      + '[data-tools="17"][data-searches="4"][data-services="8"][data-locations="1"]'
      + '[data-catalog-layers="18"][data-governed-catalog-layers="1"]'
      + '[data-displayed-catalog-layers="1"]').waitFor();
    await page.locator('.opengeo-workbench[data-color-mode="light"]').waitFor();
    browserProgress("GEOMOOSE-001: standalone mapbook import, save, export, and reload passed");
  });

  await withPlatformPage(browser, baseUrl, {token: "invited.test.token"}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "/workspaces invited principal");
    await page.locator('[data-state="invitation_required"]').waitFor();
    await expectText(page, "Accept your invitation", "pre-membership invitation state");
    await page.getByRole("button", {name: "Accept invitation"}).click();
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    await expectText(page, "Nepal Energy Access", "accepted invitation project access");
  });

  await withPlatformPage(browser, baseUrl, {token: "multi.org.token"}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "/workspaces organization selection");
    await page.locator('[data-state="organization_required"]').waitFor();
    await expectText(page, "Choose an organization", "multi-organization state");
  });

  await withPlatformPage(browser, baseUrl, {token: "error.test.token"}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "/workspaces API error");
    await page.locator('[data-state="error"]').waitFor();
    await expectText(page, "Request ID: browser-check-request", "attributed API error");
    if (!await page.getByRole("button", {name: "Retry"}).count()) failures.push("API error: retry action is missing");
  });

  await withPlatformPage(browser, baseUrl, {token: "conflict.test.token"}, async (page) => {
    const route = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    await visit(page, `${baseUrl}${route}`, `${route} conflict`);
    await page.locator(".opengeo-workbench").waitFor();
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="conflict"]').waitFor();
    await expectText(page, "Server version is 7", "optimistic-lock conflict");
  });

  await withPlatformPage(browser, baseUrl, {token: null}, async (page) => {
    await visit(page, `${baseUrl}${fixtureProjectRoute}`, "explicit fixture mode");
    await page.locator('.platform-mode[data-adapter="fixture"]').waitFor();
    await expectText(page, "changes are memory-only", "fixture adapter banner");
  });

  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    await visit(page, `${baseUrl}/admin`, "/admin live API");
    await page.locator(".platform-team-admin .platform-admin-table").first().waitFor();
    await expectText(page, "Live API adapter · PostgreSQL-backed records", "live team adapter banner");
    await expectText(page, "Pending Browser Invitee", "live pending invitation");
    await expectText(page, "accepted", "live accepted invitation state");
    await expectText(page, "expired", "live expired invitation state");
    await expectText(page, "revoked", "live revoked invitation state");
  });

  await withPlatformPage(browser, baseUrl, {token: null}, async (page) => {
    await visit(page, `${baseUrl}/admin?adapter=fixture`, "/admin explicit fixture");
    await page.locator(".platform-team-admin .platform-admin-table").first().waitFor();
    await expectText(page, "changes are memory-only", "fixture team adapter banner");
    await expectText(page, "Pending Invitee", "fixture pending invitation");
    const organizationPanel = page.locator(".platform-admin-panel", {hasText: "Organization members"});
    await organizationPanel.getByRole("button", {name: "Revoke"}).first().click();
    await page.locator('.platform-mutation-feedback[data-state="error"]').waitFor();
    await expectText(page, "last_organization_admin", "fixture last-admin error state");
  });
}

async function assertUx002Workflows(browser, baseUrl) {
  browserProgress("UX-002: start");
  await withPlatformPage(browser, baseUrl, {
    token: "browser.test.token",
    clockNow: OPEN_3D_SCENE_SOURCE.observedAt
  }, async (page) => {
    await visit(page, `${baseUrl}/`, "/ authenticated activity start");
    await page.locator(".start-project-row").first().waitFor();
    await expectText(page, "Nepal Energy Access", "activity-backed recent projects");
    if ((await page.locator(".start-project-row").first().locator(".start-classification").textContent())?.trim() !== "admin") {
      failures.push("authenticated start: organization-admin access was mislabeled as fixture data");
    }
    if (!await page.locator(".start-project-row").first().locator("time").innerText().then((value) => value.includes("Aug 20, 2026"))) {
      failures.push("authenticated start: recent projects did not use the actor's latest activity timestamp");
    }
    if ((await page.locator("body").innerText()).toLowerCase().includes("fixture")) {
      failures.push("authenticated start: fixture project history leaked into live recents");
    }

    await visit(page, `${baseUrl}/workspaces?new=1`, "/workspaces durable creation");
    const projectName = page.getByLabel("New project name");
    await projectName.waitFor();
    if (!await projectName.evaluate((input) => input === document.activeElement)) {
      failures.push("durable creation: initial keyboard focus did not enter the project-name field");
    }
    await projectName.fill("Field atlas");
    await page.getByLabel("New project description").fill("Representative governed GIS task");
    await page.getByRole("button", {name: "Create project and map"}).click();
    await page.waitForURL(new RegExp(`/workspaces\\?project=${IDS.createdProject}&map=${IDS.createdMap}`));
    await page.waitForTimeout(1_000);
    if (!await page.locator(".opengeo-workbench").count()) {
      throw new Error(`durable creation did not open a workbench: ${await page.locator("body").innerText()}`);
    }
    await expectText(page, "Field atlas", "durable project creation");

    await page.locator(".gis-map .maplibregl-canvas").waitFor();
    await assertPlanetaryProjectWorkflow(page, "/workspaces durable creation", {
      projectId: IDS.createdProject,
      mapId: IDS.createdMap
    });
    await assertGovernedRegionalBasemapWorkflow(page, "/workspaces durable creation", {
      projectId: IDS.createdProject,
      mapId: IDS.createdMap
    });
    browserTerrainRequests.length = 0;
    browserOpenScene3dRequests.length = 0;
    await page.getByRole("button", {name: "Enable 3D terrain", exact: true}).click();
    await page.locator('.opengeo-workbench[data-projection="mercator"][data-terrain="disabled"]').waitFor();
    await expectText(page, "Enable the globe projection before enabling 3D terrain", "terrain projection prerequisite");
    if (browserTerrainRequests.length) failures.push("open terrain: Mercator prerequisite denial still issued a tile request");
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    await expectText(page, "Enable the globe projection before enabling the open 3D scene", "3D scene projection prerequisite");
    if (browserOpenScene3dRequests.length) failures.push("open 3D scene: Mercator prerequisite denial still issued a tile request");
    await page.getByRole("button", {name: "Globe projection", exact: true}).click();
    await page.locator('.opengeo-workbench[data-projection="globe"]').waitFor();
    await page.locator('.gis-map[data-projection="globe"][aria-label*="Interactive globe"]').waitFor();
    await expectText(page, "3D terrain off", "truthful globe capability disclosure");
    browserTerrainRequests.length = 0;
    await page.getByRole("button", {name: "Enable 3D terrain", exact: true}).click();
    await page.locator('.opengeo-workbench[data-terrain="enabled"]').waitFor();
    await page.locator('.gis-map[data-terrain="enabled"][aria-label*="Mapterhorn open terrain"]').waitFor();
    await expectText(page, "open terrain on", "effective open terrain disclosure");
    await page.locator(".gis-projection-disclosure").getByRole("link", {name: "© Mapterhorn", exact: true}).waitFor();
    await page.waitForTimeout(500);
    if (!browserTerrainRequests.length) failures.push("open terrain: the effective terrain source issued no tile request");
    await page.getByRole("button", {name: "Measure", exact: true}).click();
    await expectText(page, "Measurements & Elevation", "saved measurement inspector");
    await page.locator(".gis-panel-right").getByRole("button", {name: "Path + elevation", exact: true}).click();
    await page.locator(".opengeo-workbench").evaluate((shell) => {
      const map = shell.__opengeoMap;
      const center = map.getCenter();
      for (const [longitude, latitude] of [
        [center.lng - 0.006, center.lat - 0.002],
        [center.lng, center.lat + 0.004],
        [center.lng + 0.007, center.lat - 0.001]
      ]) {
        map.fire({
          type: "click",
          lngLat: {lng: longitude, lat: latitude},
          point: map.project([longitude, latitude])
        });
      }
    });
    await page.getByRole("button", {name: "Save measurement", exact: true}).click();
    const savedMeasurement = page.locator('.gis-measurement-card[data-measurement-id^="measurement-"]');
    await savedMeasurement.waitFor();
    await expectText(page, "3 vertices", "saved measurement path vertices");
    await expectText(page, "No terrain samples saved", "saved measurement no-data disclosure");
    await expectText(page, "Unavailable", "saved measurement terrain status");
    await savedMeasurement.getByRole("button", {name: "Edit", exact: true}).click();
    await expectText(page, "Edit path + elevation", "saved measurement edit mode");
    await page.locator(".opengeo-workbench").evaluate((shell) => {
      const map = shell.__opengeoMap;
      const center = map.getCenter();
      const longitude = center.lng + 0.012;
      const latitude = center.lat + 0.003;
      map.fire({
        type: "click",
        lngLat: {lng: longitude, lat: latitude},
        point: map.project([longitude, latitude])
      });
    });
    await page.getByRole("button", {name: "Update measurement", exact: true}).click();
    await expectText(page, "4 vertices", "edited measurement path vertices");
    await page.locator(".gis-panel-right").getByRole("button", {name: "Polygon area", exact: true}).click();
    await page.locator(".opengeo-workbench").evaluate((shell) => {
      const map = shell.__opengeoMap;
      const center = map.getCenter();
      for (const [longitude, latitude] of [
        [center.lng - 0.01, center.lat - 0.008],
        [center.lng + 0.01, center.lat - 0.008],
        [center.lng + 0.008, center.lat + 0.008],
        [center.lng - 0.008, center.lat + 0.008]
      ]) {
        map.fire({
          type: "click",
          lngLat: {lng: longitude, lat: latitude},
          point: map.project([longitude, latitude])
        });
      }
    });
    await page.getByRole("button", {name: "Save measurement", exact: true}).click();
    await expectText(page, "Polygon", "saved polygon measurement geometry");
    await page.locator(".gis-panel-right").getByRole("button", {name: "Circle area", exact: true}).click();
    await page.locator(".opengeo-workbench").evaluate((shell) => {
      const map = shell.__opengeoMap;
      const center = map.getCenter();
      for (const [longitude, latitude] of [
        [center.lng, center.lat],
        [center.lng + 0.01, center.lat]
      ]) {
        map.fire({
          type: "click",
          lngLat: {lng: longitude, lat: latitude},
          point: map.project([longitude, latitude])
        });
      }
    });
    await page.getByRole("button", {name: "Save measurement", exact: true}).click();
    await expectText(page, "Circle", "saved circle measurement geometry");
    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const savedMeasurementDefinitions = lastMapUpdate?.definition?.measurements ?? [];
    const savedMeasurementDefinition = savedMeasurementDefinitions[0];
    const polygonMeasurementDefinition = savedMeasurementDefinitions.find(({kind}) => kind === "polygon-area");
    const circleMeasurementDefinition = savedMeasurementDefinitions.find(({kind}) => kind === "circle-area");
    if (lastMapUpdate?.definition?.schemaVersion !== "opengeo.map-definition.1.3.0"
      || savedMeasurementDefinition?.kind !== "path-profile"
      || savedMeasurementDefinition?.coordinates?.length !== 4
      || savedMeasurementDefinition?.terrainProfile?.status !== "unavailable"
      || savedMeasurementDefinition?.terrainProfile?.source !== null
      || savedMeasurementDefinition?.terrainProfile?.summary?.threeDimensionalDistanceMeters !== null
      || !(savedMeasurementDefinition?.horizontalDistanceMeters > 0)
      || polygonMeasurementDefinition?.coordinates?.length !== 4
      || !(polygonMeasurementDefinition?.perimeterMeters > 0)
      || !(polygonMeasurementDefinition?.areaSquareMeters > 0)
      || !(circleMeasurementDefinition?.radiusMeters > 0)
      || !(circleMeasurementDefinition?.circumferenceMeters > 0)
      || !(circleMeasurementDefinition?.areaSquareMeters > 0)) {
      failures.push(`saved measurements: project persistence or recomputed geometry was incomplete (${JSON.stringify(savedMeasurementDefinitions)})`);
    } else {
      acceptedPathMeasurement = {
        schemaVersion: lastMapUpdate.definition.schemaVersion,
        vertices: savedMeasurementDefinition.coordinates.length,
        samples: savedMeasurementDefinition.terrainProfile.samples.length,
        status: savedMeasurementDefinition.terrainProfile.status,
        sourceId: null,
        queryMode: null,
        horizontalDistanceMeters: savedMeasurementDefinition.horizontalDistanceMeters,
        threeDimensionalDistanceMeters: null,
        noDataSentinelRejected: true,
        editedAfterSave: true,
        polygonVertices: polygonMeasurementDefinition.coordinates.length,
        polygonAreaSquareMeters: polygonMeasurementDefinition.areaSquareMeters,
        circleRadiusMeters: circleMeasurementDefinition.radiusMeters,
        circleAreaSquareMeters: circleMeasurementDefinition.areaSquareMeters,
        persisted: true
      };
    }
    const mapCanvas = page.locator(".gis-map .maplibregl-canvas");
    const keyboardStartLongitude = Number(await page.locator(".opengeo-workbench").getAttribute("data-camera-longitude"));
    await mapCanvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((start) => {
      const value = Number(document.querySelector(".opengeo-workbench")?.dataset.cameraLongitude);
      return Number.isFinite(value) && Number.isFinite(start) && Math.abs(value - start) > 0.000001;
    }, keyboardStartLongitude);
    await page.getByRole("button", {name: "Zoom in", exact: true}).click();

    try {
      if (performanceGateEnabled) {
        await page.locator('.opengeo-workbench[data-performance-accepted="true"][data-terrain-ready-ms]').waitFor({timeout: 10_000});
      } else {
        await page.waitForFunction((minimumFrameSamples) => {
          const shell = document.querySelector(".opengeo-workbench");
          return Number(shell?.dataset.frameSamples) >= minimumFrameSamples
            && Number.isFinite(Number(shell?.dataset.frameP95Ms))
            && Number.isFinite(Number(shell?.dataset.mapLoadMs))
            && Number.isFinite(Number(shell?.dataset.terrainReadyMs));
        }, GLOBE_TELEMETRY_LIMITS.minimumAcceptanceFrameSamples, {timeout: 10_000});
      }
    } catch {
      const telemetry = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        frameSamples: shell.dataset.frameSamples,
        frameP50Ms: shell.dataset.frameP50Ms,
        frameP95Ms: shell.dataset.frameP95Ms,
        mapLoadMs: shell.dataset.mapLoadMs,
        terrainReadyMs: shell.dataset.terrainReadyMs,
        heapMib: shell.dataset.heapMib,
        performanceAccepted: shell.dataset.performanceAccepted,
        cameraLongitude: shell.dataset.cameraLongitude,
        cameraZoom: shell.dataset.cameraZoom
      }));
      const expectation = performanceGateEnabled ? "did not pass" : "did not become observable";
      throw new Error(`bounded local globe telemetry ${expectation}: ${JSON.stringify(telemetry)}`);
    }
    await expectText(page, "Local automation telemetry · p95", "bounded local globe performance telemetry");
    acceptedGlobeTelemetry = {
      ...await page.locator(".opengeo-workbench").evaluate((shell) => ({
      frameSamples: Number(shell.dataset.frameSamples),
      frameP50Ms: Number(shell.dataset.frameP50Ms),
      frameP95Ms: Number(shell.dataset.frameP95Ms),
      mapLoadMs: Number(shell.dataset.mapLoadMs),
      terrainReadyMs: Number(shell.dataset.terrainReadyMs),
      heapMib: shell.dataset.heapMib === undefined ? null : Number(shell.dataset.heapMib)
      })),
      maximumFrameP95Ms: GLOBE_TELEMETRY_LIMITS.maximumAcceptedFrameP95Ms,
      maximumMapLoadMs: GLOBE_TELEMETRY_LIMITS.maximumAcceptedMapLoadMs,
      maximumTerrainReadyMs: GLOBE_TELEMETRY_LIMITS.maximumAcceptedTerrainReadyMs,
      maximumHeapMib: GLOBE_TELEMETRY_LIMITS.maximumAcceptedHeapMiB,
      thresholdEnforced: performanceGateEnabled
    };
    if (performanceGateEnabled
      && (acceptedGlobeTelemetry.frameSamples < GLOBE_TELEMETRY_LIMITS.minimumAcceptanceFrameSamples
      || acceptedGlobeTelemetry.frameP95Ms > acceptedGlobeTelemetry.maximumFrameP95Ms
      || acceptedGlobeTelemetry.mapLoadMs > acceptedGlobeTelemetry.maximumMapLoadMs
      || acceptedGlobeTelemetry.terrainReadyMs > acceptedGlobeTelemetry.maximumTerrainReadyMs
      || (acceptedGlobeTelemetry.heapMib !== null
        && acceptedGlobeTelemetry.heapMib > acceptedGlobeTelemetry.maximumHeapMib))) {
      failures.push(`bounded local globe telemetry exceeded a captured limit: ${JSON.stringify(acceptedGlobeTelemetry)}`);
    }

    await page.locator('.opengeo-workbench[data-globe-interactions="enabled"]'
      + '[data-interaction-drag-pan="enabled"]'
      + '[data-interaction-drag-rotate="enabled"]'
      + '[data-interaction-scroll-zoom="enabled"]'
      + '[data-interaction-keyboard="enabled"]'
      + '[data-interaction-touch-zoom-rotate="enabled"]'
      + '[data-interaction-touch-pitch="enabled"]').waitFor();
    const canvasBox = await mapCanvas.boundingBox();
    if (!canvasBox) throw new Error("globe navigation: map canvas had no browser bounds");
    const canvasCenter = {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + canvasBox.height / 2
    };

    const beforePointerPan = await readGlobeCamera(page);
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.down({button: "left"});
    await page.mouse.move(canvasCenter.x + 110, canvasCenter.y + 45, {steps: 8});
    await page.mouse.up({button: "left"});
    await waitForGlobeCameraChange(page, beforePointerPan, ["longitude", "latitude"]);
    await settleGlobeCamera(page);
    const afterPointerPan = await readGlobeCamera(page);

    const beforePointerOrbit = afterPointerPan;
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.down({button: "right"});
    await page.mouse.move(canvasCenter.x + 95, canvasCenter.y + 70, {steps: 8});
    await page.mouse.up({button: "right"});
    await waitForGlobeCameraChange(page, beforePointerOrbit, ["pitch", "bearing"]);
    await settleGlobeCamera(page);
    const afterPointerOrbit = await readGlobeCamera(page);

    const beforeWheel = afterPointerOrbit;
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.wheel(0, -480);
    await waitForGlobeCameraChange(page, beforeWheel, ["zoom"]);
    await settleGlobeCamera(page);
    const afterWheel = await readGlobeCamera(page);

    const beforeTouch = afterWheel;
    await performTwoFingerGlobeGestures(page, canvasCenter);
    await waitForGlobeCameraChange(page, beforeTouch, ["zoom", "pitch", "bearing"]);
    await settleGlobeCamera(page);
    const afterTouch = await readGlobeCamera(page);
    acceptedGlobeNavigation = {
      handlers: ["dragPan", "dragRotate", "scrollZoom", "keyboard", "touchZoomRotate", "touchPitch"],
      keyboardLongitudeChanged: true,
      pointerPanCenterDelta: roundCameraDelta(beforePointerPan, afterPointerPan, ["longitude", "latitude"]),
      pointerOrbitDelta: roundCameraDelta(beforePointerOrbit, afterPointerOrbit, ["pitch", "bearing"]),
      wheelZoomDelta: roundCameraDelta(beforeWheel, afterWheel, ["zoom"]),
      touchCameraDelta: roundCameraDelta(beforeTouch, afterTouch, ["zoom", "pitch", "bearing"]),
      savedViewRestored: false
    };

    browserOpenScene3dRequests.length = 0;
    await page.getByRole("button", {name: "Enable open 3D scene", exact: true}).click();
    try {
      await page.locator('.opengeo-workbench[data-open-scene3d="enabled"][data-open-scene3d-governance="fresh-upstream"]').waitFor();
    } catch (error) {
      const scene = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        projection: shell.dataset.projection,
        enabled: shell.dataset.openScene3d,
        governance: shell.dataset.openScene3dGovernance,
        fallback: shell.dataset.openScene3dFallback,
        status: shell.querySelector(".gis-status-message")?.textContent ?? null
      }));
      throw new Error(
        `open 3D scene did not activate after explicit consent: ${JSON.stringify({scene, requests: browserOpenScene3dRequests.map(({url}) => url)})}`,
        {cause: error}
      );
    }
    await page.locator('.gis-map[data-open-scene3d="enabled"][aria-label*="open buildings and woodland canopy"][aria-label*="individual trees are not modeled"]').waitFor();
    try {
      await page.locator('.opengeo-workbench[data-open-scene3d-buildings]:not([data-open-scene3d-buildings="0"])[data-open-scene3d-woodland]:not([data-open-scene3d-woodland="0"])').waitFor({timeout: 10_000});
    } catch {
      const scene = await page.locator(".opengeo-workbench").evaluate((shell) => ({
        enabled: shell.dataset.openScene3d,
        governance: shell.dataset.openScene3dGovernance,
        buildings: shell.dataset.openScene3dBuildings,
        woodland: shell.dataset.openScene3dWoodland,
        layers: shell.__opengeoMap?.getStyle?.().layers
          ?.filter(({id}) => id.startsWith("opengeo-open-"))
          .map(({id}) => id),
        sourceBuildings: shell.__opengeoMap?.querySourceFeatures?.("opengeo-openfreemap-3d", {sourceLayer: "building"})?.length,
        sourceLandcover: shell.__opengeoMap?.querySourceFeatures?.("opengeo-openfreemap-3d", {sourceLayer: "landcover"})?.length
      }));
      throw new Error(`open 3D scene did not expose decoded building and woodland features: ${JSON.stringify({scene, requests: browserOpenScene3dRequests.map(({url}) => url)})}`);
    }
    await expectText(page, "open buildings + woodland canopy", "open 3D scene disclosure");
    await expectText(page, "individual trees unavailable", "honest individual-tree limitation");
    for (const label of ["OpenFreeMap", "© OpenMapTiles", "© OpenStreetMap contributors"]) {
      await page.locator(".gis-projection-disclosure").getByRole("link", {name: label, exact: true}).waitFor();
    }
    if (!browserOpenScene3dRequests.length) failures.push("open 3D scene: the effective vector source issued no tile request");
    acceptedOpenScene3d = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      receiptStatus: shell.dataset.openScene3dGovernance,
      buildingFeatures: Number(shell.dataset.openScene3dBuildings),
      woodlandFeatures: Number(shell.dataset.openScene3dWoodland),
      zoom: shell.__opengeoMap.getZoom(),
      pitch: shell.__opengeoMap.getPitch(),
      buildingLayer: Boolean(shell.__opengeoMap.getLayer("opengeo-open-buildings-3d")),
      woodlandLayer: Boolean(shell.__opengeoMap.getLayer("opengeo-open-woodland-canopy-3d")),
      individualTrees: false
    }));
    acceptedOpenScene3d.tileRequests = browserOpenScene3dRequests.length;
    acceptedOpenScene3d.authorityHeadersAbsent = true;

    browserProgress("UX-002: importing KML/KMZ as a styled layer");
    await page.getByRole("button", {name: "Add data", exact: true}).click();
    const localFileInput = page.locator('.gis-file-drop input[type="file"]');
    await localFileInput.setInputFiles({
      name: "browser-places.kmz",
      mimeType: "application/vnd.google-earth.kmz",
      buffer: kmlPlacesBrowserBytes
    });
    await page.locator('.opengeo-workbench[data-kml-import="pass_with_declared_losses"]'
      + '[data-kml-folders="1"][data-kml-placemarks="3"][data-kml-overlays="3"][data-kml-network-links="1"]'
      + '[data-kml-linked-features="0"][data-kml-network-requests="0"][data-kml-network-receipts="0"][data-kml-losses="1"]'
      + '[data-kml-shared-styles="2"][data-kml-schemas="1"][data-kml-resources="1"][data-kml-resource-bytes="68"]').waitFor();
    await page.locator('.gis-kml-layer-editor[data-folders="1"][data-placemarks="3"][data-losses="1"]'
      + '[data-overlays="3"][data-network-links="1"][data-linked-features="0"]'
      + '[data-shared-styles="2"][data-schemas="1"][data-resources="1"][data-resource-bytes="68"]').waitFor();
    await expectText(page, "Shared styles", "KML shared-style disclosure");
    await expectText(page, "Typed schemas", "KML typed-schema disclosure");
    await expectText(page, "Opaque resource bytes", "KMZ opaque-resource disclosure");
    const importedDefinitions = await page.locator(".opengeo-workbench").evaluate((shell) => {
      const tower = shell.__opengeoData.get("kml-places")?.features?.find(({id}) => id === "tower");
      return {
        color: tower?.properties?.kmlColor,
        scale: tower?.properties?.kmlScale,
        schemaData: tower?.properties?.schemaData,
        effectiveHref: tower?.properties?.effectiveStyle?.icon?.href
      };
    });
    if (importedDefinitions.color !== "#332211"
      || importedDefinitions.scale !== 1.25
      || importedDefinitions.schemaData?.[0]?.values?.sampleCount !== 7
      || importedDefinitions.schemaData?.[0]?.values?.verified !== true
      || importedDefinitions.effectiveHref !== "maps/icons/tower.png") {
      failures.push(`KML shared definitions: browser render data drifted (${JSON.stringify(importedDefinitions)})`);
    }
    await page.waitForFunction(() => Boolean(document.querySelector('.maplibregl-map[data-kml-region-inactive="1"]')));
    await page.waitForFunction(() => Boolean(document.querySelector('.gis-kml-screen-overlay[data-overlay-id="screen-overlay"]:not([hidden])')));
    const overlayRendering = await page.locator(".opengeo-workbench").evaluate((shell) => ({
      groundImageLayer: Boolean(shell.__opengeoMap.getLayer("kml-places-image-ground-overlay")),
      groundImageSource: Boolean(shell.__opengeoMap.getSource("kml-places-source-image-ground-overlay")),
      screenOverlay: Boolean(document.querySelector('.gis-kml-screen-overlay[data-overlay-id="screen-overlay"]:not([hidden])')),
      inactiveRegions: Number(shell.__opengeoMap.getContainer().dataset.kmlRegionInactive),
      photoFeature: shell.__opengeoData.get("kml-places")?.features?.some(({id, properties}) => id === "photo-overlay" && properties.kmlOverlayKind === "photo-overlay")
    }));
    if (!overlayRendering.groundImageLayer || !overlayRendering.groundImageSource || !overlayRendering.screenOverlay
      || overlayRendering.inactiveRegions !== 1 || !overlayRendering.photoFeature) {
      failures.push(`KML overlays: map/screen/Region rendering drifted (${JSON.stringify(overlayRendering)})`);
    }
    await page.getByRole("tree", {name: "KML layer hierarchy"}).getByText("Field sites", {exact: true}).waitFor();
    await page.getByRole("button", {name: "Fly to Tower", exact: true}).waitFor();
    await page.getByRole("button", {name: "Download KML", exact: true}).waitFor();
    await page.getByRole("button", {name: "Download KMZ", exact: true}).waitFor();
    await page.getByRole("button", {name: "Download KML loss report", exact: true}).waitFor();
    await page.getByRole("button", {name: "Edit Browser live stations", exact: true}).click();
    const networkPanel = page.locator('.gis-kml-network-link-panel[data-kml-network-link="browser-network-link"]');
    await networkPanel.locator('[data-kml-network-link-action="refresh"]:disabled').waitFor();
    await networkPanel.locator('[data-kml-network-link-action="authorize"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="1"][data-kml-network-conditional="false"]'
      + '[data-kml-network-receipts="1"][data-kml-linked-features="1"]').waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoData
      ?.get("kml-places")?.features?.some(({id}) => id === "browser-network-link--linked-station"));
    await expectText(page, "pass · 0 declared losses", "initial governed NetworkLink parse");
    await page.locator('[data-kml-network-link-action="refresh"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="2"][data-kml-network-conditional="true"]'
      + '[data-kml-network-receipts="2"][data-kml-linked-features="1"]').waitFor();
    await expectText(page, "not_modified · 0 declared losses", "conditional NetworkLink refresh");
    acceptedKmlNetworkLink = {
      importedInert: true,
      sessionApprovalMinutes: 15,
      initialStatus: 200,
      conditionalStatus: 304,
      requestCount: 2,
      linkedFeatures: 1,
      declaredLosses: 0,
      credentialsSent: false,
      redirects: 0,
      timeoutMilliseconds: 10_000,
      approvalPersisted: false,
      bodyPersisted: false,
      receiptMetadataPersisted: false,
      reloadApprovalRequired: false,
      reloadFetchedUnconditionally: false,
      reloadRequestCount: 0,
      reloadReceiptCount: 0
    };
    browserProgress("UX-002: initial and conditional NetworkLink refresh passed");
    const creator = page.locator(".gis-places-authoring:not(.gis-places-editor):not(.gis-overlay-authoring)");
    await creator.locator("summary").click();
    await creator.locator('[data-kml-authoring-field="name"]').fill("Authored sites");
    await creator.locator('[data-kml-authoring-field="kind"]').selectOption("folder");
    await creator.locator('[data-kml-authoring-action="create"]').click();
    await page.locator('.gis-kml-layer-editor[data-folders="2"][data-placemarks="3"]').waitFor();
    const pointCreator = page.locator(".gis-places-authoring:not(.gis-places-editor):not(.gis-overlay-authoring)");
    await pointCreator.locator("summary").click();
    await pointCreator.locator('[data-kml-authoring-field="name"]').fill("Authored station");
    await pointCreator.locator('[data-kml-authoring-field="kind"]').selectOption("Point");
    await pointCreator.locator('[data-kml-authoring-field="parent"]').selectOption("authored-sites");
    await pointCreator.locator('[data-kml-authoring-field="coordinates"]').fill("12.4924,41.8902,48");
    await pointCreator.locator('[data-kml-authoring-field="altitude"]').selectOption("absolute");
    await pointCreator.locator('[data-kml-authoring-field="color"]').fill("ff00ff00");
    await pointCreator.locator('[data-kml-authoring-action="create"]').click();
    await page.locator('.gis-kml-layer-editor[data-folders="2"][data-placemarks="4"]').waitFor();
    const editor = page.locator(".gis-places-editor");
    await editor.locator('[data-kml-editing-field="name"]').fill("Validated station");
    await editor.locator('[data-kml-editing-field="visibility"]').uncheck();
    await editor.locator('[data-kml-editing-field="parent"]').selectOption("field-sites");
    await editor.locator('[data-kml-authoring-action="update"]').click();
    const authoredState = await page.locator(".opengeo-workbench").evaluate((shell) => {
      const feature = shell.__opengeoData.get("kml-places")?.features?.find(({id}) => id === "authored-station");
      return {
        authoring: shell.dataset.kmlAuthoring,
        name: feature?.properties?.name,
        visibility: feature?.properties?.visibility,
        folderPath: feature?.properties?.folderPath,
        color: feature?.properties?.kmlColor,
        altitude: feature?.geometry?.coordinates?.[2]
      };
    });
    if (authoredState.authoring !== "changed"
      || authoredState.name !== "Validated station"
      || authoredState.visibility !== false
      || authoredState.folderPath?.join("/") !== "Field sites"
      || authoredState.color !== "#00ff00"
      || authoredState.altitude !== 48) {
      failures.push(`KML Places authoring: create/edit/group/style state drifted (${JSON.stringify(authoredState)})`);
    }
    const overlayCreator = page.locator(".gis-overlay-authoring");
    await overlayCreator.locator("summary").click();
    await overlayCreator.locator('[data-kml-overlay-field="name"]').fill("Authored ground image");
    await overlayCreator.locator('[data-kml-overlay-field="kind"]').selectOption("ground-overlay");
    await overlayCreator.locator('[data-kml-overlay-field="parent"]').selectOption("field-sites");
    await overlayCreator.locator('[data-kml-overlay-field="extent"]').fill("13.43,52.53,13.47,52.57");
    await overlayCreator.locator('[data-kml-overlay-field="min-lod"]').fill("0");
    await overlayCreator.locator('[data-kml-overlay-field="max-lod"]').fill("-1");
    await overlayCreator.locator('[data-kml-overlay-field="image"]').setInputFiles({
      name: "authored-overlay.png",
      mimeType: "image/png",
      buffer: kmlPlacesBrowserIcon
    });
    await overlayCreator.locator('[data-kml-overlay-action="create"]').click();
    await page.locator('.gis-kml-layer-editor[data-folders="2"][data-placemarks="4"][data-overlays="4"]'
      + '[data-resources="2"][data-resource-bytes="136"]').waitFor();
    await page.waitForFunction(() => Boolean(document.querySelector(".opengeo-workbench")?.__opengeoMap.getLayer("kml-places-image-authored-ground-image")));
    const authoredOverlay = await page.locator(".opengeo-workbench").evaluate((shell) => {
      const feature = shell.__opengeoData.get("kml-places")?.features?.find(({id}) => id === "authored-ground-image");
      return {
        kind: feature?.properties?.kmlOverlayKind,
        href: feature?.properties?.kmlOverlayHref,
        regionCount: feature?.properties?.kmlRegions?.length,
        geometry: feature?.geometry?.type,
        imageLayer: Boolean(shell.__opengeoMap.getLayer("kml-places-image-authored-ground-image"))
      };
    });
    if (authoredOverlay.kind !== "ground-overlay" || authoredOverlay.href !== "overlays/authored-ground-image.png"
      || authoredOverlay.regionCount !== 1 || authoredOverlay.geometry !== "Polygon" || !authoredOverlay.imageLayer) {
      failures.push(`KML overlay authoring: local image or Region model drifted (${JSON.stringify(authoredOverlay)})`);
    }
    const beforePlaceFlyTo = await readGlobeCamera(page);
    await page.getByRole("button", {name: "Fly to Tower", exact: true}).click();
    await waitForGlobeCameraChange(page, beforePlaceFlyTo, ["longitude", "latitude", "zoom"]);
    await settleGlobeCamera(page);
    const afterPlaceFlyTo = await readGlobeCamera(page);
    acceptedKmlPlaces = {
      source: "kmz",
      document: "Browser Places",
      folders: 2,
      placemarks: 4,
      overlays: 4,
      mappedFeatures: 8,
      declaredLosses: 1,
      loss: "invalid NetworkLink",
      sharedStyles: 2,
      typedSchemas: 1,
      typedSampleCount: 7,
      typedVerified: true,
      importedResources: 1,
      resourcesAfterAuthoring: 2,
      resourceBytesAfterAuthoring: 136,
      canonicalResourcePath: "maps/icons/tower.png",
      effectiveKmlColor: "ff112233",
      groundOverlayRendered: true,
      screenOverlayRendered: true,
      photoOverlayPreviewAnchored: true,
      regionLodInactiveFeatures: 1,
      authoredOverlay: "Authored ground image",
      authoredFolder: "Authored sites",
      authoredPlacemark: "Validated station",
      authoredVisibility: false,
      authoredParent: "Field sites",
      authoredKmlColor: "ff00ff00",
      authoringPersisted: false,
      flyToCameraDelta: roundCameraDelta(beforePlaceFlyTo, afterPlaceFlyTo, ["longitude", "latitude", "zoom"]),
      kmlDownloadAvailable: true,
      kmzDownloadAvailable: true,
      lossReportDownloadAvailable: true,
      saveAsPersisted: false,
      reloadRestored: false,
      authoritativeResavePersisted: false
    };

    browserProgress("UX-002: saving authored KML layer content and safe NetworkLink receipts");
    lastMapUpdate = null;
    lastMapCreate = null;
    await page.getByRole("button", {name: "Save as", exact: true}).click();
    await page.getByRole("dialog", {name: "Save as or export Project", exact: true})
      .getByRole("button", {name: "Save a new OpenGeo map", exact: true}).click();
    const saveAsName = page.locator(".gis-save-as-dialog input");
    await page.waitForTimeout(250);
    if (!await saveAsName.count()) {
      const saveAsState = await page.locator(".opengeo-workbench").getAttribute("data-save-as-state");
      throw new Error(`Save As did not open; state=${saveAsState}: ${await page.locator("body").innerText()}`);
    }
    if (!await saveAsName.evaluate((input) => input === document.activeElement)) {
      failures.push("Save As: keyboard focus did not move into the modal name field");
    }
    await saveAsName.fill("Field atlas review");
    await page.getByRole("button", {name: "Create new map"}).click();
    await page.waitForURL(new RegExp(`map=${IDS.savedMap}`));
    await page.locator(".opengeo-workbench").waitFor();
    if (lastMapUpdate !== null) failures.push("Save As: the original map was implicitly overwritten");
    if (lastMapCreate?.name !== "Field atlas review" || !Array.isArray(lastMapCreate?.definition?.layers)) {
      failures.push("Save As: the separate map did not preserve the current portable definition");
    }
    const savedGlobeView = lastMapCreate?.definition?.mapViews?.[0];
    if (lastMapCreate?.definition?.projection !== "globe"
      || lastMapCreate?.definition?.terrain?.enabled !== true
      || lastMapCreate?.definition?.terrain?.sourceId !== "opengeo-mapterhorn-terrain"
      || lastMapCreate?.definition?.terrain?.exaggeration !== 1
      || lastMapCreate?.definition?.openScene3d?.enabled !== true
      || lastMapCreate?.definition?.openScene3d?.sourceId !== "opengeo-openfreemap-3d"
      || lastMapCreate?.definition?.openScene3d?.snapshotVersion !== OPEN_3D_SCENE_SOURCE.snapshotVersion
      || lastMapCreate?.definition?.kmlPlaces?.name !== "Browser Places"
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.name !== "Field sites"
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.length !== 9
      || !lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.some(({kind, id}) => kind === "network-link" && id === "browser-network-link")
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-2)?.name !== "Validated station"
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-2)?.visibility !== false
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-1)?.kind !== "ground-overlay"
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-1)?.region?.lod?.maxPixels !== -1
      || lastMapCreate?.definition?.kmlPlaces?.children?.[1]?.name !== "Authored sites"
      || lastMapCreate?.definition?.kmlPlaces?.styles?.length !== 2
      || lastMapCreate?.definition?.kmlPlaces?.schemas?.[0]?.id !== "survey-schema"
      || lastMapCreate?.definition?.kmlPlaces?.children?.[0]?.children?.[0]?.schemaData?.[0]?.values?.sampleCount !== 7
      || lastMapCreate?.definition?.kmlPlaces?.resources?.[0]?.path !== "maps/icons/tower.png"
      || lastMapCreate?.definition?.kmlPlaces?.resources?.[0]?.byteLength !== 68
      || lastMapCreate?.definition?.kmlPlaces?.resources?.[1]?.path !== "overlays/authored-ground-image.png"
      || lastMapCreate?.definition?.kmlPlaces?.resources?.[1]?.byteLength !== 68
      || lastMapCreate?.definition?.kmlInterchangeReport?.result !== "pass_with_declared_losses"
      || lastMapCreate?.definition?.kmlInterchangeReport?.counts?.omitted !== 1
      || lastMapCreate?.definition?.kmlNetworkLinkState?.receipts?.length !== 2
      || lastMapCreate?.definition?.kmlNetworkLinkState?.receipts?.some((receipt) => Object.hasOwn(receipt, "bodyText") || Object.hasOwn(receipt, "bodyBase64"))
      || Object.hasOwn(lastMapCreate?.definition ?? {}, "kmlNetworkLinkApprovals")
      || !Array.isArray(savedGlobeView?.center)
      || savedGlobeView.center.length !== 2
      || !savedGlobeView.center.every(Number.isFinite)
      || !(savedGlobeView.zoom > 2)
      || !Number.isFinite(savedGlobeView.pitch)
      || !Number.isFinite(savedGlobeView.bearing)) {
      failures.push(`Save As: live globe camera was not persisted (${JSON.stringify({
        projection: lastMapCreate?.definition?.projection,
        terrain: lastMapCreate?.definition?.terrain,
        view: savedGlobeView
      })})`);
    } else if (acceptedKmlPlaces) {
      acceptedKmlPlaces.saveAsPersisted = true;
      acceptedKmlPlaces.authoringPersisted = true;
      if (acceptedKmlNetworkLink) acceptedKmlNetworkLink.receiptMetadataPersisted = true;
    }

    await page.getByRole("button", {name: "Catalog", exact: true}).click();
    await page.waitForTimeout(50);
    await page.reload({waitUntil: "load"});
    browserProgress("UX-002: saved project reloaded without NetworkLink authorization");
    await page.locator(".opengeo-workbench").waitFor();
    await page.locator(".gis-map .maplibregl-canvas").waitFor();
    await page.locator('.opengeo-workbench[data-projection="globe"]').waitFor();
    await page.locator('.opengeo-workbench[data-terrain="enabled"]').waitFor();
    await page.locator('.opengeo-workbench[data-open-scene3d="enabled"]').waitFor();
    if (await page.locator(".gis-kml-contents:visible").count() === 0) {
      await page.locator('.gis-menu-wrap[data-menu="view"] > button').click();
      await page.getByRole("button", {name: "Show layer panel", exact: true}).click();
    }
    const restoredKmlContents = page.locator(".gis-kml-contents:visible");
    await restoredKmlContents.waitFor();
    if (await restoredKmlContents.getAttribute("open") === null) {
      await restoredKmlContents.locator(":scope > summary").click();
    }
    await restoredKmlContents.locator('.gis-kml-layer-editor[data-folders="2"][data-placemarks="4"][data-overlays="4"][data-losses="1"]'
      + '[data-network-links="1"][data-linked-features="0"]'
      + '[data-shared-styles="2"][data-schemas="1"][data-resources="2"][data-resource-bytes="136"]').waitFor();
    await page.locator('.opengeo-workbench[data-kml-network-requests="0"][data-kml-network-receipts="2"]'
      + '[data-kml-linked-features="0"]').waitFor();
    await page.waitForFunction(() => Boolean(document.querySelector(".opengeo-workbench")?.__opengeoMap.getLayer("kml-places-image-authored-ground-image")));
    await page.getByRole("button", {name: "Fly to Tower", exact: true}).waitFor();
    await page.getByRole("button", {name: "Edit Browser live stations", exact: true}).click();
    const restoredNetworkPanel = page.locator('.gis-kml-network-link-panel[data-kml-network-link="browser-network-link"]');
    await restoredNetworkPanel.locator('[data-kml-network-link-action="refresh"]:disabled').waitFor();
    if (await restoredNetworkPanel.getAttribute("data-authorization") !== "required") {
      failures.push("KML NetworkLink reload: session approval persisted across reload");
    } else if (acceptedKmlNetworkLink) {
      acceptedKmlNetworkLink.reloadApprovalRequired = true;
    }
    if (!(await restoredNetworkPanel.innerText()).replace(/\s+/g, " ").includes("Linked content not loaded")) {
      failures.push('inert NetworkLink reload: expected "Linked content not loaded"');
    }
    await restoredNetworkPanel.locator('[data-kml-network-link-action="authorize"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="1"][data-kml-network-conditional="false"]'
      + '[data-kml-network-receipts="3"][data-kml-linked-features="1"]').waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoData
      ?.get("kml-places")?.features?.some(({id}) => id === "browser-network-link--linked-station"));
    if (acceptedKmlNetworkLink) {
      acceptedKmlNetworkLink.reloadFetchedUnconditionally = true;
      acceptedKmlNetworkLink.reloadRequestCount = 1;
      acceptedKmlNetworkLink.reloadReceiptCount = 3;
    }
    browserProgress("UX-002: explicit reload reauthorization passed");
    if (acceptedKmlPlaces) acceptedKmlPlaces.reloadRestored = true;
    await expectText(page, "open terrain on", "restored open terrain disclosure");
    await page.locator('.opengeo-workbench[data-terrain-governance="fresh-upstream"][data-terrain-outage="closed"]').waitFor();
    await expectText(page, "verified local source receipt", "fresh terrain source receipt disclosure");
    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const restoredGlobeView = lastMapUpdate?.definition?.mapViews?.[0];
    if (lastMapUpdate?.definition?.projection !== "globe"
      || lastMapUpdate?.definition?.terrain?.enabled !== true
      || lastMapUpdate?.definition?.terrain?.sourceId !== "opengeo-mapterhorn-terrain"
      || lastMapUpdate?.definition?.openScene3d?.enabled !== true
      || lastMapUpdate?.definition?.openScene3d?.sourceId !== "opengeo-openfreemap-3d"
      || lastMapUpdate?.definition?.kmlPlaces?.name !== "Browser Places"
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.length !== 9
      || !lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.some(({kind, id}) => kind === "network-link" && id === "browser-network-link")
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-2)?.name !== "Validated station"
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-2)?.visibility !== false
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-1)?.kind !== "ground-overlay"
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.at(-1)?.icon?.href !== "overlays/authored-ground-image.png"
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[1]?.name !== "Authored sites"
      || lastMapUpdate?.definition?.kmlPlaces?.styles?.length !== 2
      || lastMapUpdate?.definition?.kmlPlaces?.schemas?.[0]?.id !== "survey-schema"
      || lastMapUpdate?.definition?.kmlPlaces?.children?.[0]?.children?.[0]?.schemaData?.[0]?.values?.verified !== true
      || lastMapUpdate?.definition?.kmlPlaces?.resources?.[0]?.path !== "maps/icons/tower.png"
      || lastMapUpdate?.definition?.kmlPlaces?.resources?.[0]?.byteLength !== 68
      || lastMapUpdate?.definition?.kmlPlaces?.resources?.[1]?.path !== "overlays/authored-ground-image.png"
      || lastMapUpdate?.definition?.kmlPlaces?.resources?.[1]?.byteLength !== 68
      || lastMapUpdate?.definition?.kmlInterchangeReport?.counts?.omitted !== 1
      || lastMapUpdate?.definition?.kmlNetworkLinkState?.receipts?.length !== 3
      || lastMapUpdate?.definition?.kmlNetworkLinkState?.receipts?.some((receipt) => Object.hasOwn(receipt, "bodyText") || Object.hasOwn(receipt, "bodyBase64"))
      || Object.hasOwn(lastMapUpdate?.definition ?? {}, "kmlNetworkLinkApprovals")
      || !restoredMapViewMatches(savedGlobeView, restoredGlobeView)) {
      failures.push(`workspace refresh: saved globe camera was not deterministically restored (${JSON.stringify({
        saved: savedGlobeView,
        restored: restoredGlobeView,
        projection: lastMapUpdate?.definition?.projection,
        terrain: lastMapUpdate?.definition?.terrain
      })})`);
    } else if (acceptedGlobeNavigation) {
      acceptedGlobeNavigation.savedViewRestored = true;
      acceptedGlobeNavigation.restoredDimensions = ["longitude", "latitude", "zoom", "pitch", "bearing"];
      acceptedGlobeNavigation.restorationTolerance = {
        coordinateDegrees: 0.001,
        zoom: 0.001,
        pitchDegrees: 0.001,
        bearingDegrees: 0.001
      };
      if (acceptedKmlPlaces) acceptedKmlPlaces.authoritativeResavePersisted = true;
    }
    if (!await page.locator(".gis-left-panel-header h2", {hasText: "Layers"}).count()
      || await page.locator(".gis-left-panel-modes").count()) {
      failures.push("workspace refresh: the unified project-layer panel was not restored");
    }
    if (await page.locator(".opengeo-workbench.right-collapsed").count()) {
      failures.push("workspace refresh: the open inspector was not restored");
    }
    await expectText(page, "Data catalog", "restored inspector context");
    const requestsBeforeOutage = browserTerrainRequests.length;
    simulateTerrainOutage = true;
    for (let index = 0; index < 4; index += 1) {
      await page.locator(".opengeo-workbench").evaluate((shell) => {
        shell.__opengeoMap.refreshTiles("opengeo-mapterhorn-terrain");
      });
      await page.waitForTimeout(100);
    }
    await page.locator('.opengeo-workbench[data-terrain="disabled"][data-terrain-fallback="true"][data-terrain-governance="source-outage"][data-terrain-outage="open"]').waitFor({timeout: 10_000});
    await page.getByRole("button", {name: "Retry 3D terrain", exact: true}).waitFor();
    await expectText(page, "terrain unavailable · source outage cooldown", "terrain outage fallback disclosure");
    if (browserTerrainRequests.length - requestsBeforeOutage < 3) {
      failures.push("open terrain: the outage circuit opened without three failed source requests");
    }
    simulateTerrainOutage = false;
    await page.evaluate(() => {
      globalThis.opengeoOriginalDateNow = Date.now;
      const recoveryTime = Date.now() + 61_000;
      Date.now = () => recoveryTime;
    });
    await page.getByRole("button", {name: "Retry 3D terrain", exact: true}).click();
    await page.locator('.opengeo-workbench[data-terrain="enabled"][data-terrain-governance="fresh-upstream"]').waitFor();
    await page.locator('.opengeo-workbench[data-terrain-outage="closed"]').waitFor({timeout: 10_000});
    await expectText(page, "open terrain on", "terrain cooldown recovery disclosure");
    acceptedTerrainGovernance = {
      receiptStatus: "fresh-upstream",
      deploymentClass: "local",
      failureStatus: 503,
      failedRequests: browserTerrainRequests.length - requestsBeforeOutage,
      failureThreshold: 3,
      failureWindowMs: 30_000,
      cooldownMs: 60_000,
      fallback: "attributed-globe-without-elevation",
      recovered: true,
      authorityHeadersAbsent: true
    };
    await page.evaluate(() => {
      Date.now = globalThis.opengeoOriginalDateNow;
      delete globalThis.opengeoOriginalDateNow;
    });

    await page.getByRole("button", {name: "Add data", exact: true}).click();
    await page.locator(".gis-file-drop input[type=file]").setInputFiles({
      name: "field-roads.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from('{"type":"FeatureCollection","features":[]}')
    });
    await page.locator('.platform-workspace[data-import-state="queued"]').waitFor();
    await page.locator(".platform-import-notice").waitFor();
    await expectText(page, "governed dataset queued", "governed local-file handoff");
    if (await page.locator(".gis-layer-row", {hasText: "field-roads"}).count()) {
      failures.push("governed local-file handoff: an untracked scratch layer was created");
    }
    const returnToMap = page.url();
    const importedProjectId = new URL(returnToMap).searchParams.get("project");
    if (!importedProjectId) {
      throw new Error(`governed local-file handoff: active project was absent from ${returnToMap}`);
    }
    const importedDataRoute = `/workspaces?project=${encodeURIComponent(importedProjectId)}&manage=data#project-data`;
    await visit(page, `${baseUrl}${importedDataRoute}`, `${importedDataRoute} governed local-file result`);
    try {
      await page.locator(".project-dataset-card", {hasText: "field-roads"}).waitFor();
    } catch (error) {
      throw new Error(
        `governed local-file dataset was not visible in Data: ${JSON.stringify({
          fixtureDatasets: browserDatasets.map(({id, project_id: projectId, name, status}) => ({
            id, projectId, name, status
          })),
          renderedCards: await page.locator(".project-dataset-card").allTextContents(),
          page: (await page.locator("body").innerText()).slice(-4_000)
        })}`,
        {cause: error}
      );
    }
    await visit(page, returnToMap, "governed local-file handoff map return");
    await page.locator(".opengeo-workbench").waitFor();

    await page.setViewportSize({width: 390, height: 844});
    await page.reload({waitUntil: "load"});
    await page.locator(".opengeo-workbench").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) {
      const offenders = await page.evaluate(() => [...document.querySelectorAll("body *")]
        .map((element) => ({
          element: `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
          left: Math.round(element.getBoundingClientRect().left),
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width)
        }))
        .filter(({left, right}) => left < -1 || right > window.innerWidth + 1)
        .sort((a, b) => b.width - a.width)
        .slice(0, 5));
      const ancestry = await page.locator(".opengeo-workbench").evaluate((shell) => {
        const records = [];
        for (let element = shell; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          records.push({
            element: `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
            width: Math.round(element.getBoundingClientRect().width),
            cssWidth: style.width,
            minWidth: style.minWidth,
            maxWidth: style.maxWidth,
            padding: `${style.paddingLeft}/${style.paddingRight}`
          });
        }
        return records;
      });
      failures.push(`UX-002 representative task: narrow workbench overflows by ${overflow}px (${JSON.stringify({offenders, ancestry})})`);
    }
    await assertReadable(page, "UX-002 representative task");
    browserProgress("UX-002: behavioral assertions complete");
    if (screenshotsEnabled) {
      await page.screenshot({path: join(artifactRoot, "ux-002-representative-task-mobile-dark.png"), fullPage: true});
    }
  });
  browserProgress("UX-002: complete");
}

async function assertProjectDatasetReuse(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {
    token: "browser.test.token",
    disableInteractiveMap: true
  }, async (page) => {
    const firstRoute = `/workspaces?project=${IDS.projects[0]}&map=${IDS.maps[0]}`;
    await visit(page, `${baseUrl}${firstRoute}`, "reusable dataset first project");
    try {
      await page.locator(".opengeo-workbench").waitFor();
    } catch {
      throw new Error(`reusable dataset first project did not open: ${await page.locator("body").innerText()}`);
    }
    await page.getByRole("button", {name: "Add data", exact: true}).click();
    await page.getByRole("button", {name: "Add Access Road Network to map", exact: true}).click();
    await page.locator(".gis-layer-row", {hasText: "Access Road Network"}).waitFor();
    await page.getByLabel("Primary color").fill("#d62728");
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();

    const firstSaved = browserMapOverrides.get(`${IDS.projects[0]}:${IDS.maps[0]}`);
    const firstLayer = firstSaved?.definition?.layers?.find(({datasetId}) => datasetId === IDS.dataset);
    if (firstLayer?.style?.stroke !== "#d62728") {
      failures.push(`reusable dataset: first project style was not saved (${JSON.stringify(firstLayer?.style)})`);
    }

    const secondRoute = `/workspaces?project=${IDS.projects[1]}&map=${IDS.maps[1]}`;
    const secondDataRoute = `/workspaces?project=${IDS.projects[1]}&manage=data#project-data`;
    await visit(page, `${baseUrl}${secondDataRoute}`, "reusable dataset second project data");
    await page.locator(".project-datasets").waitFor();
    const picker = page.locator(".project-dataset-picker");
    if (!await picker.evaluate((details) => details.open)) await picker.locator("summary").click();
    await picker.getByLabel("Find an existing organization dataset").fill("Access Road Network");
    await picker.getByRole("button", {name: "Find datasets", exact: true}).click();
    await picker.getByRole("button", {name: "Add to project", exact: true}).click();
    await page.locator(`.project-dataset-card[data-dataset-id="${IDS.dataset}"]`).waitFor();

    await visit(page, `${baseUrl}${secondRoute}`, "reusable dataset second project map");
    await page.locator(".opengeo-workbench").waitFor();
    await page.getByRole("button", {name: "Add data", exact: true}).click();
    await page.getByRole("button", {name: "Add Access Road Network to map", exact: true}).click();
    await page.locator(".gis-layer-row", {hasText: "Access Road Network"}).waitFor();
    await page.getByLabel("Primary color").fill("#2563eb");
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();

    const secondSaved = browserMapOverrides.get(`${IDS.projects[1]}:${IDS.maps[1]}`);
    const secondLayer = secondSaved?.definition?.layers?.find(({datasetId}) => datasetId === IDS.dataset);
    if (secondLayer?.style?.stroke !== "#2563eb"
      || firstLayer?.style?.stroke === secondLayer?.style?.stroke) {
      failures.push(`reusable dataset: project styles were not independent (${JSON.stringify({first: firstLayer?.style, second: secondLayer?.style})})`);
    }

    await page.reload({waitUntil: "load"});
    await page.locator(".gis-layer-row", {hasText: "Access Road Network"}).waitFor();
    const reloadedColor = await page.getByLabel("Primary color").inputValue();
    if (reloadedColor !== "#2563eb") {
      failures.push(`reusable dataset: second project style did not survive reload (${reloadedColor})`);
    }
    await page.waitForFunction(
      (datasetId) => document.querySelector(".opengeo-workbench")
        ?.__opengeoData.get(`dataset_${datasetId}`)?.features?.length === 6,
      IDS.dataset
    );
    const reloadedFeatureCount = await page.locator(".opengeo-workbench").evaluate(
      (shell, datasetId) => shell.__opengeoData.get(`dataset_${datasetId}`)?.features?.length ?? 0,
      IDS.dataset
    );
    if (reloadedFeatureCount !== 6) {
      failures.push(`reusable dataset: governed features did not reload (${reloadedFeatureCount})`);
    }

    await page.setViewportSize({width: 390, height: 844});
    await assertWorkbenchLayoutConflicts(page, secondRoute, 390, "dark");
    await page.setViewportSize({width: 1440, height: 950});

    await visit(page, `${baseUrl}${secondDataRoute}`, "reusable dataset guarded detach");
    const reloadedDatasetCard = page.locator(
      `.project-dataset-card[data-dataset-id="${IDS.dataset}"]`
    );
    await reloadedDatasetCard.waitFor();
    const usedButton = reloadedDatasetCard.getByRole("button", {name: /^Used by a map\./});
    if (!await usedButton.count()) {
      failures.push(`reusable dataset: detach guard was not presented (${JSON.stringify(await reloadedDatasetCard.getByRole("button").allTextContents())})`);
    } else if (!await usedButton.isDisabled()) {
      failures.push("reusable dataset: detach was enabled while a saved map used the dataset");
    }

    await visit(page, `${baseUrl}${secondRoute}`, "reusable dataset layer removal");
    await page.locator(".opengeo-workbench").waitFor();
    const secondProjectRow = page.locator(".gis-layer-row", {hasText: "Access Road Network"});
    await secondProjectRow.locator(".gis-layer-more > summary").click();
    await secondProjectRow.getByRole("button", {name: "Remove layer from this project", exact: true}).click();
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    await visit(page, `${baseUrl}${secondDataRoute}`, "reusable dataset detach");
    await page.getByRole("button", {name: "Remove from project", exact: true}).click();
    await page.waitForFunction((datasetId) => !document.querySelector(`[data-dataset-id="${datasetId}"]`), IDS.dataset);

    const staleResponse = await page.evaluate(async ({projectId, mapId, datasetId, organizationId}) => {
      const response = await fetch(`/api/projects/${projectId}/maps/${mapId}`, {
        method: "PATCH",
        headers: {
          authorization: "Bearer browser.test.token",
          "content-type": "application/json",
          "x-opengeo-organization": organizationId
        },
        body: JSON.stringify({
          expected_version: 3,
          definition: {
            schemaVersion: "1.0.0",
            mapViews: [],
            basemaps: [],
            bookmarks: [],
            activeLayerId: `dataset_${datasetId}`,
            projection: "mercator",
            colorMode: "dark",
            layers: [{
              layerId: `dataset_${datasetId}`,
              datasetId,
              title: "Stale road reference",
              sourceType: "governed-dataset",
              geometryType: "LineString",
              visible: true,
              opacity: 1,
              order: 1,
              style: {stroke: "#000000", strokeWidth: 3},
              labels: {enabled: false, field: null}
            }]
          },
          change_message: "Attempt stale reference"
        })
      });
      return {status: response.status, body: await response.json()};
    }, {
      projectId: IDS.projects[1],
      mapId: IDS.maps[1],
      datasetId: IDS.dataset,
      organizationId: IDS.organization
    });
    if (staleResponse.status !== 409 || staleResponse.body?.detail?.code !== "map_dataset_not_linked") {
      failures.push(`reusable dataset: stale map reference was not denied (${JSON.stringify(staleResponse)})`);
    }

    await visit(page, `${baseUrl}${firstRoute}`, "reusable dataset first project reload");
    await page.locator(".gis-layer-row", {hasText: "Access Road Network"}).waitFor();
    const firstReloadedColor = await page.getByLabel("Primary color").inputValue();
    if (firstReloadedColor !== "#d62728") {
      failures.push(`reusable dataset: second project changes altered the first project (${firstReloadedColor})`);
    }
  });
}

async function assertKmlNetworkLinkPersistence(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {
    token: "browser.test.token",
    disableInteractiveMap: true
  }, async (page) => {
    browserProgress("KML NetworkLink: creating governed map");
    await visit(page, `${baseUrl}/workspaces?new=1`, "/workspaces NetworkLink persistence");
    await page.getByLabel("New project name").fill("NetworkLink persistence review");
    await page.getByLabel("New project description").fill("Focused governed KML refresh acceptance");
    await page.getByRole("button", {name: "Create project and map"}).click();
    await page.waitForURL(new RegExp(`/workspaces\\?project=${IDS.createdProject}&map=${IDS.createdMap}`));
    await page.locator(".opengeo-workbench").waitFor();

    browserProgress("KML NetworkLink: importing inert KMZ");
    await page.getByRole("button", {name: "Add data", exact: true}).click();
    await page.locator('.gis-file-drop input[type="file"]').setInputFiles({
      name: "browser-places.kmz",
      mimeType: "application/vnd.google-earth.kmz",
      buffer: kmlPlacesBrowserBytes
    });
    await page.locator('.opengeo-workbench[data-kml-import="pass_with_declared_losses"]'
      + '[data-kml-network-links="1"][data-kml-linked-features="0"]'
      + '[data-kml-network-requests="0"][data-kml-network-receipts="0"][data-kml-losses="1"]').waitFor();
    await page.getByRole("button", {name: "Edit Browser live stations", exact: true}).click();
    const initialPanel = page.locator('.gis-kml-network-link-panel[data-kml-network-link="browser-network-link"]');
    await initialPanel.locator('[data-kml-network-link-action="refresh"]:disabled').waitFor();

    browserProgress("KML NetworkLink: authorizing initial and conditional reads");
    await initialPanel.locator('[data-kml-network-link-action="authorize"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="1"][data-kml-network-conditional="false"]'
      + '[data-kml-network-receipts="1"][data-kml-linked-features="1"]').waitFor();
    await page.locator('[data-kml-network-link-action="refresh"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="2"][data-kml-network-conditional="true"]'
      + '[data-kml-network-receipts="2"][data-kml-linked-features="1"]').waitFor();

    browserProgress("KML NetworkLink: persisting safe receipts through Save As");
    lastMapCreate = null;
    await page.getByRole("button", {name: "Save as", exact: true}).click();
    await page.getByRole("dialog", {name: "Save as or export Project", exact: true})
      .getByRole("button", {name: "Save a new OpenGeo map", exact: true}).click();
    await page.locator(".gis-save-as-dialog input").fill("NetworkLink receipt copy");
    await page.getByRole("button", {name: "Create new map"}).click();
    await page.waitForURL(new RegExp(`map=${IDS.savedMap}`));
    await page.locator(".opengeo-workbench").waitFor();
    const savedDefinition = lastMapCreate?.definition;
    if (savedDefinition?.kmlPlaces?.children?.[0]?.children?.length !== 7
      || !savedDefinition?.kmlPlaces?.children?.[0]?.children?.some(({kind, id}) => kind === "network-link" && id === "browser-network-link")
      || savedDefinition?.kmlInterchangeReport?.counts?.omitted !== 1
      || savedDefinition?.kmlNetworkLinkState?.receipts?.length !== 2
      || savedDefinition?.kmlNetworkLinkState?.receipts?.some((receipt) => Object.hasOwn(receipt, "bodyText") || Object.hasOwn(receipt, "bodyBase64"))
      || Object.hasOwn(savedDefinition ?? {}, "kmlNetworkLinkApprovals")) {
      failures.push(`KML NetworkLink Save As: unsafe or incomplete persistence (${JSON.stringify(savedDefinition?.kmlNetworkLinkState)})`);
    }

    browserProgress("KML NetworkLink: proving inert reload");
    await page.reload({waitUntil: "load"});
    await page.locator('.opengeo-workbench[data-kml-network-links="1"]'
      + '[data-kml-network-requests="0"][data-kml-network-receipts="2"][data-kml-linked-features="0"]').waitFor();
    await page.locator(".gis-kml-contents > summary").click();
    await page.getByRole("button", {name: "Edit Browser live stations", exact: true}).click();
    const restoredPanel = page.locator('.gis-kml-network-link-panel[data-kml-network-link="browser-network-link"]');
    await restoredPanel.locator('[data-kml-network-link-action="refresh"]:disabled').waitFor();
    if (await restoredPanel.getAttribute("data-authorization") !== "required") {
      failures.push("KML NetworkLink reload: session approval persisted across reload");
    }
    if (!(await restoredPanel.innerText()).replace(/\s+/g, " ").includes("Linked content not loaded")) {
      failures.push('inert NetworkLink reload: expected "Linked content not loaded"');
    }

    browserProgress("KML NetworkLink: reauthorizing unconditional reload");
    await restoredPanel.locator('[data-kml-network-link-action="authorize"]').click();
    await page.locator('.opengeo-workbench[data-kml-network-requests="1"][data-kml-network-conditional="false"]'
      + '[data-kml-network-receipts="3"][data-kml-linked-features="1"]').waitFor();
    await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoData
      ?.get("kml-places")?.features?.some(({id}) => id === "browser-network-link--linked-station"));

    browserProgress("KML NetworkLink: authoritative re-save");
    lastMapUpdate = null;
    await page.getByRole("button", {name: "Save", exact: true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    const resavedDefinition = lastMapUpdate?.definition;
    if (resavedDefinition?.kmlNetworkLinkState?.receipts?.length !== 3
      || resavedDefinition?.kmlNetworkLinkState?.receipts?.some((receipt) => Object.hasOwn(receipt, "bodyText") || Object.hasOwn(receipt, "bodyBase64"))
      || Object.hasOwn(resavedDefinition ?? {}, "kmlNetworkLinkApprovals")) {
      failures.push(`KML NetworkLink re-save: unsafe receipt state (${JSON.stringify(resavedDefinition?.kmlNetworkLinkState)})`);
    }
    acceptedKmlNetworkLink = {
      importedInert: true,
      importedNetworkLinks: 1,
      invalidNetworkLinkLosses: 1,
      initialStatus: 200,
      conditionalStatus: 304,
      initialSessionRequests: 2,
      receiptMetadataPersisted: true,
      approvalPersisted: false,
      bodyPersisted: false,
      reloadApprovalRequired: true,
      reloadRequestCountBeforeAuthorization: 0,
      reloadFetchedUnconditionally: true,
      reloadRequestCountAfterAuthorization: 1,
      finalReceiptCount: 3,
      linkedFeatures: 1,
      credentialsSent: false,
      redirects: 0,
      timeoutMilliseconds: 10_000
    };
    browserProgress("KML NetworkLink: complete");
  });
}

function browserProgress(message) {
  if (process.env.OPEN_GEO_BROWSER_PROGRESS === "1") console.log(message);
}

async function readGlobeCamera(page) {
  return page.locator(".opengeo-workbench").evaluate((shell) => {
    const map = shell.__opengeoMap;
    const center = map?.getCenter?.();
    return {
      longitude: center?.lng,
      latitude: center?.lat,
      zoom: map?.getZoom?.(),
      pitch: map?.getPitch?.(),
      bearing: map?.getBearing?.()
    };
  });
}

async function waitForGlobeCameraChange(page, before, dimensions) {
  await page.waitForFunction(({before, dimensions}) => {
    const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
    const center = map?.getCenter?.();
    const current = {
      longitude: center?.lng,
      latitude: center?.lat,
      zoom: map?.getZoom?.(),
      pitch: map?.getPitch?.(),
      bearing: map?.getBearing?.()
    };
    return dimensions.some((dimension) => Number.isFinite(current[dimension])
      && Number.isFinite(before[dimension])
      && Math.abs(current[dimension] - before[dimension]) > 0.0001);
  }, {before, dimensions}, {timeout: 5_000});
}

async function settleGlobeCamera(page) {
  await page.waitForTimeout(200);
  await page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoMap?.stop?.());
  await page.waitForTimeout(50);
}

async function performTwoFingerGlobeGestures(page, center) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
  try {
    const pinchStart = [
      touchPoint(1, center.x - 38, center.y),
      touchPoint(2, center.x + 38, center.y)
    ];
    const pinchEnd = [
      touchPoint(1, center.x - 75, center.y + 24),
      touchPoint(2, center.x + 75, center.y - 24)
    ];
    await dispatchTouchGesture(session, pinchStart, pinchEnd);

    const pitchStart = [
      touchPoint(1, center.x - 45, center.y + 45),
      touchPoint(2, center.x + 45, center.y + 45)
    ];
    const pitchEnd = [
      touchPoint(1, center.x - 45, center.y - 35),
      touchPoint(2, center.x + 45, center.y - 35)
    ];
    await dispatchTouchGesture(session, pitchStart, pitchEnd);
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", {enabled: false});
    await session.detach();
  }
}

async function dispatchTouchGesture(session, start, end) {
  await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: start});
  for (let step = 1; step <= 8; step += 1) {
    const ratio = step / 8;
    const touchPoints = start.map((point, index) => touchPoint(
      point.id,
      point.x + (end[index].x - point.x) * ratio,
      point.y + (end[index].y - point.y) * ratio
    ));
    await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints});
  }
  await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
}

function touchPoint(id, x, y) {
  return {id, x, y, radiusX: 1, radiusY: 1, force: 1};
}

function roundCameraDelta(before, after, dimensions) {
  return Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    Math.round((after[dimension] - before[dimension]) * 1_000_000) / 1_000_000
  ]));
}

async function assertStudioAccount(browser, baseUrl) {
  for (const token of [null, "browser.test.token"]) {
    for (const width of [1100, 390]) {
      await withPlatformPage(browser, baseUrl, {token, disableInteractiveMap: true, viewport: {width, height: 844}}, async page => {
        await visit(page, `${baseUrl}/`, "Studio account header");
        await page.getByRole("button", {name: "Continue with an empty map", exact: true}).click();
        const label = token ? "Sign out" : "Sign in";
        const account = page.getByRole("button", {name: label, exact: true});
        await account.waitFor({state: "visible"});
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`Studio account header overflows at ${width}`);
        const height = (await page.locator(".gis-topbar").boundingBox()).height;
        if (width === 1100 && height > 160) {
          if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, "studio-header-density-failure.png")});
          throw Error(`Desktop header remains too tall: ${height}; ${await page.locator(".gis-topbar").evaluate(node => [...node.querySelectorAll(".gis-brand,.gis-app-nav,.gis-top-actions,.gis-primary-toolbar,.gis-menubar")].map(item => `${item.className}=${item.getBoundingClientRect().height}`).join(", "))}`);
        }
        await account.click();
        await page.getByRole("button", {name: "Stay on map", exact: true}).click();
        if (await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("opengeo.public-demo.studio-start-map")))) throw Error("Cancelling account navigation saved a draft");
        await account.click();
        await page.keyboard.press("Escape");
        if (!(await account.evaluate(node => node === document.activeElement))) throw Error("Account dialog did not restore keyboard focus");
        if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, `studio-account-${token ? "in" : "out"}-${width}.png`)});
        await account.click();
        await page.getByRole("button", {name: `Save locally and ${label.toLowerCase()}`, exact: true}).click();
        await page.waitForURL(url => url.pathname === (token ? "/logout" : "/oauth2/authorize"));
        const saved = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("opengeo.public-demo.studio-start-map"))?.[1]);
        if (!saved || JSON.parse(saved).workspaceId !== "studio-start-map") throw Error("Account navigation lost the local map");
        if (!token) {
          const target = await page.evaluate(() => JSON.parse(sessionStorage.getItem("opengeo.oauthTransaction")).returnTo);
          if (target !== "/") throw Error("Sign-in does not return to the local map");
        }
      });
    }
  }
}

async function assertInvitationRecovery(browser, baseUrl) {
  await withPlatformPage(browser, baseUrl, {token: "browser.test.token"}, async (page) => {
    await visit(page, `${baseUrl}/workspaces`, "administrator invitation navigation");
    await page.locator(".platform-account-menu > summary").click();
    await page.getByRole("navigation", {name: "Account settings", exact: true})
      .getByRole("link", {name: "People and access", exact: true}).click();
    await page.getByRole("heading", {name: "People and access", exact: true}).waitFor();
    await page.getByLabel("Email", {exact: true}).fill("reviewer@example.com");
    await page.getByLabel("Display name", {exact: true}).fill("Reviewer");
    await page.getByLabel("Organization role", {exact: true}).selectOption("guest");
    await page.getByLabel("Optional access workspace", {exact: true}).selectOption(IDS.projects[1]);
    await page.getByLabel("Project role", {exact: true}).selectOption("viewer");
    await page.getByLabel("Expires", {exact: true}).selectOption("3");
    const submitted = page.waitForRequest((request) => request.method() === "POST"
      && request.url() === `${baseUrl}/api/organizations/current/invitations`);
    await page.getByRole("button", {name: "Send invitation", exact: true}).click();
    const payload = (await submitted).postDataJSON();
    if (payload.project_id !== IDS.projects[1] || payload.project_role !== "viewer"
      || payload.organization_role !== "guest" || payload.expires_in_days !== 3) {
      throw new Error("Administrator invitation did not retain the selected project and access scope");
    }
    await page.getByRole("link", {name: "Back to projects", exact: true}).click();
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
  });
  for (const viewport of [{width: 1440, height: 950}, {width: 390, height: 844}]) {
    acceptedInvitationTokens.delete("invited.test.token");
    await withPlatformPage(browser, baseUrl, {token: "invited.test.token", viewport}, async (page) => {
      let invitationAvailable = false;
      let invitationReads = 0;
      let acceptanceWrites = 0;
      const documents = [];
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
        if (request.method() === "POST" && request.url().endsWith("/accept")) acceptanceWrites++;
      });
      await page.route(`${baseUrl}/api/auth/invitations`, async (route) => {
        invitationReads++;
        await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(
          invitationAvailable ? [pendingInvitationPayload()] : []
        )});
      });
      await visit(page, `${baseUrl}/workspaces`, "reviewer without membership");
      await page.getByRole("heading", {name: "No workspace access yet", exact: true}).waitFor();
      await expectText(page, "Signed in as browser-check@opengeo.tools", "reviewer identity");
      await page.getByRole("button", {name: "Check invitations", exact: true}).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", {name: "No workspace access yet", exact: true}).waitFor();
      if (invitationReads !== 2 || acceptanceWrites !== 0 || documents.length !== 1) {
        throw new Error("Checking an empty invitation list must be read-only and must not redirect");
      }
      invitationAvailable = true;
      await page.getByRole("button", {name: "Check invitations", exact: true}).click();
      await page.getByRole("heading", {name: "Accept your invitation", exact: true}).waitFor();
      if (acceptanceWrites !== 0) throw new Error("Checking invitations must not accept automatically");
      const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflowing) throw new Error(`Invitation recovery overflows at ${viewport.width}px`);
      if (screenshotsEnabled) await page.screenshot({path: join(artifactRoot, `invitation-recovery-${viewport.width}.png`), fullPage: true});
      await page.getByRole("button", {name: "Accept invitation", exact: true}).click();
      await page.locator('.composition-directory[data-state="ready"]').waitFor();
      if (acceptanceWrites !== 1 || documents.length !== 1) {
        throw new Error("Explicit acceptance must perform one write and return to projects without a redirect");
      }
    });
  }
  acceptedInvitationTokens.delete("invited.test.token");
  await withPlatformPage(browser, baseUrl, {token: "invited.test.token"}, async (page) => {
    await page.route(`${baseUrl}/api/auth/invitations`, (route) => route.fulfill({status: 200, contentType: "application/json", body: "[]"}));
    await visit(page, `${baseUrl}/workspaces`, "reviewer sign-out recovery");
    const logoutRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/logout");
    await page.getByRole("button", {name: "Sign out", exact: true}).click();
    const logoutUrl = new URL((await logoutRequest).url());
    if (logoutUrl.origin !== baseUrl || logoutUrl.searchParams.get("logout_uri") !== `${baseUrl}/login`) {
      throw new Error("Reviewer sign-out did not use the configured logout destination");
    }
    // The browser fixture reinjects its token on navigation; the existing Cognito
    // auth tests own storage clearing. This check covers the deliberate logout route.
  });
  browserProgress("Invitation recovery: admin navigation/scoped submission, explicit read/acceptance, narrow layout and logout route passed (synthetic API/auth)");
}

async function withPlatformPage(
  browser,
  baseUrl,
  {
    token,
    disableInteractiveMap = false,
    colorScheme = "dark",
    viewport = {width: 1440, height: 950},
    hasTouch = false,
    isMobile = false,
    clockNow = null
  },
  callback
) {
  const flightOnly = process.argv.includes("--flight-simulator");
  const offlineDirectory = process.argv.includes("--project-directory");
  const context = await browser.newContext({
    colorScheme, viewport, hasTouch, isMobile,
    ...(flightOnly || offlineDirectory ? {serviceWorkers: "block"} : {})
  });
  if (flightOnly || offlineDirectory) {
    // Register first so the existing explicit local/provider fixture routes take
    // precedence. Every remaining remote request fails before network access.
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === baseUrl) return route.continue();
      flightBrowserRequests.blockedUnexpected += 1;
      failures.push(`${offlineDirectory ? "project directory" : "flight simulator"}: unexpected external request blocked (${new URL(route.request().url()).origin})`);
      await route.abort("blockedbyclient");
    });
    context.on("request", (request) => {
      if (new URL(request.url()).origin === baseUrl) flightBrowserRequests.local += 1;
      else flightBrowserRequests.interceptedExternal += 1;
    });
  }
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(30_000);
  if (clockNow !== null) {
    const clockNowMs = Date.parse(clockNow);
    if (!Number.isFinite(clockNowMs)) throw new TypeError("browser fixture clock is invalid");
    await context.addInitScript((now) => {
      Date.now = () => now;
    }, clockNowMs);
  }
  await context.route(`${baseUrl}/api/**`, async (route) => {
    const request = route.request();
    const headers = {...request.headers()};
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    const upstream = await fetch(request.url(), {
      method: request.method(),
      headers,
      body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postDataBuffer()
    });
    const responseHeaders = Object.fromEntries(upstream.headers);
    delete responseHeaders["content-length"];
    delete responseHeaders["transfer-encoding"];
    const response = {
      status: upstream.status,
      headers: responseHeaders
    };
    if (![204, 205, 304].includes(upstream.status) && request.method() !== "HEAD") {
      response.body = Buffer.from(await upstream.arrayBuffer());
    }
    await route.fulfill(response);
  });
  for (const directory of ["_import", "_node", "_npm", "_observablehq", "_file"]) {
    await context.route(`${baseUrl}/${directory}/**`, async (route) => {
      const filePath = routeFile(route.request().url());
      if (!filePath) {
        await route.fulfill({status: 404, body: "Not found"});
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: contentType(filePath),
        body: await readFile(filePath)
      });
    });
  }
  if (disableInteractiveMap) {
    await context.addInitScript(() => {
      globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = true;
    });
  }
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: ""
  }));
  await context.route("https://fonts.gstatic.com/**", (route) => route.fulfill({
    status: 204,
    contentType: "font/woff2",
    body: ""
  }));
  await context.route("https://a.basemaps.cartocdn.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: basemapTileBytes,
      headers: {"cache-control": "public,max-age=86400"}
    });
  });
  await context.route("https://s3.us-east-1.amazonaws.com/storage.opengeo.tools", async (route) => {
    const headers = route.request().headers();
    if (headers.authorization || headers["x-opengeo-organization"]) {
      failures.push("managed upload: API authority leaked to the signed S3 request");
    }
    await route.fulfill({
      status: 204,
      headers: {"access-control-allow-origin": "*"}
    });
  });
  await context.route("https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/**", async (route) => {
    const headers = route.request().headers();
    const target = new URL(route.request().url());
    if (headers.authorization || headers["x-opengeo-organization"]) {
      failures.push("managed download: API authority leaked to the signed S3 request");
    }
    if (target.searchParams.get("versionId") !== "browser-immutable-version") {
      failures.push("managed download: immutable S3 version was not preserved");
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/vnd.apache.parquet",
        "content-disposition": 'attachment; filename="access-roads.parquet"'
      },
      body: "browser-download-fixture"
    });
  });
  await context.route("https://s3.us-east-1.amazonaws.com/source.opengeo.tools", async (route) => {
    const headers = route.request().headers();
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("page source upload: API authority leaked to the signed S3 request");
    }
    await route.fulfill({
      status: 204,
      headers: {"access-control-allow-origin": "*"}
    });
  });
  await context.route("https://tiles.example.test/**", async (route) => {
    const headers = route.request().headers();
    browserSourceRequests.push({url: route.request().url(), headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("governed source: API or browser authority leaked to the XYZ request");
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      },
      body: sourceXyzTileBytes
    });
  });
  await context.route("https://regional.example.test/**", async (route) => {
    const headers = route.request().headers();
    browserRegionalBasemapRequests.push({url: route.request().url(), headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("regional basemap: API or browser authority leaked to the XYZ request");
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      },
      body: sourceXyzTileBytes
    });
  });
  await context.route("https://*.tile.openstreetmap.org/**", async (route) => {
    const headers = route.request().headers();
    browserPortalSourceRequests.push({url: route.request().url(), headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("governed portal source: API authority or browser credentials leaked to OpenStreetMap");
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      },
      body: sourceXyzTileBytes
    });
  });
  await context.route("https://tiles.mapterhorn.com/**", async (route) => {
    const headers = route.request().headers();
    browserTerrainRequests.push({url: route.request().url(), headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("open terrain: API authority, organization context, or cookies leaked to Mapterhorn");
    }
    if (simulateTerrainOutage) {
      await route.fulfill({
        status: 503,
        headers: {"content-type": "text/plain", "access-control-allow-origin": "*"},
        body: "deterministic terrain outage"
      });
    } else {
      await route.fulfill({
        status: 200,
        headers: {"content-type": "image/webp", "access-control-allow-origin": "*"},
        body: sourceXyzTileBytes
      });
    }
  });
  await context.route("https://tiles.openfreemap.org/**", async (route) => {
    const headers = route.request().headers();
    const target = new URL(route.request().url());
    browserOpenScene3dRequests.push({url: route.request().url(), headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("open 3D scene: API authority, organization context, or cookies leaked to OpenFreeMap");
    }
    if (target.pathname.startsWith("/styles/")) {
      await route.fulfill({
        status: 200,
        headers: {"content-type": "application/json", "access-control-allow-origin": "*"},
        body: JSON.stringify({
          version: 8,
          sources: {},
          layers: [{id: "background", type: "background", paint: {"background-color": "#dce7ec"}}]
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {"content-type": "application/vnd.mapbox-vector-tile", "access-control-allow-origin": "*"},
      body: openScene3dTileBytes
    });
  });
  await context.route("https://api.protomaps.com/styles/v5/**", async (route) => {
    const headers = route.request().headers();
    const target = new URL(route.request().url());
    browserProtomapsRequests.push({url: target.href, headers});
    if (headers.authorization || headers["x-opengeo-organization"] || headers.cookie) {
      failures.push("Protomaps basemap: API authority, organization context, or cookies leaked to the provider");
    }
    if (target.searchParams.get("key") !== "browser-check-origin-key") {
      failures.push("Protomaps basemap: resolved browser key was missing or changed before the provider request");
    }
    await route.fulfill({
      status: 200,
      headers: {"content-type": "application/json", "access-control-allow-origin": "*"},
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [{id: "background", type: "background", paint: {"background-color": "#18212c"}}]
      })
    });
  });
  if (token) {
    await context.addInitScript(({token, organizationId}) => {
      if (window !== window.top) return;
      sessionStorage.setItem("opengeo.accessToken", token);
      sessionStorage.setItem("opengeo.accessTokenExpiresAt", String(Date.now() + 3_600_000));
      if (!["multi.org.token", "invited.test.token"].includes(token)) {
        sessionStorage.setItem("opengeo.organizationId", organizationId);
      }
    }, {token, organizationId: IDS.organization});
  }
  const page = await context.newPage();
  capturePageErrors(page, `platform state ${token ?? "anonymous"}`);
  try {
    await callback(page, baseUrl);
  } finally {
    await context.close();
  }
}

async function assertAuthenticationStates(browser, baseUrl) {
  await withAuthPage(browser, {}, async (page) => {
    await visit(page, `${baseUrl}/login`, "/login signed out");
    await page.locator('[data-auth-state="signed_out"]').waitFor();
    await expectText(page, "Studio status: Signed out", "signed-out login");
    await expectText(page, "Sign in to OpenGeo", "signed-out login");
    await page.getByText("Using a shared or different account?").click();
    if (await page.getByRole("button", {name: "Sign out of auth.categori.se"}).count() !== 1) {
      failures.push("signed-out login: hosted account sign-out control is missing");
    }
    if (await page.locator('meta[name="referrer"][content="no-referrer"]').count() !== 1) {
      failures.push("signed-out login: no-referrer document policy is missing");
    }
    if (screenshotsEnabled) {
      await page.screenshot({path: join(artifactRoot, "login-auth-live-light.png"), fullPage: true});
    }
  });

  await withAuthPage(browser, {}, async (page) => {
    await visit(page, `${baseUrl}/login`, "/login PKCE start");
    await page.getByRole("button", {name: "Sign in to OpenGeo"}).click();
    await page.waitForURL(/\/oauth2\/authorize/);
    const authorize = new URL(page.url());
    if (authorize.searchParams.get("response_type") !== "code") failures.push("PKCE start: response_type is not code");
    if (authorize.searchParams.get("code_challenge_method") !== "S256") failures.push("PKCE start: S256 challenge is missing");
    if (!/^[A-Za-z0-9_-]{43}$/.test(authorize.searchParams.get("code_challenge") ?? "")) failures.push("PKCE start: challenge is invalid");
    if (authorize.searchParams.has("client_secret") || authorize.searchParams.has("token")) failures.push("PKCE start: credential leaked into authorize URL");
    const browserState = await page.evaluate(() => ({
      token: sessionStorage.getItem("opengeo.accessToken"),
      transaction: JSON.parse(sessionStorage.getItem("opengeo.oauthTransaction"))
    }));
    if (browserState.token !== null || !browserState.transaction?.verifier) failures.push("PKCE start: browser transaction state is invalid");
    await page.goBack({waitUntil: "domcontentloaded"});
    await page.locator('[data-auth-state="signed_out"]').waitFor();
    const returnedSignIn = page.getByRole("button", {name: "Sign in to OpenGeo"});
    if (!await returnedSignIn.isEnabled()) failures.push("PKCE back navigation: sign-in button remained disabled");
    await page.reload({waitUntil: "domcontentloaded"});
    await page.locator('[data-auth-state="signed_out"]').waitFor();
    await expectText(page, "Studio status: Signed out", "reloaded signed-out login");
  });

  await withAuthPage(browser, {transaction: true}, async (page) => {
    await visit(page, `${baseUrl}/login?code=valid-browser-code&state=${BROWSER_OAUTH_STATE}`, "/login callback success");
    await page.locator(".platform-project-table").waitFor();
    if (new URL(page.url()).pathname !== "/workspaces") failures.push("callback success: did not reach the project directory");
    const session = await page.evaluate(() => ({
      token: sessionStorage.getItem("opengeo.accessToken"),
      expiresAt: Number(sessionStorage.getItem("opengeo.accessTokenExpiresAt")),
      transaction: sessionStorage.getItem("opengeo.oauthTransaction")
    }));
    if (session.token !== "browser.test.token" || session.expiresAt <= Date.now() || session.transaction !== null) {
      failures.push("callback success: expiring browser session was not established safely");
    }
    if (page.url().includes("code=") || page.url().includes("state=")) failures.push("callback success: OAuth parameters remained in browser history");
  });

  await withAuthPage(browser, {transaction: true}, async (page) => {
    const exchangesBefore = tokenExchangeRequests;
    await visit(page, `${baseUrl}/login?code=must-not-be-sent&state=${"x".repeat(43)}`, "/login state mismatch");
    await page.locator('[data-auth-state="callback_error"]').waitFor();
    await expectText(page, "did not match the browser", "state mismatch");
    if (tokenExchangeRequests !== exchangesBefore) failures.push("state mismatch: token endpoint was called");
    if (new URL(page.url()).search) failures.push("state mismatch: callback query was not removed");
    const body = await page.locator("body").innerText();
    if (body.includes("must-not-be-sent")) failures.push("state mismatch: authorization code was rendered");
  });

  await withAuthPage(browser, {transaction: true}, async (page) => {
    const secretDescription = "private provider detail";
    await visit(
      page,
      `${baseUrl}/login?error=access_denied&error_description=${encodeURIComponent(secretDescription)}&state=${BROWSER_OAUTH_STATE}`,
      "/login provider rejection"
    );
    await page.locator('[data-auth-state="callback_error"]').waitFor();
    await expectText(page, "managed sign-in was cancelled", "provider rejection");
    const body = await page.locator("body").innerText();
    if (body.includes(secretDescription) || new URL(page.url()).search) failures.push("provider rejection: private callback detail was retained");
  });

  await withAuthPage(browser, {expired: true}, async (page) => {
    await visit(page, `${baseUrl}/login`, "/login expired session");
    await page.locator('[data-auth-state="expired"]').waitFor();
    await expectText(page, "Session expired", "expired session");
    await expectText(page, "Studio status: Session expired", "expired session");
    const cleared = await page.evaluate(() => sessionStorage.getItem("opengeo.accessToken"));
    if (cleared !== null) failures.push("expired session: access token was retained");
  });

  await withAuthPage(browser, {configUnavailable: true}, async (page) => {
    await visit(page, `${baseUrl}/login`, "/login missing configuration");
    await page.locator('[data-auth-state="configuration_error"]').waitFor();
    await expectText(page, "Sign-in is not configured", "missing auth configuration");
    await expectText(page, "Local test mode uses synthetic records", "local fixture boundary");
    const localFixture = page.locator('[data-action="local-fixture"]');
    if (await localFixture.getAttribute("href") !== "/workspaces?adapter=fixture") {
      failures.push("local fixture boundary: loopback entry link is missing or misdirected");
    }
    await localFixture.click();
    await page.waitForURL(`${baseUrl}/workspaces?adapter=fixture`);
    await page.locator('[data-adapter="fixture"]').waitFor();
    await page.getByRole("heading", {name: "Your projects"}).waitFor();
    await expectText(page, "Fixture adapter · browser test data · changes are memory-only", "local fixture entry");
    await expectText(page, "Your projects", "local fixture entry");
  });

  await withAuthPage(browser, {signedIn: true}, async (page) => {
    await visit(page, `${baseUrl}/login`, "/login sign out");
    await page.locator(".platform-project-table").waitFor();
    if (new URL(page.url()).pathname !== "/workspaces") {
      failures.push("signed-in login: did not continue directly to Projects");
    }
    await page.getByRole("button", {name: "Sign out"}).click();
    try {
      await page.waitForURL(`${baseUrl}/login`);
    } catch (error) {
      throw new Error(
        `sign out did not return to the local login route: ${JSON.stringify({url: page.url(), body: (await page.locator("body").innerText()).slice(0, 2000)})}`,
        {cause: error}
      );
    }
    await page.locator('[data-auth-state="signed_out"]').waitFor();
    const token = await page.evaluate(() => sessionStorage.getItem("opengeo.accessToken"));
    if (token !== null) failures.push("sign out: local access token was retained");
  });

  await withAuthPage(browser, {signedIn: true, apiUnavailable: true}, async (page) => {
    await visit(page, `${baseUrl}/login?returnTo=${encodeURIComponent("/workspaces#teams")}`, "/login API unavailable");
    await page.locator('.platform-state[data-state="error"]').waitFor();
    if (new URL(page.url()).pathname !== "/workspaces" || new URL(page.url()).hash !== "#teams") {
      failures.push("API unavailable: authenticated destination was not retained");
    }
    await expectText(page, "OpenGeo is temporarily unavailable", "API unavailable destination");
    const body = await page.locator("body").innerText();
    if (body.includes("Open public demo") || body.includes("Browse publications")) {
      failures.push("API unavailable: requested private destination was replaced by a public fallback");
    }
  });
}

async function withAuthPage(
  browser,
  {transaction = false, expired = false, signedIn = false, configUnavailable = false, apiUnavailable = false},
  callback
) {
  const context = await browser.newContext({
    colorScheme: "light",
    viewport: {width: 1280, height: 850},
    serviceWorkers: "block",
    ...((configUnavailable || apiUnavailable) ? {extraHTTPHeaders: {
      ...(configUnavailable ? {"X-OpenGeo-Test-Auth-Config": "unavailable"} : {}),
      ...(apiUnavailable ? {"X-OpenGeo-Test-Api": "unavailable"} : {})
    }} : {})
  });
  await context.addInitScript(({transaction, expired, signedIn, state, verifier, organizationId}) => {
    if (sessionStorage.getItem("opengeo.browserCheckInitialized")) return;
    sessionStorage.setItem("opengeo.browserCheckInitialized", "true");
    if (transaction) {
      sessionStorage.setItem("opengeo.oauthTransaction", JSON.stringify({
        state,
        verifier,
        createdAt: Date.now(),
        returnTo: "/workspaces"
      }));
    }
    if (expired || signedIn) {
      sessionStorage.setItem("opengeo.accessToken", signedIn ? "browser.test.token" : "expired.browser.token");
      sessionStorage.setItem("opengeo.accessTokenExpiresAt", String(Date.now() + (signedIn ? 3_600_000 : -1000)));
      sessionStorage.setItem("opengeo.organizationId", organizationId);
    }
  }, {transaction, expired, signedIn, state: BROWSER_OAUTH_STATE, verifier: BROWSER_OAUTH_VERIFIER, organizationId: IDS.organization});
  const page = await context.newPage();
  capturePageErrors(page, "authentication browser state");
  try {
    await callback(page);
  } finally {
    await context.close();
  }
}

async function expectText(page, expected, label) {
  const bodyText = await page.locator("body").innerText();
  if (!bodyText.includes(expected)) failures.push(`${label}: expected text ${JSON.stringify(expected)}`);
}

async function assertPrintLayout(page, route) {
  const canvases = await page.locator(".layout-canvas").count();
  const mapFrames = await page.locator(".layout-element.map_frame").count();
  if (!canvases) failures.push(`${route}: expected a layout canvas`);
  if (!mapFrames) failures.push(`${route}: expected a print map frame`);
}

async function assertReadable(page, route) {
  const selectors = ["body", "main", ".summary-tile", ".data-table td"];

  for (const selector of selectors) {
    const readable = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return true;
      const style = getComputedStyle(element);
      const foreground = parseRgb(style.color);
      const background = elementBackground(element);
      return contrastRatio(foreground, background) >= 4.3;

      function elementBackground(element) {
        for (let node = element; node; node = node.parentElement) {
          const color = parseRgb(getComputedStyle(node).backgroundColor);
          if (color.a > 0) return blend(color, {r: 0, g: 0, b: 0, a: 1});
        }
        return {r: 255, g: 255, b: 255, a: 1};
      }

      function parseRgb(value) {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (match) {
          const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
          return {r, g, b, a};
        }

        const srgb = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
        if (srgb) {
          const [, r, g, b, a = "1"] = srgb;
          return {r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a)};
        }

        return {r: 0, g: 0, b: 0, a: 1};
      }

      function blend(top, bottom) {
        const a = top.a + bottom.a * (1 - top.a);
        return {
          r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
          g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
          b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
          a
        };
      }

      function contrastRatio(a, b) {
        const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (light + 0.05) / (dark + 0.05);
      }

      function luminance(color) {
        const channels = [color.r, color.g, color.b].map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      }
    }, selector);

    if (!readable) failures.push(`${route}: low contrast for ${selector}`);
  }
}

async function handleAuthRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  const origin = `http://${request.headers.host}`;

  if (url.pathname === "/auth-config.json") {
    if (request.headers["x-opengeo-test-auth-config"] === "unavailable") {
      writeJson(response, 503, {detail: "fixture_unavailable"}, "browser-auth-config");
      return true;
    }
    writeJson(response, 200, {
      version: 1,
      region: "us-east-1",
      userPoolId: "us-east-1_BrowserCheck123",
      clientId: "browsercheckpublicclient123",
      hostedUiBaseUrl: origin,
      redirectUri: `${origin}/login`,
      logoutUri: `${origin}/login`,
      scopes: ["openid", "email", "profile"],
      capabilities: {kmlNetworkLinkFetch: kmlNetworkLinkMode}
    }, "browser-auth-config");
    return true;
  }

  if (url.pathname === "/oauth2/authorize") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    });
    response.end("<!doctype html><title>Managed login fixture</title><p>Managed login fixture</p>");
    return true;
  }

  if (url.pathname === "/oauth2/token") {
    tokenExchangeRequests += 1;
    const body = new URLSearchParams(await readRequestText(request));
    const valid = request.method === "POST"
      && request.headers["content-type"] === "application/x-www-form-urlencoded"
      && body.get("grant_type") === "authorization_code"
      && body.get("client_id") === "browsercheckpublicclient123"
      && body.get("code") === "valid-browser-code"
      && body.get("redirect_uri") === `${origin}/login`
      && body.get("code_verifier") === BROWSER_OAUTH_VERIFIER
      && !body.has("client_secret");
    writeJson(response, valid ? 200 : 400, valid ? {
      access_token: "browser.test.token",
      id_token: "discarded-browser-id-token",
      refresh_token: "discarded-browser-refresh-token",
      token_type: "Bearer",
      expires_in: 3600
    } : {error: "invalid_grant"}, "browser-token-exchange");
    return true;
  }

  if (url.pathname === "/logout") {
    const logoutUri = url.searchParams.get("logout_uri");
    if (url.searchParams.get("client_id") !== "browsercheckpublicclient123" || logoutUri !== `${origin}/login`) {
      writeJson(response, 400, {detail: "invalid_logout"}, "browser-logout");
      return true;
    }
    response.writeHead(303, {location: logoutUri, "cache-control": "no-store"});
    response.end();
    return true;
  }

  return false;
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  if (request.headers["x-opengeo-test-api"] === "unavailable") {
    writeJson(response, 503, {detail: "platform_unavailable"}, "browser-check-unavailable");
    return true;
  }

  const requestId = "browser-check-request";
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? null;
  if (!token) {
    writeJson(response, 401, {detail: "invalid_token"}, requestId);
    return true;
  }

  if (url.pathname === "/api/auth/session") {
    const memberships = token === "multi.org.token"
      ? [membership(IDS.organization, "admin"), membership(IDS.secondOrganization, "member")]
      : token === "invited.test.token" && !acceptedInvitationTokens.has(token)
        ? []
        : [membership(IDS.organization, token === "invited.test.token" ? "guest" : "admin")];
    const requestedOrganization = request.headers["x-opengeo-organization"] ?? null;
    const selected = requestedOrganization
      ? memberships.find((candidate) => candidate.organization_id === requestedOrganization) ?? null
      : memberships.length === 1 ? memberships[0] : null;
    writeJson(response, 200, {
      user_id: IDS.user,
      email: "browser-check@opengeo.tools",
      display_name: "Browser Check",
      memberships,
      selected_organization_id: selected?.organization_id ?? null,
      selected_organization_role: selected?.role ?? null
    }, requestId);
    return true;
  }

  if (url.pathname === "/api/auth/invitations" && request.method === "GET") {
    writeJson(response, 200, token === "invited.test.token" && !acceptedInvitationTokens.has(token)
      ? [pendingInvitationPayload()]
      : [], requestId);
    return true;
  }

  const acceptanceMatch = url.pathname.match(/^\/api\/auth\/invitations\/([0-9a-f-]+)\/accept$/i);
  if (acceptanceMatch) {
    if (token !== "invited.test.token" || acceptanceMatch[1] !== IDS.invitation) {
      writeJson(response, 404, {detail: "invitation_not_found"}, requestId);
      return true;
    }
    if (acceptedInvitationTokens.has(token)) {
      writeJson(response, 409, {detail: {code: "invitation_already_accepted"}}, requestId);
      return true;
    }
    acceptedInvitationTokens.add(token);
    writeJson(response, 200, {
      invitation_id: IDS.invitation,
      organization_id: IDS.organization,
      project_id: IDS.projects[0],
      organization_role: "guest",
      project_role: "viewer",
      accepted_at: "2026-08-19T13:00:00Z"
    }, requestId);
    return true;
  }

  if (request.headers["x-opengeo-organization"] !== IDS.organization) {
    writeJson(response, 409, {detail: "organization_scope_required"}, requestId);
    return true;
  }
  if (token === "error.test.token") {
    writeJson(response, 503, {detail: "workspace_store_unavailable"}, requestId);
    return true;
  }

  if (url.pathname === "/api/organizations/current") {
    writeJson(response, 200, {
      id: IDS.organization,
      name: "OpenGeo Browser Organization",
      slug: "opengeo-browser",
      status: "active",
      caller_role: "admin"
    }, requestId);
    return true;
  }

  if (url.pathname === "/api/compositions" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const status = url.searchParams.get("status") ?? "active";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const records = allProjectPayloads().flatMap(project => mapPayloadsForProject(project.id)
      .map(map => ({id: map.id, resource_type: "project", access_container_id: project.id,
        access_container_name: project.name, name: map.name, description: map.description,
        status: map.status, version: map.version, updated_at: map.updated_at})))
      .filter(record => (status === "all" || record.status === status)
        && `${record.name} ${record.description ?? ""} ${record.access_container_name}`.toLowerCase().includes(query));
    writeJson(response, 200, records.slice(offset, offset + limit), requestId);
    return true;
  }

  if (url.pathname === "/api/clients") {
    writeJson(response, 200, clientPayloads(), requestId);
    return true;
  }

  if (url.pathname === "/api/teams") {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const created = {
        id: "90000000-0000-4000-8000-000000000052",
        name: payload.name,
        description: payload.description,
        status: "active",
        caller_role: "owner",
        created_at: "2026-08-24T12:30:00Z",
        updated_at: "2026-08-24T12:30:00Z"
      };
      browserTeams.push(created);
      writeJson(response, 201, created, requestId);
    } else {
      writeJson(response, 200, browserTeams, requestId);
    }
    return true;
  }

  if (url.pathname === "/api/me/dataset-connections") {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const created = {
        ...browserUserConnections[0],
        connection_id: "a0000000-0000-4000-8000-000000000052",
        display_name: payload.display_name,
        bucket_name: payload.bucket_name,
        region_name: payload.region_name,
        object_prefix: payload.object_prefix,
        credential_mode: payload.credential_mode,
        role_arn: payload.role_arn,
        credential_ready: payload.credential_mode !== "access_key",
        status: payload.credential_mode === "access_key" ? "draft" : "unverified"
      };
      browserUserConnections.unshift(created);
      writeJson(response, 201, created, requestId);
    } else {
      writeJson(response, 200, browserUserConnections, requestId);
    }
    return true;
  }

  const userConnectionOverviewMatch = url.pathname.match(
    /^\/api\/me\/dataset-connections\/([0-9a-f-]+)\/overview$/i
  );
  if (userConnectionOverviewMatch) {
    const connection = browserUserConnections.find(
      ({connection_id: id}) => id === userConnectionOverviewMatch[1]
    );
    if (!connection) {
      writeJson(response, 404, {detail: "user_connection_not_found"}, requestId);
      return true;
    }
    writeJson(response, 200, {
      connection_id: connection.connection_id,
      target_revision: connection.target_revision,
      credential_revision: connection.credential_revision,
      health: connection.status === "disabled" ? "disabled" : "needs_verification",
      latest_verification: null,
      project_references: [{
        binding_id: IDS.connectionBinding,
        project_id: IDS.projects[0],
        project_name: "Nepal Energy Access",
        project_status: "active",
        display_name: "Shared geospatial data",
        created_at: "2026-08-24T12:00:00Z"
      }]
    }, requestId);
    return true;
  }

  const userConnectionMatch = url.pathname.match(
    /^\/api\/me\/dataset-connections\/([0-9a-f-]+)(\/credentials)?$/i
  );
  if (userConnectionMatch) {
    const connection = browserUserConnections.find(
      ({connection_id: id}) => id === userConnectionMatch[1]
    );
    if (!connection) {
      writeJson(response, 404, {detail: "user_connection_not_found"}, requestId);
      return true;
    }
    const payload = await readRequestJson(request);
    if (userConnectionMatch[2]) {
      connection.configured_secret_fields = Object.keys(payload)
        .filter((field) => field !== "expected_credential_revision")
        .sort();
      connection.credential_revision += 1;
    } else {
      Object.assign(connection, {
        display_name: payload.display_name,
        bucket_name: payload.bucket_name,
        region_name: payload.region_name,
        object_prefix: payload.object_prefix,
        ...(Object.hasOwn(payload, "role_arn") ? {role_arn: payload.role_arn} : {}),
        status: payload.enabled === false ? "disabled" : "unverified"
      });
    }
    connection.updated_at = "2026-08-24T12:31:00Z";
    writeJson(response, 200, connection, requestId);
    return true;
  }

  if (url.pathname === "/api/me/basemap-connections") {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const created = {
        connection_id: IDS.basemapConnection,
        owner_user_id: IDS.user,
        provider: payload.provider,
        display_name: payload.display_name,
        allowed_origins: payload.allowed_origins,
        configured_secret_fields: [],
        credential_revision: 0,
        credential_ready: false,
        status: "draft",
        browser_key_exposure: "client_visible",
        created_at: "2026-08-26T21:00:00Z",
        updated_at: "2026-08-26T21:00:00Z",
        owned_by_caller: true
      };
      browserUserBasemapConnections.splice(0, browserUserBasemapConnections.length, created);
      writeJson(response, 201, created, requestId);
    } else {
      writeJson(response, 200, browserUserBasemapConnections, requestId);
    }
    return true;
  }

  const userBasemapConnectionMatch = url.pathname.match(
    /^\/api\/me\/basemap-connections\/([0-9a-f-]+)(\/browser-key)?$/i
  );
  if (userBasemapConnectionMatch) {
    const connection = browserUserBasemapConnections.find(
      ({connection_id: id}) => id === userBasemapConnectionMatch[1]
    );
    if (!connection) {
      writeJson(response, 404, {detail: "user_basemap_connection_not_found"}, requestId);
      return true;
    }
    const payload = await readRequestJson(request);
    if (userBasemapConnectionMatch[2]) {
      if (payload.expected_credential_revision !== connection.credential_revision) {
        writeJson(response, 409, {detail: {code: "stale_credential_revision"}}, requestId);
        return true;
      }
      browserBasemapKeys.set(connection.connection_id, payload.api_key);
      Object.assign(connection, {
        configured_secret_fields: ["api_key"],
        credential_revision: connection.credential_revision + 1,
        credential_ready: true,
        status: "configured"
      });
    } else {
      Object.assign(connection, {
        ...(Object.hasOwn(payload, "display_name") ? {display_name: payload.display_name} : {}),
        ...(Object.hasOwn(payload, "allowed_origins") ? {allowed_origins: payload.allowed_origins} : {}),
        ...(payload.enabled === false
          ? {status: "disabled"}
          : payload.enabled === true
            ? {status: connection.credential_revision ? "configured" : "draft"}
            : {})
      });
    }
    connection.updated_at = "2026-08-26T21:01:00Z";
    writeJson(response, 200, connection, requestId);
    return true;
  }

  if (url.pathname === "/api/organizations/current/memberships") {
    writeJson(response, 200, organizationMemberPayloads(), requestId);
    return true;
  }

  if (url.pathname === "/api/organizations/current/invitations") {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      writeJson(response, 201, invitationPayload({
        id: "70000000-0000-4000-8000-000000000005",
        email: payload.email,
        display_name: payload.display_name,
        organization_role: payload.organization_role,
        project_id: payload.project_id,
        project_role: payload.project_role
      }), requestId);
    } else {
      writeJson(response, 200, invitationPayloads(), requestId);
    }
    return true;
  }

  const invitationMatch = url.pathname.match(/^\/api\/organizations\/current\/invitations\/([0-9a-f-]+)$/i);
  if (invitationMatch) {
    writeJson(response, 200, {...invitationPayloads()[0], status: "revoked", revoked_at: "2026-08-19T13:00:00Z"}, requestId);
    return true;
  }

  const organizationMemberMatch = url.pathname.match(/^\/api\/organizations\/current\/memberships\/([0-9a-f-]+)$/i);
  if (organizationMemberMatch) {
    if (request.method === "DELETE") {
      response.writeHead(204, {"X-Request-ID": requestId});
      response.end();
    } else {
      const payload = await readRequestJson(request);
      writeJson(response, 200, {user_id: organizationMemberMatch[1], role: payload.role}, requestId);
    }
    return true;
  }

  if (url.pathname === "/api/projects/recent") {
    writeJson(response, 200, allProjectPayloads().slice(0, 5).map((project, index) => ({
      ...project,
      caller_role: index === 0 ? null : project.caller_role,
      last_activity_at: `2026-08-${20 - index}T12:00:00Z`,
      last_event_type: index === 0 ? "map.updated" : "project.created"
    })), requestId);
    return true;
  }

  if (url.pathname === "/api/projects") {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const project = apiRecord({
        id: IDS.createdProject,
        client_id: payload.client_id,
        name: payload.name,
        project_code: payload.project_code,
        description: payload.description,
        caller_role: "owner"
      });
      browserCreatedProjects.splice(0, browserCreatedProjects.length, project);
      writeJson(response, 201, project, requestId);
    } else {
      writeJson(response, 200, allProjectPayloads(), requestId);
    }
    return true;
  }

  const projectTeamGrantMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/team-grants$/i
  );
  if (projectTeamGrantMatch) {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const team = browserTeams.find(({id}) => id === payload.team_id);
      writeJson(response, 201, {
        id: "91000000-0000-4000-8000-000000000051",
        project_id: projectTeamGrantMatch[1],
        team_id: payload.team_id,
        team_name: team?.name ?? "Team",
        role: payload.role,
        created_at: "2026-08-24T12:32:00Z",
        updated_at: "2026-08-24T12:32:00Z"
      }, requestId);
    } else {
      writeJson(response, 200, [], requestId);
    }
    return true;
  }

  const projectConnectionBindingMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/dataset-connection-bindings$/i
  );
  if (projectConnectionBindingMatch) {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const connection = browserUserConnections.find(
        ({connection_id: id}) => id === payload.connection_id
      );
      writeJson(response, 201, {
        binding_id: IDS.connectionBinding,
        project_id: projectConnectionBindingMatch[1],
        display_name: payload.display_name,
        created_by: IDS.user,
        created_at: "2026-08-24T12:33:00Z",
        connection
      }, requestId);
    } else {
      writeJson(response, 200, [], requestId);
    }
    return true;
  }

  const projectBasemapStyleMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/basemap-connection-bindings\/([0-9a-f-]+)\/styles\/(light|dark|white|grayscale|black|voyager|positron|dark-matter)$/i
  );
  if (projectBasemapStyleMatch) {
    const binding = (browserProjectBasemapBindings.get(projectBasemapStyleMatch[1]) ?? [])
      .find(({binding_id: id}) => id === projectBasemapStyleMatch[2]);
    const connection = binding?.connection;
    const apiKey = browserBasemapKeys.get(connection?.connection_id);
    if (!binding || connection?.status !== "configured" || !apiKey) {
      writeJson(response, 404, {detail: "project_basemap_connection_not_found"}, requestId);
      return true;
    }
    const flavor = projectBasemapStyleMatch[3].toLowerCase();
    const protomaps = connection.provider === "protomaps";
    const cartoPaths = {voyager: "rastertiles/voyager", positron: "light_all", "dark-matter": "dark_all"};
    writeJson(response, 200, {
      binding_id: binding.binding_id,
      connection_id: connection.connection_id,
      provider: connection.provider,
      connection_name: connection.display_name,
      flavor,
      resource_kind: protomaps ? "maplibre-style" : "raster",
      resource_url: protomaps
        ? `https://api.protomaps.com/styles/v5/${flavor}/en.json?key=${encodeURIComponent(apiKey)}`
        : `https://basemaps.cartocdn.com/${cartoPaths[flavor]}/{z}/{x}/{y}.png?key=${encodeURIComponent(apiKey)}`,
      attribution: protomaps
        ? "Protomaps · © OpenStreetMap contributors"
        : "© CARTO · © OpenStreetMap contributors",
      credential_revision: connection.credential_revision,
      browser_key_exposure: "client_visible"
    }, requestId);
    return true;
  }

  const projectBasemapBindingItemMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/basemap-connection-bindings\/([0-9a-f-]+)$/i
  );
  if (projectBasemapBindingItemMatch) {
    const bindings = browserProjectBasemapBindings.get(projectBasemapBindingItemMatch[1]) ?? [];
    const index = bindings.findIndex(({binding_id: id}) => id === projectBasemapBindingItemMatch[2]);
    if (index < 0) {
      writeJson(response, 404, {detail: "project_basemap_connection_not_found"}, requestId);
      return true;
    }
    bindings.splice(index, 1);
    response.writeHead(204, {"X-Request-ID": requestId});
    response.end();
    return true;
  }

  const projectBasemapBindingMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/basemap-connection-bindings$/i
  );
  if (projectBasemapBindingMatch) {
    const bindings = browserProjectBasemapBindings.get(projectBasemapBindingMatch[1]) ?? [];
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const connection = browserUserBasemapConnections.find(
        ({connection_id: id}) => id === payload.connection_id
      );
      if (!connection) {
        writeJson(response, 404, {detail: "user_basemap_connection_not_found"}, requestId);
        return true;
      }
      const binding = {
        binding_id: IDS.basemapConnectionBinding,
        project_id: projectBasemapBindingMatch[1],
        display_name: payload.display_name,
        created_by: IDS.user,
        created_at: "2026-08-26T21:02:00Z",
        connection
      };
      bindings.splice(0, bindings.length, binding);
      browserProjectBasemapBindings.set(projectBasemapBindingMatch[1], bindings);
      writeJson(response, 201, binding, requestId);
    } else {
      writeJson(response, 200, bindings, requestId);
    }
    return true;
  }

  if (url.pathname === "/api/datasets") {
    const query = url.searchParams.get("query")?.toLowerCase() ?? "";
    const projectId = url.searchParams.get("project_id");
    const clientId = url.searchParams.get("client_id");
    const projectIdsForClient = new Set(
      allProjectPayloads().filter((project) => !clientId || project.client_id === clientId).map((project) => project.id)
    );
    const records = browserDatasets.filter((dataset) =>
      projectIdsForClient.has(dataset.project_id)
      && (!projectId || dataset.project_id === projectId)
      && (!query || `${dataset.name} ${dataset.description ?? ""} ${dataset.tags.join(" ")}`.toLowerCase().includes(query))
      && (!url.searchParams.get("classification") || dataset.classification === url.searchParams.get("classification"))
    );
    writeJson(response, 200, records, requestId);
    return true;
  }

  const datasetsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets$/i);
  if (datasetsMatch) {
    const query = url.searchParams.get("query")?.toLowerCase() ?? "";
    const linkedIds = projectDatasetIds(datasetsMatch[1]);
    const records = browserDatasets.filter((dataset) =>
      linkedIds.has(dataset.id)
      && (!query || `${dataset.name} ${dataset.description ?? ""} ${dataset.tags.join(" ")}`.toLowerCase().includes(query))
      && (!url.searchParams.get("tag") || dataset.tags.includes(url.searchParams.get("tag")))
      && (!url.searchParams.get("format") || dataset.format === url.searchParams.get("format"))
      && (!url.searchParams.get("classification") || dataset.classification === url.searchParams.get("classification"))
      && (!url.searchParams.get("source_type") || dataset.source_type === url.searchParams.get("source_type"))
      && (!url.searchParams.get("geometry_type") || dataset.geometry_type === url.searchParams.get("geometry_type"))
    );
    writeJson(response, 200, records.map((dataset) => ({
      ...dataset,
      project_id: datasetsMatch[1]
    })), requestId);
    return true;
  }

  if (url.pathname === "/api/metadata-profiles" && request.method === "GET") {
    writeJson(response, 200, [metadataProfilePayload()], requestId);
    return true;
  }

  const spatialServicesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services$/i
  );
  if (spatialServicesMatch && request.method === "GET") {
    writeJson(
      response,
      200,
      spatialServicesMatch[1] === IDS.projects[0] ? [spatialServicePayload()] : [],
      requestId
    );
    return true;
  }

  const spatialCatalogMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/catalog$/i
  );
  if (spatialCatalogMatch && request.method === "GET") {
    const exists = spatialCatalogMatch[1] === IDS.projects[0]
      && spatialCatalogMatch[2] === IDS.spatialService;
    writeJson(
      response,
      exists ? 200 : 404,
      exists ? spatialServiceCatalogPayload() : {detail: "spatial_service_not_found"},
      requestId
    );
    return true;
  }

  const spatialCollectionsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections$/i
  );
  if (spatialCollectionsMatch && request.method === "GET") {
    const matches = spatialCollectionsMatch[1] === IDS.projects[0]
      && spatialCollectionsMatch[2] === IDS.spatialService;
    writeJson(response, 200, matches ? [spatialServiceCollectionPayload()] : [], requestId);
    return true;
  }

  const tileCachePolicyMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache$/i
  );
  if (tileCachePolicyMatch && request.method === "GET") {
    writeJson(response, 200, tileCachePolicyPayload({
      current_entries: tileSeedPlanQueued ? 2 : 0
    }), requestId);
    return true;
  }

  const tileSeedPlanPreviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache\/seed-plans\/preview$/i
  );
  if (tileSeedPlanPreviewMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    if (payload.expected_cache_version !== 2 || payload.mode !== "bbox"
      || !Array.isArray(payload.bbox) || payload.bbox.length !== 4
      || !payload.bbox.every(Number.isFinite)
      || !(payload.bbox[0] < payload.bbox[2] && payload.bbox[1] < payload.bbox[3])
      || payload.minimum_tile_matrix !== 0 || payload.maximum_tile_matrix !== 1) {
      writeJson(response, 400, {detail: {code: "invalid_tile_seed_preview"}}, requestId);
      return true;
    }
    tileSeedPlanBbox = [...payload.bbox];
    writeJson(response, 200, tileSeedPlanPreviewPayload({
      mode: "bbox",
      bbox: tileSeedPlanBbox
    }), requestId);
    return true;
  }

  const tileSeedPlansMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache\/seed-plans$/i
  );
  if (tileSeedPlansMatch && request.method === "GET") {
    writeJson(
      response,
      200,
      tileSeedPlanQueued
        ? [tileSeedPlanPayload({mode: "bbox", bbox: tileSeedPlanBbox})]
        : [],
      requestId
    );
    return true;
  }
  if (tileSeedPlansMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    if (payload.preview_checksum_sha256 !== "9".repeat(64)
      || payload.expected_cache_version !== 2 || payload.mode !== "bbox"
      || JSON.stringify(payload.bbox) !== JSON.stringify(tileSeedPlanBbox)
      || payload.minimum_tile_matrix !== 0 || payload.maximum_tile_matrix !== 1) {
      writeJson(response, 400, {detail: {code: "invalid_tile_seed_confirmation"}}, requestId);
      return true;
    }
    tileSeedPlanQueued = true;
    writeJson(response, 202, tileSeedPlanPayload({mode: "bbox", bbox: tileSeedPlanBbox}), requestId);
    return true;
  }

  const retiredTileCachesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache\/retired-versions$/i
  );
  if (retiredTileCachesMatch && request.method === "GET") {
    const matches = retiredTileCachesMatch[1] === IDS.projects[0]
      && retiredTileCachesMatch[2] === IDS.spatialService
      && retiredTileCachesMatch[3] === IDS.spatialBinding;
    writeJson(
      response,
      200,
      matches ? [retiredTileCacheVersionPayload({
        reclamation_id: tileCacheReclamationQueued ? IDS.tileCacheReclamation : null,
        reclamation_state: tileCacheReclamationQueued ? "queued" : null,
        reclamation_target_count: tileCacheReclamationQueued ? 1 : null
      })] : [],
      requestId
    );
    return true;
  }

  const tileCachePreviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache\/versions\/([0-9a-f-]+)\/reclamation-preview$/i
  );
  if (tileCachePreviewMatch && request.method === "POST") {
    writeJson(response, 200, tileCacheReclamationPreviewPayload(), requestId);
    return true;
  }

  const tileCacheReclaimMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/tile-cache\/versions\/([0-9a-f-]+)\/reclaim$/i
  );
  if (tileCacheReclaimMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    if (
      Object.keys(payload).sort().join(",")
        !== "preview_checksum_sha256,preview_expires_at"
      || payload.preview_checksum_sha256 !== "8".repeat(64)
    ) {
      writeJson(
        response, 400, {detail: {code: "invalid_cache_reclamation_confirmation"}}, requestId
      );
      return true;
    }
    tileCacheReclamationQueued = true;
    writeJson(response, 202, tileCacheReclamationPayload(), requestId);
    return true;
  }

  const coveragePolicyMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/coverage-processing-policy$/i
  );
  if (coveragePolicyMatch && request.method === "GET") {
    writeJson(response, 200, coverageProcessingPolicyPayload(), requestId);
    return true;
  }

  const spatialCoveragesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/coverages$/i
  );
  if (spatialCoveragesMatch && request.method === "GET") {
    const matches = spatialCoveragesMatch[1] === IDS.projects[0]
      && spatialCoveragesMatch[2] === IDS.spatialService;
    writeJson(response, 200, matches ? [spatialCoveragePayload()] : [], requestId);
    return true;
  }

  const coverageDerivativesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/coverages\/([0-9a-f-]+)\/derivatives$/i
  );
  if (coverageDerivativesMatch && request.method === "GET") {
    const matches = coverageDerivativesMatch[1] === IDS.projects[0]
      && coverageDerivativesMatch[2] === IDS.spatialService
      && coverageDerivativesMatch[3] === IDS.spatialCoverage;
    writeJson(
      response,
      200,
      matches ? [coverageDerivativePayload({
        reclamation_state: coverageReclamationQueued ? "queued" : null,
        output_available: !coverageReclamationQueued
      })] : [],
      requestId
    );
    return true;
  }

  const reclamationPreviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/coverages\/([0-9a-f-]+)\/derivatives\/([0-9a-f-]+)\/reclamation-preview$/i
  );
  if (reclamationPreviewMatch && request.method === "POST") {
    writeJson(response, 200, coverageReclamationPreviewPayload(), requestId);
    return true;
  }

  const coverageReclaimMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/spatial-services\/([0-9a-f-]+)\/coverages\/([0-9a-f-]+)\/derivatives\/([0-9a-f-]+)\/reclaim$/i
  );
  if (coverageReclaimMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    if (
      Object.keys(payload).sort().join(",")
        !== "preview_checksum_sha256,preview_expires_at"
      || payload.preview_checksum_sha256 !== "f".repeat(64)
    ) {
      writeJson(response, 400, {detail: {code: "invalid_reclamation_confirmation"}}, requestId);
      return true;
    }
    coverageReclamationQueued = true;
    writeJson(response, 202, coverageReclamationPayload(), requestId);
    return true;
  }

  const observableSourcesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-projects$/i
  );
  if (observableSourcesMatch && request.method === "GET") {
    writeJson(
      response,
      200,
      observableSourcesMatch[1] === IDS.projects[0] ? browserObservableSourceProjects : [],
      requestId
    );
    return true;
  }
  const observableSourceCreateMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/sites\/([0-9a-f-]+)\/source-project$/i
  );
  if (observableSourceCreateMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const project = observableSourceProjectPayload({
      project_id: observableSourceCreateMatch[1],
      site_id: observableSourceCreateMatch[2],
      title: payload.title
    });
    browserObservableSourceProjects.push(project);
    writeJson(response, 201, project, requestId);
    return true;
  }
  const observableUploadMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-projects\/([0-9a-f-]+)\/file-uploads$/i
  );
  if (observableUploadMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const uploadId = payload.relative_path === "index.md"
      ? IDS.sourceUploadMarkdown
      : IDS.sourceUploadLock;
    browserObservableSourceUploads.set(uploadId, payload);
    writeJson(response, 201, {
      upload_id: uploadId,
      source_project_id: observableUploadMatch[2],
      relative_path: payload.relative_path,
      content_type: payload.content_type,
      size_bytes: payload.size_bytes,
      checksum_sha256: payload.checksum_sha256,
      expires_at: "2099-08-22T18:15:00Z",
      upload: observableSourceUploadInstructionsPayload(payload, uploadId)
    }, requestId);
    return true;
  }
  const observableRevisionsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-projects\/([0-9a-f-]+)\/revisions$/i
  );
  if (observableRevisionsMatch && request.method === "GET") {
    writeJson(response, 200, browserObservableSourceRevisions, requestId);
    return true;
  }
  if (observableRevisionsMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const paths = payload.files.map((file) => file.relative_path);
    if (payload.expected_revision !== 0
      || payload.entry_path !== "index.md"
      || payload.lockfile_path !== "package-lock.json"
      || paths.join(",") !== "index.md,package-lock.json"
      || payload.files.some((file) => !browserObservableSourceUploads.has(file.upload_id))) {
      writeJson(response, 409, {detail: {code: "observable_source_upload_invalid"}}, requestId);
      return true;
    }
    const revision = observableSourceRevisionPayload(payload);
    browserObservableSourceRevisions.unshift(revision);
    browserObservableSourceProjects = browserObservableSourceProjects.map((project) => (
      project.id === observableRevisionsMatch[2]
        ? {
          ...project,
          current_revision_id: IDS.sourceRevision,
          current_revision_number: 1,
          title: payload.title,
          rights_status: payload.rights_status,
          updated_at: "2026-08-22T18:05:00Z"
        }
        : project
    ));
    writeJson(response, 201, revision, requestId);
    return true;
  }
  const observableBuildMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-projects\/([0-9a-f-]+)\/revisions\/([0-9a-f-]+)\/build-jobs$/i
  );
  if (observableBuildMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    if (payload.purpose !== "preview" || observableBuildMatch[3] !== IDS.sourceRevision) {
      writeJson(response, 409, {detail: {code: "observable_source_revision_not_found"}}, requestId);
      return true;
    }
    const job = observableBuildPayload();
    browserObservableBuilds.unshift(job);
    writeJson(response, 201, job, requestId);
    return true;
  }

  const sitesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/sites$/i);
  if (sitesMatch && request.method === "GET") {
    writeJson(
      response,
      200,
      sitesMatch[1] === IDS.projects[0] ? browserSites : [],
      requestId
    );
    return true;
  }
  const siteReviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/sites\/([0-9a-f-]+)\/review$/i
  );
  if (siteReviewMatch && request.method === "POST") {
    const site = browserSites.find((candidate) =>
      candidate.project_id === siteReviewMatch[1] && candidate.id === siteReviewMatch[2]
    );
    if (!site) {
      writeJson(response, 404, {detail: "site_not_found"}, requestId);
      return true;
    }
    const payload = await readRequestJson(request);
    if (payload.expected_version !== site.version_number || site.state !== "draft") {
      writeJson(response, 409, {detail: {code: "site_version_conflict"}}, requestId);
      return true;
    }
    browserSites = browserSites.map((candidate) =>
      candidate.id === site.id ? {...candidate, state: "review"} : candidate
    );
    writeJson(response, 200, browserSites.find((candidate) => candidate.id === site.id), requestId);
    return true;
  }

  const recordsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/records\/collections\/resources\/items$/i
  );
  if (recordsMatch && request.method === "GET") {
    const language = url.searchParams.get("language") ?? "en";
    const features = browserResources
      .filter((resource) => resource.project_id === recordsMatch[1])
      .map((resource) => ogcRecordPayload(resource, language));
    writeJson(response, 200, {
      type: "FeatureCollection",
      timeStamp: "2026-08-20T12:00:00Z",
      numberMatched: features.length,
      numberReturned: features.length,
      features,
      links: [{href: url.pathname, rel: "self", type: "application/geo+json"}]
    }, requestId);
    return true;
  }

  const resourcesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/resources$/i);
  if (resourcesMatch && request.method === "GET") {
    const query = url.searchParams.get("query")?.toLowerCase() ?? "";
    const records = browserResources.filter((resource) =>
      resource.project_id === resourcesMatch[1]
      && (!query || `${resource.title} ${resource.abstract ?? ""} ${resource.keywords.join(" ")}`.toLowerCase().includes(query))
      && (!url.searchParams.get("kind") || resource.kind === url.searchParams.get("kind"))
      && (!url.searchParams.get("visibility") || resource.visibility === url.searchParams.get("visibility"))
      && (!url.searchParams.get("state") || resource.state === url.searchParams.get("state"))
    );
    writeJson(response, 200, records, requestId);
    return true;
  }

  const pageSourceUploadMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-source-uploads$/i
  );
  if (pageSourceUploadMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    browserPageUpload = {
      ...payload,
      projectId: pageSourceUploadMatch[1],
      resourceId: pageSourceUploadMatch[2],
      uploadId: IDS.upload
    };
    writeJson(response, 201, {
      upload_id: IDS.upload,
      resource_id: pageSourceUploadMatch[2],
      expected_resource_version: payload.expected_version,
      source_block_id: payload.source_block_id,
      expires_at: "2099-08-22T12:15:00Z",
      upload: pageSourceUploadInstructionsPayload()
    }, requestId);
    return true;
  }

  const pageDraftMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-draft$/i
  );
  if (pageDraftMatch && request.method === "GET") {
    writeJson(response, 200, browserPageDrafts.get(pageDraftMatch[2]) ?? null, requestId);
    return true;
  }
  if (pageDraftMatch && request.method === "PUT") {
    const payload = await readRequestJson(request);
    const summary = browserResources.find((candidate) =>
      candidate.project_id === pageDraftMatch[1] && candidate.id === pageDraftMatch[2]
    );
    const current = browserPageDrafts.get(pageDraftMatch[2]) ?? null;
    const fingerprint = JSON.stringify({
      visibility: payload.visibility,
      metadata: payload.metadata,
      content: payload.content,
      provenance: payload.provenance,
      source_block_id: payload.source_block_id,
      source_markdown: payload.source_markdown,
      change_summary: payload.change_summary
    });
    if (!summary || summary.version_number !== payload.expected_resource_version) {
      writeJson(response, 409, {
        detail: {
          code: "resource_version_conflict",
          current_version: summary?.version_number ?? null
        }
      }, requestId);
      return true;
    }
    if (current?.base_resource_version !== undefined
      && current.base_resource_version !== payload.expected_resource_version) {
      writeJson(response, 409, {
        detail: {
          code: "page_draft_base_conflict",
          current_version: summary.version_number,
          current_draft_revision: current.revision_number
        }
      }, requestId);
      return true;
    }
    if (current && browserPageDraftFingerprints.get(pageDraftMatch[2]) === fingerprint) {
      writeJson(response, 200, current, requestId);
      return true;
    }
    const currentRevision = current?.revision_number ?? 0;
    if (payload.expected_draft_revision !== currentRevision) {
      writeJson(response, 409, {
        detail: {
          code: "page_draft_revision_conflict",
          current_draft_revision: currentRevision
        }
      }, requestId);
      return true;
    }
    const saved = {
      id: current?.id ?? IDS.pageDraft,
      resource_id: pageDraftMatch[2],
      owner_user_id: IDS.user,
      base_resource_version: payload.expected_resource_version,
      revision_number: currentRevision + 1,
      visibility: payload.visibility,
      metadata: payload.metadata,
      content: payload.content,
      provenance: payload.provenance,
      source_block_id: payload.source_block_id,
      source_markdown: payload.source_markdown,
      change_summary: payload.change_summary,
      document_checksum_sha256: "f".repeat(64),
      created_at: current?.created_at ?? "2026-08-22T11:55:00Z",
      updated_at: `2026-08-22T12:${String(currentRevision + 1).padStart(2, "0")}:00Z`
    };
    browserPageDrafts.set(pageDraftMatch[2], saved);
    browserPageDraftFingerprints.set(pageDraftMatch[2], fingerprint);
    writeJson(response, 200, saved, requestId);
    return true;
  }
  if (pageDraftMatch && request.method === "DELETE") {
    const current = browserPageDrafts.get(pageDraftMatch[2]);
    const expectedVersion = Number(url.searchParams.get("expected_resource_version"));
    const expectedRevision = Number(url.searchParams.get("expected_draft_revision"));
    if (current && (
      current.base_resource_version !== expectedVersion
      || current.revision_number !== expectedRevision
    )) {
      writeJson(response, 409, {
        detail: {
          code: "page_draft_revision_conflict",
          current_draft_revision: current.revision_number
        }
      }, requestId);
      return true;
    }
    browserPageDrafts.delete(pageDraftMatch[2]);
    browserPageDraftFingerprints.delete(pageDraftMatch[2]);
    response.writeHead(204, {"X-Request-ID": requestId});
    response.end();
    return true;
  }

  const pageVersionsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-versions$/i
  );
  if (pageVersionsMatch && request.method === "GET") {
    writeJson(
      response,
      200,
      browserPageSources
        .filter((source) => source.resource_id === pageVersionsMatch[2])
        .map((source) => ({...source, source_markdown: null})),
      requestId
    );
    return true;
  }
  if (pageVersionsMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const block = payload.content?.blocks?.find(
      (candidate) => candidate.id === browserPageUpload?.source_block_id
        && candidate.type === "markdown"
    );
    if (
      !browserPageUpload
      || payload.upload_id !== browserPageUpload.uploadId
      || payload.expected_version !== browserPageUpload.expected_version
      || !block
      || !payload.change_message
    ) {
      writeJson(response, 409, {detail: {code: "page_source_upload_mismatch"}}, requestId);
      return true;
    }
    const summary = browserResources.find((candidate) => candidate.id === pageVersionsMatch[2]);
    summary.version_number += 1;
    summary.updated_at = "2026-08-22T12:00:00Z";
    const source = pageSourcePayload({
      resource_id: pageVersionsMatch[2],
      resource_version_number: summary.version_number,
      parent_version_number: summary.version_number - 1,
      source_block_id: block.id,
      size_bytes: new TextEncoder().encode(block.markdown).length,
      checksum_sha256: browserPageUpload.checksum_sha256,
      change_summary: payload.change_message,
      source_markdown: block.markdown
    });
    browserPageSources.unshift(source);
    if (browserPageDrafts.get(pageVersionsMatch[2])?.base_resource_version === payload.expected_version) {
      browserPageDrafts.delete(pageVersionsMatch[2]);
      browserPageDraftFingerprints.delete(pageVersionsMatch[2]);
    }
    browserPageDetailOverrides = {
      content: payload.content,
      change_message: payload.change_message,
      version_created_at: source.created_at
    };
    writeJson(response, 201, {
      resource: {...resourceDetailPayload(summary), ...browserPageDetailOverrides},
      source: {...source, source_markdown: null}
    }, requestId);
    return true;
  }

  const pagePreviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-versions\/(\d+)\/preview$/i
  );
  if (pagePreviewMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const summary = browserResources.find((candidate) => candidate.id === pagePreviewMatch[2]);
    const dependencies = [];
    let invalid = !summary || summary.version_number !== Number(pagePreviewMatch[3]);
    for (const block of payload.content?.blocks ?? []) {
      if (!["map", "dataset"].includes(block.type)) continue;
      const target = browserResources.find((candidate) => candidate.id === block.resource_id);
      if (!target || target.kind !== block.type
        || target.version_number !== block.resource_version_number) {
        invalid = true;
        continue;
      }
      dependencies.push({
        block_id: block.id,
        kind: block.type,
        resource_id: target.id,
        resource_version_number: target.version_number,
        dataset_id: null,
        dataset_version_id: null,
        object_id: null,
        checksum_sha256: null
      });
    }
    if (invalid) {
      writeJson(response, 409, {detail: {code: "page_dependency_version_conflict"}}, requestId);
      return true;
    }
    const markdown = payload.content?.blocks
      ?.filter((block) => block.type === "markdown")
      .map((block) => block.markdown)
      .join("\n\n") ?? "";
    const referenceTitles = dependencies.map((dependency) =>
      browserResources.find((candidate) => candidate.id === dependency.resource_id)?.title
    ).filter(Boolean);
    const escaped = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    const citations = (payload.content?.blocks ?? []).filter((block) => block.type === "citation");
    const tables = (payload.content?.blocks ?? []).filter((block) => block.type === "table");
    const charts = (payload.content?.blocks ?? []).filter((block) => block.type === "chart");
    const headings = (payload.content?.blocks ?? []).filter((block) => block.type === "heading");
    const callouts = (payload.content?.blocks ?? []).filter((block) => block.type === "callout");
    const navigations = (payload.content?.blocks ?? []).filter(
      (block) => block.type === "navigation"
    );
    const headingById = new Map(headings.map((block) => [block.id, block]));
    const structured = [
      ...citations.map((block) => `<cite>${escaped(block.title)}</cite>`),
      ...tables.map((block) => `<table><caption>${escaped(block.caption)}</caption></table>`),
      ...charts.map((block) => `<figure aria-label="${escaped(block.alt_text)}"><figcaption>${escaped(block.title)}</figcaption></figure>`),
      ...headings.map((block) => `<h${block.level} id="block-${escaped(block.id)}">${escaped(block.text)}</h${block.level}>`),
      ...callouts.map((block) => `<aside aria-label="${escaped(block.title)}"><strong>${escaped(block.title)}</strong><p>${escaped(block.markdown)}</p></aside>`),
      ...navigations.map((block) => `<nav aria-label="${escaped(block.label)}"><strong>${escaped(block.label)}</strong>${block.heading_block_ids.map((target) => `<a href="#block-${escaped(target)}">${escaped(headingById.get(target)?.text ?? target)}</a>`).join("")}</nav>`)
    ].join("");
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><meta name="generator" content="opengeo-page-renderer-1.1.0"></head><body data-renderer-version="opengeo-page-renderer-1.1.0"><main><h1>${escaped(payload.title)}</h1><p>${escaped(markdown)}</p>${referenceTitles.map((title) => `<aside>${escaped(title)}</aside>`).join("")}${structured}</main></body></html>`;
    writeJson(response, 200, {
      renderer_version: "opengeo-page-renderer-1.1.0",
      content_checksum_sha256: "e".repeat(64),
      html,
      dependencies
    }, requestId);
    return true;
  }

  const currentPageSourceMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-source$/i
  );
  const historicalPageSourceMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/page-versions\/(\d+)\/source$/i
  );
  if ((currentPageSourceMatch || historicalPageSourceMatch) && request.method === "GET") {
    const match = historicalPageSourceMatch || currentPageSourceMatch;
    const version = historicalPageSourceMatch ? Number(historicalPageSourceMatch[3]) : null;
    const source = browserPageSources.find((candidate) =>
      candidate.resource_id === match[2]
      && (version === null || candidate.resource_version_number === version)
    );
    writeJson(
      response,
      source ? 200 : 404,
      source ?? {detail: "page_source_not_found"},
      requestId
    );
    return true;
  }

  const resourceDetailMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)$/i
  );
  if (resourceDetailMatch && request.method === "GET") {
    const resource = browserResources.find((candidate) =>
      candidate.project_id === resourceDetailMatch[1] && candidate.id === resourceDetailMatch[2]
    );
    writeJson(
      response,
      resource ? 200 : 404,
      resource ? {...resourceDetailPayload(resource), ...browserPageDetailOverrides} : {detail: "resource_not_found"},
      requestId
    );
    return true;
  }

  const resourceCapabilitiesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/capabilities$/i
  );
  if (resourceCapabilitiesMatch && request.method === "GET") {
    writeJson(response, 200, {
      can_read: true,
      can_update: true,
      can_publish: true,
      can_manage_permissions: true
    }, requestId);
    return true;
  }

  const resourceRatingMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/rating$/i
  );
  if (resourceRatingMatch && request.method === "GET") {
    writeJson(response, 200, {
      project_id: resourceRatingMatch[1],
      resource_id: resourceRatingMatch[2],
      rating_count: 0,
      rating_average: null,
      caller_score: null,
      caller_version: null,
      caller_withdrawn: false,
      updated_at: null
    }, requestId);
    return true;
  }

  const resourceStylesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/styles$/i
  );
  if (resourceStylesMatch && request.method === "GET") {
    writeJson(response, 200, [], requestId);
    return true;
  }

  const renderProfilesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/render-profiles$/i
  );
  if (renderProfilesMatch && request.method === "GET") {
    writeJson(response, 200, [], requestId);
    return true;
  }

  const resourceWorkflowMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/workflow$/i
  );
  if (resourceWorkflowMatch && request.method === "GET") {
    writeJson(response, 200, [], requestId);
    return true;
  }

  const resourcePermissionsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/permissions$/i
  );
  if (resourcePermissionsMatch && request.method === "GET") {
    writeJson(response, 200, [], requestId);
    return true;
  }

  const importsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/imports$/i);
  if (importsMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const existing = [...browserImports.values()].find((record) =>
      record.project_id === importsMatch[1] && record.idempotency_key === payload.idempotency_key
    );
    if (existing) {
      writeJson(response, 201, existing, requestId);
      return true;
    }
    const externalItems = payload.external_sources.map((candidate, index) => {
      const datasetId = IDS.importSourceDatasets[index];
      const configuration = configurationForSourceDefinition(candidate.source);
      const source = externalSourcePayload({
        dataset_id: datasetId,
        project_id: importsMatch[1],
        name: candidate.name,
        description: candidate.description,
        classification: candidate.classification,
        source_type: candidate.source.type,
        source_url: candidate.source.url,
        configuration
      });
      browserSources.push(source);
      browserDatasets.push(datasetPayload({
        id: datasetId,
        project_id: importsMatch[1],
        name: source.name,
        description: source.description,
        classification: source.classification,
        source_type: source.source_type,
        format: source.source_type,
        feature_count: null,
        extent: null,
        crs: source.configuration.crs ?? "EPSG:3857",
        geometry_type: source.configuration.geometry_type ?? "Raster",
        tags: [source.source_type, "external-source"]
      }));
      projectDatasetIds(importsMatch[1]).add(datasetId);
      return importItemPayload({
        import_ref: candidate.import_ref,
        kind: "external_source",
        expected_source_type: candidate.source.type,
        expected_format: candidate.source.type,
        candidate: {name: candidate.name, sourceUrl: candidate.source.url},
        state: "bound",
        dataset_id: datasetId,
        bound_at: "2026-08-19T13:00:00Z"
      });
    });
    const embeddedItems = payload.embedded_datasets.map((candidate) => importItemPayload({
      import_ref: candidate.import_ref,
      candidate: {
        filename: candidate.filename,
        checksumSha256: candidate.checksum_sha256
      }
    }));
    const operation = projectImportPayload({
      project_id: importsMatch[1],
      map_id: payload.map_id,
      idempotency_key: payload.idempotency_key,
      source_sha256: payload.source_sha256,
      plan_digest: payload.plan_digest,
      expected_map_version: payload.expected_map_version,
      items: [...externalItems, ...embeddedItems],
      unresolved_import_refs: embeddedItems.map((item) => item.import_ref),
      request: payload
    });
    browserImports.set(operation.import_id, operation);
    writeJson(response, 201, operation, requestId);
    return true;
  }

  const importItemMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/imports\/([0-9a-f-]+)\/items\/(.+)\/dataset$/i);
  if (importItemMatch && request.method === "PUT") {
    const operation = browserImports.get(importItemMatch[2]);
    const importRef = decodeURIComponent(importItemMatch[3]);
    const payload = await readRequestJson(request);
    const item = operation?.items.find((candidate) => candidate.import_ref === importRef);
    if (!operation || operation.project_id !== importItemMatch[1] || !item) {
      writeJson(response, 404, {detail: "project_import_item_not_found"}, requestId);
      return true;
    }
    Object.assign(item, {
      state: "bound",
      dataset_id: payload.dataset_id,
      bound_at: "2026-08-19T13:02:00Z"
    });
    operation.unresolved_import_refs = operation.items
      .filter((candidate) => candidate.state !== "bound")
      .map((candidate) => candidate.import_ref);
    operation.ready = operation.unresolved_import_refs.length === 0;
    operation.updated_at = "2026-08-19T13:02:00Z";
    writeJson(response, 200, operation, requestId);
    return true;
  }

  const finalizeImportMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/imports\/([0-9a-f-]+)\/finalize$/i);
  if (finalizeImportMatch && request.method === "POST") {
    const operation = browserImports.get(finalizeImportMatch[2]);
    if (!operation || operation.project_id !== finalizeImportMatch[1]) {
      writeJson(response, 404, {detail: "project_import_not_found"}, requestId);
      return true;
    }
    if (!operation.ready) {
      writeJson(response, 409, {detail: {code: "project_import_incomplete"}}, requestId);
      return true;
    }
    importedMapDefinition = finalizeBrowserImportDefinition(operation);
    importedMapVersion = operation.expected_map_version + 1;
    browserMapOverrides.delete(`${operation.project_id}:${operation.map_id}`);
    Object.assign(operation, {
      state: "completed",
      ready: false,
      completed_at: "2026-08-19T13:03:00Z",
      updated_at: "2026-08-19T13:03:00Z",
      final_map_version: importedMapVersion
    });
    writeJson(response, 200, operation, requestId);
    return true;
  }

  const importMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/imports\/([0-9a-f-]+)$/i);
  if (importMatch && request.method === "GET") {
    const operation = browserImports.get(importMatch[2]);
    writeJson(
      response,
      operation && operation.project_id === importMatch[1] ? 200 : 404,
      operation && operation.project_id === importMatch[1]
        ? operation
        : {detail: "project_import_not_found"},
      requestId
    );
    return true;
  }

  const sourceCopyEstimateMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/source\/revisions\/(\d+)\/copy-estimates$/i
  );
  if (sourceCopyEstimateMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const record = {
      projectId: sourceCopyEstimateMatch[1],
      sourceDatasetId: sourceCopyEstimateMatch[2],
      sourceRevisionNumber: Number(sourceCopyEstimateMatch[3]),
      payload
    };
    browserProtectedCopyEstimateRequests.push(record);
    writeJson(response, 201, externalSourceCopyEstimatePayload(record), requestId);
    return true;
  }

  const sourceDiscoveryCollectionMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-discoveries\/([0-9a-f-]+)$/i
  );
  if (sourceDiscoveryCollectionMatch && request.method === "GET") {
    const record = browserSourceDiscoveryRequests.find(({job}) => (
      job.project_id === sourceDiscoveryCollectionMatch[1]
      && job.job_id === sourceDiscoveryCollectionMatch[2]
    ));
    writeJson(
      response,
      record ? 200 : 404,
      record?.job ?? {detail: "source_discovery_not_found"},
      requestId
    );
    return true;
  }

  const sourceDiscoveriesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/source-discoveries$/i
  );
  if (sourceDiscoveriesMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const job = sourceDiscoveryJobPayload(sourceDiscoveriesMatch[1], payload);
    browserSourceDiscoveryRequests.push({payload, job});
    writeJson(response, 202, job, requestId);
    return true;
  }

  const protectedCopyMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/source\/revisions\/(\d+)\/protected-copies$/i
  );
  if (protectedCopyMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const record = {
      projectId: protectedCopyMatch[1],
      sourceDatasetId: protectedCopyMatch[2],
      sourceRevisionNumber: Number(protectedCopyMatch[3]),
      payload
    };
    browserProtectedCopyQueueRequests.push(record);
    writeJson(response, 202, protectedCopyJobPayload(record), requestId);
    return true;
  }

  const sourcesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/sources$/i);
  if (sourcesMatch) {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      const configuration = configurationForSourceDefinition(payload.source);
      const source = externalSourcePayload({
        dataset_id: payload.source.presentation_role === "regional_basemap"
          ? IDS.regionalSourceDataset
          : IDS.sourceDataset,
        project_id: sourcesMatch[1],
        name: payload.name,
        description: payload.description,
        classification: payload.classification,
        source_type: payload.source.type,
        source_url: payload.source.url,
        configuration
      });
      browserSources.unshift(source);
      if (!browserDatasets.some(({id}) => id === source.dataset_id)) {
        browserDatasets.push(datasetPayload({
          id: source.dataset_id,
          project_id: sourcesMatch[1],
          name: source.name,
          description: source.description,
          classification: source.classification,
          source_type: source.source_type,
          format: source.source_type,
          feature_count: null,
          extent: null,
          crs: source.configuration.crs ?? "EPSG:3857",
          geometry_type: source.configuration.geometry_type ?? "Raster",
          tags: [source.source_type, "external-source"]
        }));
      }
      projectDatasetIds(sourcesMatch[1]).add(source.dataset_id);
      writeJson(response, 201, source, requestId);
    } else {
      const linkedIds = projectDatasetIds(sourcesMatch[1]);
      writeJson(response, 200, browserSources
        .filter((source) => linkedIds.has(source.dataset_id))
        .map((source) => ({...source, project_id: sourcesMatch[1]})), requestId);
    }
    return true;
  }

  const versionsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/versions$/i);
  if (versionsMatch) {
    const dataset = browserDatasets.find((candidate) =>
      candidate.project_id === versionsMatch[1] && candidate.id === versionsMatch[2]
    );
    writeJson(response, dataset ? 200 : 404, dataset ? [datasetVersionPayload(dataset)] : {detail: "dataset_not_found"}, requestId);
    return true;
  }

  const fieldSubmissionCreateMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/field-forms\/([0-9a-f-]+)\/versions\/(\d+)\/submissions$/i
  );
  if (fieldSubmissionCreateMatch && request.method === "POST") {
    const [projectId, datasetId, formId, formVersionText] = fieldSubmissionCreateMatch.slice(1);
    const form = browserFieldForms.find(({id}) => id === formId);
    const payload = await readRequestJson(request);
    const existing = browserFieldSubmissions.find(({id}) => id === payload.client_submission_id);
    if (projectId !== IDS.projects[0]
      || datasetId !== IDS.dataset
      || !form
      || form.version !== Number(formVersionText)
      || !validBrowserFieldSubmissionDraft(payload, form)) {
      writeJson(response, 400, {detail: {code: "field_submission_invalid"}}, requestId);
      return true;
    }
    if (existing) {
      writeJson(response, 200, {created: false, submission: existing}, requestId);
      return true;
    }
    const submission = browserFieldSubmissionPayload({
      id: payload.client_submission_id,
      form,
      feature: payload.feature,
      supersedesSubmissionId: payload.supersedes_submission_id,
      operation: payload.operation,
      targetFeatureId: payload.target_feature_id,
      targetFeatureVersion: payload.target_feature_version
    });
    browserFieldSubmissions.push(submission);
    writeJson(response, 201, {created: true, submission}, requestId);
    return true;
  }

  const fieldFormsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/field-forms$/i
  );
  if (fieldFormsMatch) {
    const [projectId, datasetId] = fieldFormsMatch.slice(1);
    if (projectId !== IDS.projects[0] || datasetId !== IDS.dataset) {
      writeJson(response, 404, {detail: "dataset_not_found"}, requestId);
      return true;
    }
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      if (typeof payload.title !== "string"
        || payload.title.length < 1
        || payload.title.length > 200
        || !(payload.instructions === null
          || (typeof payload.instructions === "string" && payload.instructions.length <= 4_000))) {
        writeJson(response, 400, {detail: {code: "field_form_invalid"}}, requestId);
        return true;
      }
      const form = browserFieldFormPayload(payload);
      browserFieldForms = [form];
      writeJson(response, 201, form, requestId);
    } else if (request.method === "GET") {
      writeJson(response, 200, {
        forms: browserFieldForms,
        number_returned: browserFieldForms.length
      }, requestId);
    } else {
      writeJson(response, 405, {detail: "method_not_allowed"}, requestId);
    }
    return true;
  }

  const fieldSubmissionReviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/field-submissions\/([0-9a-f-]+)\/review$/i
  );
  if (fieldSubmissionReviewMatch && request.method === "POST") {
    const [projectId, datasetId, submissionId] = fieldSubmissionReviewMatch.slice(1);
    const submission = browserFieldSubmissions.find(({id}) => id === submissionId);
    const payload = await readRequestJson(request);
    const expectedTransition = payload.decision === "start_review"
      ? submission?.state === "submitted"
      : payload.decision === "accept"
        ? submission?.state === "in_review"
        : false;
    if (projectId !== IDS.projects[0]
      || datasetId !== IDS.dataset
      || !submission
      || payload.expected_version !== submission.review_version
      || !expectedTransition
      || !(payload.message === null
        || (typeof payload.message === "string" && payload.message.length <= 2_000))) {
      writeJson(response, 409, {detail: {code: "field_submission_review_conflict"}}, requestId);
      return true;
    }
    submission.state = payload.decision === "start_review" ? "in_review" : "accepted";
    submission.review_version += 1;
    submission.reviewed_by = IDS.user;
    submission.reviewed_at = "2026-08-30T15:04:00Z";
    submission.review_message = payload.message;
    let promotedFeature = null;
    if (payload.decision === "accept") {
      promotedFeature = addBrowserAuthoritativeFeature(submission.feature, {
        id: submission.id,
        createdAt: submission.submitted_at
      });
      submission.promoted_feature_id = promotedFeature.id;
    }
    writeJson(response, 200, {
      submission,
      promoted_feature: promotedFeature
    }, requestId);
    return true;
  }

  const fieldSubmissionsMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/field-submissions$/i
  );
  if (fieldSubmissionsMatch && request.method === "GET") {
    const [projectId, datasetId] = fieldSubmissionsMatch.slice(1);
    if (projectId !== IDS.projects[0] || datasetId !== IDS.dataset) {
      writeJson(response, 404, {detail: "dataset_not_found"}, requestId);
      return true;
    }
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const state = url.searchParams.get("state");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000
      || (state !== null && !["submitted", "in_review", "changes_requested", "rejected", "accepted"].includes(state))) {
      writeJson(response, 400, {detail: {code: "field_submission_page_invalid"}}, requestId);
      return true;
    }
    const matching = state === null
      ? browserFieldSubmissions
      : browserFieldSubmissions.filter((submission) => submission.state === state);
    const submissions = matching.slice(offset, offset + limit);
    writeJson(response, 200, {
      submissions,
      number_returned: submissions.length,
      limit,
      offset
    }, requestId);
    return true;
  }

  const featureQueryMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/feature-query$/i
  );
  if (featureQueryMatch && request.method === "POST") {
    const linked = projectDatasetIds(featureQueryMatch[1]).has(featureQueryMatch[2]);
    const acceptedDataset = [IDS.dataset, IDS.geomooseQueryDataset].includes(featureQueryMatch[2]);
    if (!linked || !acceptedDataset || (!geomooseQueryMode && featureQueryMatch[2] !== IDS.dataset)) {
      writeJson(response, 404, {detail: "feature_collection_not_found"}, requestId);
      return true;
    }
    const payload = await readRequestJson(request);
    let query;
    try {
      query = normalizeFeatureQuery(payload);
    } catch {
      writeJson(response, 400, {detail: {code: "feature_query_invalid"}}, requestId);
      return true;
    }
    const generation = geomooseQueryMode ? 7 : browserAuthoritativeFeatureState?.generation ?? 1;
    if (query.expected_generation !== null && query.expected_generation !== generation) {
      writeJson(response, 409, {
        detail: {code: "feature_collection_generation_conflict", current_generation: generation}
      }, requestId);
      return true;
    }
    if (!geomooseQueryMode) {
      writeJson(
        response,
        200,
        await browserAuthoritativeFeatureQueryPage(query),
        requestId
      );
      return true;
    }
    browserGeoMooseQueryRequests.push({
      projectId: featureQueryMatch[1],
      datasetId: featureQueryMatch[2],
      query: structuredClone(query)
    });
    const delayedIdentify = browserGeoMooseDelayedQueryResponses > 0
      && query.limit === GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer
      && query.steps.length === 1
      && query.steps[0].kind === "spatial"
      && query.steps[0].geometry.type === "Point";
    if (delayedIdentify) {
      browserGeoMooseDelayedQueryResponses -= 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      if (response.destroyed) return true;
    }
    writeJson(
      response,
      200,
      await browserGeoMooseFeaturePage(featureQueryMatch[2], {query}),
      requestId
    );
    return true;
  }

  const featureLocksMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/feature-locks$/i
  );
  if (featureLocksMatch && request.method === "GET") {
    const linked = projectDatasetIds(featureLocksMatch[1]).has(featureLocksMatch[2]);
    writeJson(response, linked ? 200 : 404, linked
      ? {locks: [], number_returned: 0, limit: 100}
      : {detail: {code: "feature_collection_not_found"}}, requestId);
    return true;
  }

  const featureTombstonesMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/feature-tombstones$/i
  );
  if (featureTombstonesMatch && request.method === "GET") {
    const linked = projectDatasetIds(featureTombstonesMatch[1]).has(featureTombstonesMatch[2]);
    writeJson(response, linked ? 200 : 404, linked
      ? {
          tombstones: [],
          number_matched: 0,
          number_returned: 0,
          limit: 100,
          offset: 0
        }
      : {detail: {code: "feature_collection_not_found"}}, requestId);
    return true;
  }

  const featuresMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/features$/i
  );
  if (featuresMatch) {
    const linked = projectDatasetIds(featuresMatch[1]).has(featuresMatch[2]);
    const geomooseDataset = geomooseQueryMode
      && [IDS.dataset, IDS.geomooseQueryDataset].includes(featuresMatch[2]);
    if (!linked || (featuresMatch[2] !== IDS.dataset && !geomooseDataset)) {
      writeJson(response, 404, {detail: "feature_collection_not_found"}, requestId);
      return true;
    }
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      if (featuresMatch[1] !== IDS.projects[0]
        || featuresMatch[2] !== IDS.dataset
        || !validBrowserFeatureDraft(payload)) {
        writeJson(response, 400, {detail: {code: "feature_invalid"}}, requestId);
        return true;
      }
      const feature = addBrowserAuthoritativeFeature(payload, {
        id: "88000000-0000-4000-8000-000000000011"
      });
      writeJson(response, 201, feature, requestId);
      return true;
    }
    if (request.method !== "GET") {
      writeJson(response, 405, {detail: "method_not_allowed"}, requestId);
      return true;
    }
    writeJson(response, 200, geomooseDataset
      ? await browserGeoMooseFeaturePage(featuresMatch[2])
      : browserAuthoritativeFeatureState
        ? browserAuthoritativeFeaturePage()
        : browserFeaturePage(), requestId);
    return true;
  }

  const featureMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/features\/([0-9a-f-]+)$/i
  );
  if (featureMatch && request.method === "PUT") {
    const [projectId, datasetId, featureId] = featureMatch.slice(1);
    const payload = await readRequestJson(request);
    const current = browserAuthoritativeFeatureState?.features.find(({id}) => id === featureId);
    if (projectId !== IDS.projects[0]
      || datasetId !== IDS.dataset
      || !current
      || payload.expected_version !== current["opengeo:version"]
      || !validBrowserFeatureDraft({
        type: "Feature",
        geometry: payload.geometry,
        properties: payload.properties
      })) {
      writeJson(response, 409, {detail: {code: "feature_version_conflict"}}, requestId);
      return true;
    }
    browserAuthoritativeFeatureState.generation += 1;
    const updated = browserGovernedFeaturePayload({
      id: featureId,
      geometry: payload.geometry,
      properties: payload.properties,
      version: current["opengeo:version"] + 1,
      generation: browserAuthoritativeFeatureState.generation,
      createdAt: current["opengeo:createdAt"]
    });
    browserAuthoritativeFeatureState.features = browserAuthoritativeFeatureState.features.map(
      (feature) => feature.id === featureId ? updated : feature
    );
    writeJson(response, 200, updated, requestId);
    return true;
  }

  const spatialPreviewMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/spatial-preview$/i
  );
  if (spatialPreviewMatch) {
    if (request.method !== "GET") {
      writeJson(response, 405, {detail: "method_not_allowed"}, requestId);
      return true;
    }
    const [projectId, datasetId, versionId] = spatialPreviewMatch.slice(1);
    const dataset = browserDatasets.find(({id}) => id === datasetId);
    const preview = dataset?.source_type === "upload" && dataset.status === "active"
      && projectDatasetIds(projectId).has(datasetId)
      ? await browserSpatialPreviewPayload(datasetId, versionId)
      : null;
    writeJson(response, preview ? 200 : 404,
      preview ?? {detail: "spatial_preview_not_found"}, requestId);
    return true;
  }

  const documentPreviewMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/document-preview$/i);
  if (documentPreviewMatch) {
    const odt = documentPreviewMatch[1] === IDS.projects[0]
      && documentPreviewMatch[2] === IDS.odtDataset
      && documentPreviewMatch[3] === IDS.odtVersion;
    const pdf = documentPreviewMatch[1] === IDS.projects[0]
      && documentPreviewMatch[2] === IDS.pdfDataset
      && documentPreviewMatch[3] === IDS.pdfVersion;
    writeJson(response, odt || pdf ? 200 : 404, odt
      ? documentPreviewPayload()
      : pdf
        ? pdfDocumentPreviewPayload()
        : {
      detail: "document_preview_not_found"
    }, requestId);
    return true;
  }

  const permissionsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/permissions$/i);
  if (permissionsMatch) {
    writeJson(response, 200, [datasetPermissionPayload()], requestId);
    return true;
  }

  const permissionMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/permissions\/([0-9a-f-]+)$/i);
  if (permissionMatch) {
    if (request.method === "DELETE") {
      response.writeHead(204, {"X-Request-ID": requestId});
      response.end();
    } else {
      const payload = await readRequestJson(request);
      writeJson(response, 200, datasetPermissionPayload({user_id: permissionMatch[3], role: payload.role}), requestId);
    }
    return true;
  }

  const downloadMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/objects\/([0-9a-f-]+)\/download$/i);
  if (downloadMatch && request.method === "POST") {
    writeJson(response, 200, browserDownloadTicket(), requestId);
    return true;
  }

  const datasetMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)$/i);
  if (datasetMatch) {
    const [projectId, datasetId] = datasetMatch.slice(1);
    const dataset = browserDatasets.find((candidate) => candidate.id === datasetId);
    if (request.method === "PUT") {
      if (!dataset) {
        writeJson(response, 404, {detail: "dataset_not_found"}, requestId);
      } else {
        projectDatasetIds(projectId).add(datasetId);
        writeJson(response, 200, {...dataset, project_id: projectId}, requestId);
      }
    } else if (request.method === "DELETE") {
      const used = mapPayloadsForProject(projectId).some((map) =>
        map.definition?.layers?.some((layer) => layer.datasetId === datasetId)
      );
      if (used) {
        writeJson(response, 409, {detail: {code: "project_dataset_in_use"}}, requestId);
      } else {
        projectDatasetIds(projectId).delete(datasetId);
        response.writeHead(204, {"X-Request-ID": requestId});
        response.end();
      }
    } else {
      const linked = dataset && projectDatasetIds(projectId).has(datasetId);
      writeJson(
        response,
        linked ? 200 : 404,
        linked ? {...dataset, project_id: projectId} : {detail: "dataset_not_found"},
        requestId
      );
    }
    return true;
  }

  const requestUploadMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/uploads\/request$/i);
  if (requestUploadMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const projectImportTag = payload.tags.find((tag) => tag.startsWith("import-"));
    const importOperation = projectImportTag
      ? browserImports.get(projectImportTag.slice("import-".length))
      : null;
    const uploadId = importOperation ? IDS.importUpload : IDS.upload;
    const datasetId = importOperation ? IDS.importEmbeddedDataset : IDS.uploadedDataset;
    const dataset = datasetPayload({
      id: datasetId,
      project_id: requestUploadMatch[1],
      name: payload.name,
      description: payload.description,
      classification: payload.classification,
      format: payload.format,
      status: "draft",
      current_version_id: null,
      current_version_number: null,
      current_version_state: null,
      feature_count: null,
      extent: null,
      crs: null,
      geometry_type: null,
      quality_results: {},
      processing_job_state: null,
      processing_error_code: null,
      tags: payload.tags
    });
    browserDatasets.push(dataset);
    projectDatasetIds(requestUploadMatch[1]).add(dataset.id);
    browserUploads.set(uploadId, dataset);
    writeJson(response, 201, {
      upload_id: uploadId,
      dataset,
      expires_at: "2099-08-19T12:15:00Z",
      upload: browserUploadInstructions()
    }, requestId);
    return true;
  }

  const completeUploadMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/uploads\/([0-9a-f-]+)\/complete$/i);
  if (completeUploadMatch && request.method === "POST") {
    const dataset = browserUploads.get(completeUploadMatch[2]);
    if (!dataset || dataset.project_id !== completeUploadMatch[1]) {
      writeJson(response, 404, {detail: "upload_not_found"}, requestId);
      return true;
    }
    Object.assign(dataset, {
      status: "processing",
      current_version_id: dataset.id === IDS.importEmbeddedDataset ? IDS.importVersion : IDS.version,
      current_version_number: 1,
      current_version_state: "queued",
      processing_job_state: "queued",
      updated_at: "2026-08-19T13:00:00Z"
    });
    writeJson(response, 200, {
      dataset,
      dataset_version_id: dataset.current_version_id,
      version_number: 1,
      processing_job_id: dataset.id === IDS.importEmbeddedDataset ? IDS.importJob : IDS.job,
      processing_job_state: "queued"
    }, requestId);
    return true;
  }

  const projectMembershipsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/memberships$/i);
  if (projectMembershipsMatch) {
    if (request.method === "POST") {
      const payload = await readRequestJson(request);
      writeJson(response, 201, {user_id: payload.user_id, role: payload.role}, requestId);
    } else {
      writeJson(response, 200, projectMemberPayloads(projectMembershipsMatch[1]), requestId);
    }
    return true;
  }

  const projectMembershipMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/memberships\/([0-9a-f-]+)$/i);
  if (projectMembershipMatch) {
    if (request.method === "DELETE") {
      response.writeHead(204, {"X-Request-ID": requestId});
      response.end();
    } else {
      const payload = await readRequestJson(request);
      writeJson(response, 200, {user_id: projectMembershipMatch[2], role: payload.role}, requestId);
    }
    return true;
  }

  const kmlNetworkLinkRefreshMatch = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]+)\/kml-network-links\/refresh$/i
  );
  if (kmlNetworkLinkRefreshMatch && request.method === "POST") {
    const payload = await readRequestJson(request);
    const requestUrl = payload?.request_url;
    if (kmlNetworkLinkRefreshMatch[1] !== IDS.createdProject
      || payload?.schema_version !== "1.0.0"
      || payload?.link_id !== "browser-network-link"
      || payload?.security_contract !== "public-https-dns-pinned-no-redirect-no-credentials-v1"
      || payload?.transport?.credentials !== "omit"
      || payload?.transport?.redirect !== "error"
      || typeof requestUrl !== "string"
      || !requestUrl.startsWith("https://data.opengeo.tools/places/browser.kml?collection=stations")) {
      writeJson(response, 400, {detail: "kml_network_link_request_invalid"}, requestId);
      return true;
    }
    const requestedAt = Date.parse(payload.requested_at);
    const bodyText = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document id="linked-browser-document"><name>Linked browser sites</name><Placemark id="linked-station"><name>Linked station</name><description>Governed NetworkLink response</description><Point><coordinates>13.39,52.51,35</coordinates></Point></Placemark></Document></kml>`;
    const etag = '"browser-network-link-v1"';
    const notModified = payload?.conditional?.etag === etag;
    writeJson(response, 200, {
      request_url: requestUrl,
      final_url: requestUrl,
      status: notModified ? 304 : 200,
      redirects: 0,
      dns_pinned: true,
      all_addresses_public: true,
      tls_verified: true,
      credentials_sent: false,
      media_type: "application/vnd.google-earth.kml+xml",
      byte_length: notModified ? 0 : new TextEncoder().encode(bodyText).byteLength,
      fetched_at: new Date(requestedAt + 1_000).toISOString(),
      expires_at: new Date(requestedAt + 301_000).toISOString(),
      etag,
      last_modified: "Sun, 24 Aug 2026 12:05:00 GMT",
      ...(notModified ? {} : {body_text: bodyText})
    }, requestId);
    return true;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
  if (projectMatch) {
    const project = allProjectPayloads().find((candidate) => candidate.id === projectMatch[1]);
    writeJson(response, project ? 200 : 404, project ?? {detail: "project_not_found"}, requestId);
    return true;
  }

  const mapsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/maps$/i);
  if (mapsMatch) {
    if (request.method === "POST") {
      const project = allProjectPayloads().find((candidate) => candidate.id === mapsMatch[1]);
      if (!project) {
        writeJson(response, 404, {detail: "project_not_found"}, requestId);
        return true;
      }
      const payload = await readRequestJson(request);
      const id = mapsMatch[1] === IDS.createdProject && !browserCreatedMaps.some((map) => map.project_id === mapsMatch[1])
        ? IDS.createdMap
        : IDS.savedMap;
      const map = apiRecord({
        id,
        project_id: mapsMatch[1],
        name: payload.name,
        description: payload.description,
        definition: payload.definition,
        version: 1
      });
      browserCreatedMaps.push(map);
      lastMapCreate = payload;
      writeJson(response, 201, map, requestId);
    } else {
      const project = allProjectPayloads().find((candidate) => candidate.id === mapsMatch[1]);
      writeJson(response, project ? 200 : 404, project ? mapPayloadsForProject(mapsMatch[1]) : {detail: "project_not_found"}, requestId);
    }
    return true;
  }

  const mapMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/maps\/([0-9a-f-]+)$/i);
  if (mapMatch) {
    const map = mapPayloadsForProject(mapMatch[1]).find((candidate) => candidate.id === mapMatch[2]);
    if (!map) {
      writeJson(response, 404, {detail: "map_not_found"}, requestId);
      return true;
    }
    if (request.method === "PATCH") {
      lastMapUpdate = await readRequestJson(request);
      if (token === "conflict.test.token") {
        writeJson(response, 409, {detail: {code: "map_version_conflict", current_version: 7}}, requestId);
      } else {
        const definition = lastMapUpdate.definition;
        const invalidLayer = definition?.layers?.find(
          ({datasetId}) => datasetId && datasetId !== "kml-places"
            && !projectDatasetIds(mapMatch[1]).has(datasetId)
        );
        if (invalidLayer) {
          writeJson(response, 409, {detail: {code: "map_dataset_not_linked"}}, requestId);
          return true;
        }
        const updated = {
          ...map,
          ...(definition ? {definition} : {}),
          version: map.version + 1,
          updated_at: "2026-08-18T13:00:00Z"
        };
        browserMapOverrides.set(`${mapMatch[1]}:${mapMatch[2]}`, updated);
        writeJson(response, 200, updated, requestId);
      }
    } else {
      writeJson(response, 200, map, requestId);
    }
    return true;
  }

  writeJson(response, 404, {detail: "not_found"}, requestId);
  return true;
}

function membership(organizationId, role) {
  return {organization_id: organizationId, role};
}

function clientPayloads() {
  return [
    apiRecord({id: IDS.clients[0], name: "Planning Programs", client_code: "PROGRAMS", description: "Program client"}),
    apiRecord({id: IDS.clients[1], name: "Public Demonstrations", client_code: "PUBLIC", description: "Public client"})
  ];
}

function projectPayloads() {
  return [
    apiRecord({id: IDS.projects[0], client_id: IDS.clients[0], name: "Nepal Energy Access", project_code: "NEPAL-ENERGY", description: "Energy access planning", caller_role: "owner"}),
    apiRecord({id: IDS.projects[1], client_id: IDS.clients[0], name: "Midwest Resilience", project_code: "MIDWEST-RESILIENCE", description: "Resilience planning", caller_role: "editor"}),
    apiRecord({id: IDS.projects[2], client_id: IDS.clients[1], name: "Public Data Demonstration", project_code: "PUBLIC-DEMO", description: "Viewer demonstration", caller_role: "viewer"})
  ];
}

function allProjectPayloads() {
  return [...projectPayloads(), ...browserCreatedProjects];
}

function organizationMemberPayloads() {
  return [
    {user_id: IDS.user, email: "browser-check@opengeo.tools", display_name: "Browser Check", role: "admin"},
    {user_id: IDS.member, email: "member@opengeo.tools", display_name: "Browser Member", role: "member"}
  ];
}

function projectMemberPayloads(projectId) {
  if (!IDS.projects.includes(projectId)) return [];
  return [
    {user_id: IDS.user, email: "browser-check@opengeo.tools", display_name: "Browser Check", role: "owner"},
    {user_id: IDS.member, email: "member@opengeo.tools", display_name: "Browser Member", role: "reviewer"}
  ];
}

function invitationPayloads() {
  return [
    invitationPayload({id: IDS.invitation, email: "pending@opengeo.tools", display_name: "Pending Browser Invitee", status: "pending"}),
    invitationPayload({id: "70000000-0000-4000-8000-000000000002", email: "accepted@opengeo.tools", display_name: "Accepted Browser Invitee", status: "accepted", accepted_at: "2026-08-19T13:00:00Z"}),
    invitationPayload({id: "70000000-0000-4000-8000-000000000003", email: "expired@opengeo.tools", display_name: "Expired Browser Invitee", status: "expired", expires_at: "2026-08-18T12:00:00Z"}),
    invitationPayload({id: "70000000-0000-4000-8000-000000000004", email: "revoked@opengeo.tools", display_name: "Revoked Browser Invitee", status: "revoked", revoked_at: "2026-08-19T13:00:00Z"})
  ];
}

function invitationPayload(overrides) {
  return {
    email: "invitee@opengeo.tools",
    display_name: "Browser Invitee",
    organization_role: "guest",
    project_id: IDS.projects[0],
    project_role: "viewer",
    status: "pending",
    expires_at: "2099-08-26T12:00:00Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function pendingInvitationPayload() {
  return {
    invitation_id: IDS.invitation,
    organization_id: IDS.organization,
    organization_name: "OpenGeo Browser Organization",
    project_id: IDS.projects[0],
    project_name: "Nepal Energy Access",
    organization_role: "guest",
    project_role: "viewer",
    expires_at: "2099-08-26T12:00:00Z",
    created_at: "2026-08-19T12:00:00Z"
  };
}

function apiRecord(fields) {
  return {
    ...fields,
    status: "active",
    created_at: "2026-08-18T12:00:00Z",
    updated_at: "2026-08-18T12:00:00Z"
  };
}

function mapPayloadForProject(projectId) {
  const index = IDS.projects.indexOf(projectId);
  if (index < 0) return null;
  const project = projectPayloads()[index];
  return apiRecord({
    id: IDS.maps[index],
    project_id: projectId,
    name: `${project.name} map`,
    description: project.description,
    definition: {
      mapViews: [{id: "default", title: "Default", center: [0, 20], zoom: 2}],
      basemaps: [],
      bookmarks: [],
      layers: importedMapDefinition && projectId === IDS.projects[0]
        ? importedMapDefinition.layers
        : []
    },
    ...(importedMapDefinition && projectId === IDS.projects[0]
      ? {definition: importedMapDefinition}
      : {}),
    version: importedMapVersion && projectId === IDS.projects[0] ? importedMapVersion : 1
  });
}

function mapPayloadsForProject(projectId) {
  const initial = mapPayloadForProject(projectId);
  return [
    ...(initial ? [initial] : []),
    ...browserCreatedMaps.filter((map) => map.project_id === projectId)
  ].map((map) => browserMapOverrides.get(`${projectId}:${map.id}`) ?? map);
}

function projectDatasetIds(projectId) {
  if (!browserProjectDatasetLinks.has(projectId)) {
    browserProjectDatasetLinks.set(projectId, new Set());
  }
  return browserProjectDatasetLinks.get(projectId);
}

function datasetPayload(overrides = {}) {
  return {
    id: IDS.dataset,
    project_id: IDS.projects[0],
    name: "Access Road Network",
    description: "Imported road segments near candidate generation sites.",
    classification: "internal",
    source_type: "upload",
    format: "geojson",
    status: "active",
    owner_user_id: IDS.user,
    current_version_id: IDS.version,
    current_version_number: 1,
    current_version_state: "active",
    feature_count: 6,
    extent: [85.21, 27.58, 85.43, 27.76],
    crs: "EPSG:4326",
    geometry_type: "LineString",
    quality_results: {
      valid: true,
      checks: [{code: "format_verified", status: "passed"}],
      warnings: [],
      errors: []
    },
    processing_job_state: "completed",
    processing_error_code: null,
    tags: ["transport", "access"],
    created_at: "2026-08-18T12:00:00Z",
    updated_at: "2026-08-18T12:00:00Z",
    capabilities: {read: true, edit: true, download: true, manage_permissions: true},
    ...overrides
  };
}

function browserFeaturePage() {
  const features = Array.from({length: 6}, (_, index) => ({
    type: "Feature",
    id: `88000000-0000-4000-8000-00000000000${index + 1}`,
    bbox: [85.21 + index * 0.02, 27.58 + index * 0.02, 85.23 + index * 0.02, 27.6 + index * 0.02],
    geometry: {
      type: "LineString",
      coordinates: [
        [85.21 + index * 0.02, 27.58 + index * 0.02],
        [85.23 + index * 0.02, 27.6 + index * 0.02]
      ]
    },
    properties: {name: `Access segment ${index + 1}`, status: "verified"},
    "opengeo:version": 1,
    "opengeo:collectionGeneration": 1,
    "opengeo:createdBy": IDS.user,
    "opengeo:createdAt": "2026-08-20T15:00:00Z",
    "opengeo:updatedBy": IDS.user,
    "opengeo:updatedAt": "2026-08-20T15:00:00Z"
  }));
  return {
    type: "FeatureCollection",
    features,
    numberMatched: features.length,
    numberReturned: features.length,
    "opengeo:collection": {
      dataset_id: IDS.dataset,
      geometry_type: "LineString",
      fields: [
        {name: "name", type: "string", required: true},
        {name: "status", type: "string", required: true}
      ],
      generation: 1,
      feature_count: features.length,
      created_by: IDS.user,
      created_at: "2026-08-20T15:00:00Z",
      updated_by: IDS.user,
      updated_at: "2026-08-20T15:00:00Z"
    },
    "opengeo:limit": 100,
    "opengeo:offset": 0
  };
}

async function browserSpatialPreviewPayload(datasetId, versionId) {
  const knownVersionId = datasetId === IDS.dataset ? IDS.version
    : geomooseQueryMode && datasetId === IDS.geomooseQueryDataset ? IDS.geomooseQueryVersion
      : null;
  if (knownVersionId === null || versionId !== knownVersionId) return null;
  // These fixed upload-version fixtures are independent of the live editable
  // collection. Never turn later authoritative edits into historical preview bytes.
  const source = geomooseQueryMode
    ? await browserGeoMooseFeaturePage(datasetId)
    : browserFeaturePage();
  const features = source.features.map(({type, id, bbox, geometry, properties}) => (
    {type, id, bbox, geometry, properties}
  ));
  return {
    schema_version: "opengeo.spatial-preview.1.0.0",
    dataset_version_id: knownVersionId,
    number_returned: features.length,
    number_matched: features.length,
    may_be_truncated: false,
    geojson: {type: "FeatureCollection", features}
  };
}

function resetBrowserAuthoringState() {
  browserAuthoritativeFeatureState = {
    generation: 1,
    features: [],
    createdAt: "2026-08-30T15:00:00Z",
    updatedAt: "2026-08-30T15:00:00Z"
  };
  browserFieldForms = [];
  browserFieldSubmissions = [];
  const map = mapPayloadForProject(IDS.projects[0]);
  browserMapOverrides.set(`${IDS.projects[0]}:${IDS.maps[0]}`, {
    ...map,
    definition: {
      ...map.definition,
      layers: [{
        layerId: "browser-access-road-presentation",
        datasetId: IDS.dataset,
        title: "Access Road Network · saved presentation",
        sourceType: "geojson-object",
        geometryType: "LineString",
        visible: true,
        opacity: 0.9,
        order: 0,
        style: {stroke: "#2f80ed", strokeWidth: 3},
        labels: {enabled: false, field: "name"}
      }]
    }
  });
}

function browserAuthoritativeFeaturePage({features = null, limit = 100, offset = 0} = {}) {
  const state = browserAuthoritativeFeatureState ?? {
    generation: 1,
    features: [],
    createdAt: "2026-08-30T15:00:00Z",
    updatedAt: "2026-08-30T15:00:00Z"
  };
  const matching = features ?? state.features;
  const page = matching.slice(offset, offset + limit);
  return {
    type: "FeatureCollection",
    features: page,
    numberMatched: matching.length,
    numberReturned: page.length,
    "opengeo:collection": {
      dataset_id: IDS.dataset,
      geometry_type: "LineString",
      fields: browserAuthoritativeFeatureFields(),
      generation: state.generation,
      feature_count: state.features.length,
      created_by: IDS.user,
      created_at: state.createdAt,
      updated_by: IDS.user,
      updated_at: state.updatedAt
    },
    "opengeo:limit": limit,
    "opengeo:offset": offset
  };
}

async function browserAuthoritativeFeatureQueryPage(query) {
  const state = browserAuthoritativeFeatureState;
  const {matches, page} = applyFeatureQuery(state.features, query);
  return {
    ...browserAuthoritativeFeaturePage({
      features: matches,
      limit: query.limit,
      offset: query.offset
    }),
    features: page,
    numberReturned: page.length,
    "opengeo:query": {...query, sort: "feature_id"},
    "opengeo:querySha256": await featureQuerySha256(query),
    "opengeo:collectionGeneration": state.generation
  };
}

function addBrowserAuthoritativeFeature(draft, {
  id,
  createdAt = "2026-08-30T15:01:00Z"
}) {
  if (!browserAuthoritativeFeatureState) resetBrowserAuthoringState();
  browserAuthoritativeFeatureState.generation += 1;
  browserAuthoritativeFeatureState.updatedAt = "2026-08-30T15:05:00Z";
  const feature = browserGovernedFeaturePayload({
    id,
    geometry: draft.geometry,
    properties: draft.properties,
    version: 1,
    generation: browserAuthoritativeFeatureState.generation,
    createdAt
  });
  browserAuthoritativeFeatureState.features.push(feature);
  return feature;
}

function browserGovernedFeaturePayload({
  id,
  geometry,
  properties,
  version,
  generation,
  createdAt
}) {
  return {
    type: "Feature",
    id,
    bbox: browserGeometryBounds(geometry),
    geometry: structuredClone(geometry),
    properties: structuredClone(properties),
    "opengeo:version": version,
    "opengeo:collectionGeneration": generation,
    "opengeo:createdBy": IDS.user,
    "opengeo:createdAt": createdAt,
    "opengeo:updatedBy": IDS.user,
    "opengeo:updatedAt": "2026-08-30T15:05:00Z"
  };
}

function validBrowserFeatureDraft(value) {
  if (!value
    || value.type !== "Feature"
    || value.geometry?.type !== "LineString"
    || !Array.isArray(value.geometry.coordinates)
    || value.geometry.coordinates.length < 2
    || !value.geometry.coordinates.every((coordinate) => (
      Array.isArray(coordinate)
      && coordinate.length >= 2
      && coordinate.slice(0, 2).every(Number.isFinite)
    ))) return false;
  const properties = value.properties;
  return properties
    && typeof properties === "object"
    && !Array.isArray(properties)
    && browserAuthoritativeFeatureFields().every(({name, required}) => (
      !required || typeof properties[name] === "string"
    ))
    && JSON.stringify(value).length <= 330_000;
}

function browserGeometryBounds(geometry) {
  const coordinates = geometry.coordinates;
  const xs = coordinates.map((coordinate) => coordinate[0]);
  const ys = coordinates.map((coordinate) => coordinate[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function browserAuthoritativeFeatureFields() {
  return [{name: "name", type: "string", required: true}];
}

function browserFieldFormPayload(payload) {
  return {
    id: "8a000000-0000-4000-8000-000000000001",
    dataset_id: IDS.dataset,
    version: 1,
    title: payload.title,
    instructions: payload.instructions,
    collection_generation: browserAuthoritativeFeatureState.generation,
    geometry_type: "LineString",
    fields: browserAuthoritativeFeatureFields(),
    created_by: IDS.user,
    created_at: "2026-08-30T15:02:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-30T15:02:00Z"
  };
}

function validBrowserFieldSubmissionDraft(payload, form) {
  const operationTargetIsValid = payload.operation === "create"
    ? payload.target_feature_id === null && payload.target_feature_version === null
    : payload.operation === "update"
      && typeof payload.target_feature_id === "string"
      && Number.isSafeInteger(payload.target_feature_version)
      && payload.target_feature_version > 0;
  const expectedFeatureId = payload.operation === "create"
    ? payload.client_submission_id
    : payload.target_feature_id;
  return typeof payload.client_submission_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.client_submission_id
    )
    && (payload.supersedes_submission_id === null
      || browserFieldSubmissions.some(({id}) => id === payload.supersedes_submission_id))
    && operationTargetIsValid
    && payload.feature?.id === expectedFeatureId
    && validBrowserFeatureDraft(payload.feature)
    && form.collection_generation === browserAuthoritativeFeatureState.generation;
}

function browserFieldSubmissionPayload({
  id,
  form,
  feature,
  supersedesSubmissionId,
  operation,
  targetFeatureId,
  targetFeatureVersion
}) {
  return {
    id,
    dataset_id: IDS.dataset,
    form_id: form.id,
    form_version: form.version,
    supersedes_submission_id: supersedesSubmissionId,
    operation,
    target_feature_id: targetFeatureId,
    target_feature_version: targetFeatureVersion,
    payload_sha256: "d".repeat(64),
    feature: structuredClone(feature),
    state: "submitted",
    review_version: 1,
    submitted_by: IDS.user,
    submitted_at: "2026-08-30T15:03:00Z",
    reviewed_by: null,
    reviewed_at: null,
    review_message: null,
    promoted_feature_id: null
  };
}

async function browserGeoMooseFeaturePage(datasetId, {query = null} = {}) {
  const polygonDataset = datasetId === IDS.geomooseQueryDataset;
  const features = polygonDataset
    ? [{
        type: "Feature",
        id: "88000000-0000-4000-8000-000000000041",
        bbox: [-71.15, 42.33, -71.04, 42.42],
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-71.15, 42.33], [-71.04, 42.33], [-71.04, 42.42], [-71.15, 42.33]
          ]]
        },
        properties: {name: "Priority habitat A", status: "screened"},
        "opengeo:version": 4,
        "opengeo:collectionGeneration": 7,
        "opengeo:createdBy": IDS.user,
        "opengeo:createdAt": "2026-08-29T12:00:00Z",
        "opengeo:updatedBy": IDS.user,
        "opengeo:updatedAt": "2026-08-29T12:00:00Z"
      }]
    : [
        {
          type: "Feature",
          id: "88000000-0000-4000-8000-000000000042",
          bbox: [-71.14, 42.34, -71.03, 42.4],
          geometry: {
            type: "LineString",
            coordinates: [[-71.14, 42.34], [-71.03, 42.4]]
          },
          properties: {name: "Water quality transect A", status: "verified"},
          "opengeo:version": 2,
          "opengeo:collectionGeneration": 7,
          "opengeo:createdBy": IDS.user,
          "opengeo:createdAt": "2026-08-29T12:00:00Z",
          "opengeo:updatedBy": IDS.user,
          "opengeo:updatedAt": "2026-08-29T12:00:00Z"
        },
        {
          type: "Feature",
          id: "88000000-0000-4000-8000-000000000043",
          bbox: [-71.11, 42.36, -71.0, 42.43],
          geometry: {
            type: "LineString",
            coordinates: [[-71.11, 42.36], [-71.0, 42.43]]
          },
          properties: {name: "Water quality transect B", status: "reviewed"},
          "opengeo:version": 3,
          "opengeo:collectionGeneration": 7,
          "opengeo:createdBy": IDS.user,
          "opengeo:createdAt": "2026-08-29T12:00:00Z",
          "opengeo:updatedBy": IDS.user,
          "opengeo:updatedAt": "2026-08-29T12:00:00Z"
        }
      ];
  const page = query ? features.slice(query.offset, query.offset + query.limit) : features;
  const response = {
    type: "FeatureCollection",
    features: page,
    numberMatched: features.length,
    numberReturned: page.length,
    "opengeo:collection": {
      dataset_id: datasetId,
      geometry_type: polygonDataset ? "Polygon" : "LineString",
      fields: [
        {name: "name", type: "string", required: true},
        {name: "status", type: "string", required: true}
      ],
      generation: 7,
      feature_count: features.length,
      created_by: IDS.user,
      created_at: "2026-08-29T12:00:00Z",
      updated_by: IDS.user,
      updated_at: "2026-08-29T12:00:00Z"
    },
    "opengeo:limit": query?.limit ?? 100,
    "opengeo:offset": query?.offset ?? 0
  };
  if (!query) return response;
  return {
    ...response,
    "opengeo:query": {...query, sort: "feature_id"},
    "opengeo:querySha256": await featureQuerySha256(query),
    "opengeo:collectionGeneration": 7
  };
}

function resourceSummaryPayload(overrides = {}) {
  return {
    id: IDS.resource,
    project_id: IDS.projects[0],
    kind: "story",
    slug: "nepal-energy-access-story",
    dataset_id: null,
    map_id: IDS.maps[0],
    visibility: "organization",
    state: "review",
    version_number: 1,
    title: "Nepal energy access story",
    abstract: "A mixed-content research story migrated through the pinned GeoNode 5.1 boundary.",
    language: "en",
    license: "CC-BY-4.0",
    attribution: "Browser research team",
    keywords: ["energy", "research", "geonode"],
    spatial_extent: [80, 26, 88.2, 30.5],
    temporal_start: "2025-01-01T00:00:00Z",
    temporal_end: "2026-08-18T00:00:00Z",
    owner_user_id: IDS.user,
    origin_namespace: "geonode",
    origin_identifier: "5.1.0:resource:42",
    relationship_count: 2,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function spatialServicePayload(overrides = {}) {
  return {
    id: IDS.spatialService,
    project_id: IDS.projects[0],
    slug: "research-atlas",
    title: "Research atlas",
    description: "Administered feature, map, and tile service.",
    created_by: IDS.user,
    created_at: "2026-08-20T18:00:00Z",
    disabled_by: null,
    disabled_at: null,
    ...overrides
  };
}

function spatialServiceCatalogPayload(overrides = {}) {
  return {
    metadata: {
      version_id: IDS.spatialServiceMetadataVersion,
      service_id: IDS.spatialService,
      version_number: 1,
      title: "Research atlas",
      abstract: "Administered feature, map, and tile service.",
      namespace_uri: "https://studio.opengeo.tools/services/research-atlas",
      keywords: ["research", "roads"],
      fees: null,
      access_constraints: ["authenticated project access"],
      contact: {name: "OpenGeo browser fixture"},
      enabled_protocols: ["ogc_api_features", "wms_1_3", "wmts_1_0"],
      change_message: "Initial governed catalog metadata",
      created_by: IDS.user,
      created_at: "2026-08-20T18:00:00Z"
    },
    stores: [{
      id: IDS.spatialServiceStore,
      project_id: IDS.projects[0],
      service_id: IDS.spatialService,
      slug: "managed-project",
      title: "Managed project datasets",
      description: "Project-owned governed resources.",
      kind: "managed_project",
      dataset_id: null,
      external_connection_id: null,
      sealed_source_revision_number: null,
      sealed_connection_revision_number: null,
      configuration: {},
      created_by: IDS.user,
      created_at: "2026-08-20T18:00:00Z",
      disabled_by: null,
      disabled_at: null
    }],
    layer_groups: [],
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
    },
    ...overrides
  };
}

function spatialServiceCollectionPayload(overrides = {}) {
  return {
    id: IDS.spatialBinding,
    project_id: IDS.projects[0],
    service_id: IDS.spatialService,
    collection_name: "roads",
    dataset_id: IDS.dataset,
    resource_id: IDS.resource,
    default_profile_id: IDS.renderProfile,
    sealed_feature_generation: 3,
    sealed_profile_version_id: IDS.renderProfileVersion,
    sealed_profile_version_number: 2,
    current_feature_generation: 3,
    current_profile_version_id: IDS.renderProfileVersion,
    current_profile_version_number: 2,
    stale: false,
    target_active: true,
    title: "Road network",
    description: "Current authoritative road collection.",
    created_by: IDS.user,
    created_at: "2026-08-20T18:01:00Z",
    withdrawn_by: null,
    withdrawn_at: null,
    ...overrides
  };
}

function tileCachePolicyPayload(overrides = {}) {
  return {
    id: IDS.tileCache,
    project_id: IDS.projects[0],
    service_id: IDS.spatialService,
    binding_id: IDS.spatialBinding,
    version_id: IDS.currentTileCacheVersion,
    version_number: 2,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 8,
    maximum_entries: 64,
    current_entries: 0,
    change_message: "Current bounded cache",
    created_by: IDS.user,
    created_at: "2026-08-20T18:01:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-21T18:00:00Z",
    cache_mode: "seeded-cache-only",
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileSeedPlanPreviewPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.currentTileCacheVersion,
    cache_version_number: 2,
    mode: "tiles",
    bbox: null,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 1,
    requested_count: 2,
    existing_count: 0,
    target_count: 2,
    targets: [
      {tile_matrix: 0, tile_row: 0, tile_col: 0},
      {tile_matrix: 1, tile_row: 0, tile_col: 0}
    ],
    expires_at: "2099-08-21T18:15:00Z",
    preview_checksum_sha256: "9".repeat(64),
    expansion_order: "tile_matrix,tile_row,tile_col",
    batch_limit: 64,
    confirmation_required: true,
    ordinary_reads_create_work: false,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileSeedPlanPayload(overrides = {}) {
  return {
    id: IDS.tileSeedPlan,
    cache_id: IDS.tileCache,
    cache_version_id: IDS.currentTileCacheVersion,
    cache_version_number: 2,
    mode: "tiles",
    bbox: null,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 1,
    requested_count: 2,
    existing_count: 0,
    target_count: 2,
    preview_checksum_sha256: "9".repeat(64),
    preview_expires_at: "2099-08-21T18:15:00Z",
    state: "queued",
    error_code: null,
    created_by: IDS.user,
    created_at: "2026-08-21T18:00:00Z",
    dispatch_started_at: "2026-08-21T18:00:01Z",
    started_at: null,
    finished_at: null,
    items: [
      {
        position: 1,
        tile_matrix: 0,
        tile_row: 0,
        tile_col: 0,
        render_job_id: IDS.tileSeedRender,
        state: "queued",
        error_code: null,
        started_at: null,
        finished_at: null
      },
      {
        position: 2,
        tile_matrix: 1,
        tile_row: 0,
        tile_col: 0,
        render_job_id: IDS.tileSeedRenderSecond,
        state: "queued",
        error_code: null,
        started_at: null,
        finished_at: null
      }
    ],
    cancel_available: false,
    activation: "explicit-confirmation-only",
    ordinary_reads_create_work: false,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function retiredTileCacheVersionPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 8,
    maximum_entries: 64,
    change_message: "Retired after profile revision",
    created_at: "2026-08-19T12:00:00Z",
    retired_at: "2026-08-20T12:00:00Z",
    entry_count: 1,
    render_output_count: 1,
    reclamation_id: null,
    reclamation_state: null,
    reclamation_target_count: null,
    reclamation_completed_count: 0,
    reclamation_failed_count: 0,
    ...overrides
  };
}

function tileCacheReclamationPreviewPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    target_count: 1,
    remaining_eligible_target_count: 0,
    target_size_bytes: 67,
    oldest_render_finished_at: "2026-08-20T10:00:00Z",
    newest_render_finished_at: "2026-08-20T10:00:00Z",
    expires_at: "2099-08-21T18:15:00Z",
    preview_checksum_sha256: "8".repeat(64),
    physical_action: "delete_exact_storage_versions",
    render_history_retained: true,
    cache_history_retained: true,
    ordinary_reads_create_work: false,
    batch_limit: 64,
    minimum_reclamation_age_hours: 24,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileCacheReclamationPayload(overrides = {}) {
  return {
    id: IDS.tileCacheReclamation,
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    target_count: 1,
    target_size_bytes: 67,
    state: "queued",
    error_code: null,
    attempt_count: 0,
    completed_target_count: 0,
    failed_target_count: 0,
    preview_checksum_sha256: "8".repeat(64),
    preview_expires_at: "2099-08-21T18:15:00Z",
    created_by: IDS.user,
    created_at: "2026-08-21T18:00:00Z",
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

function coverageProcessingPolicyPayload(overrides = {}) {
  return {
    request_schema_version: 2,
    maximum_axis_pixels: 8192,
    maximum_pixels: 16_777_216,
    maximum_samples: 67_108_864,
    maximum_retained_jobs_per_coverage: 64,
    maximum_active_jobs_per_coverage: 4,
    maximum_output_bytes: 536_870_912,
    supported_resampling: ["nearest", "bilinear", "cubic"],
    cancellation_states: ["queued"],
    minimum_reclamation_age_hours: 24,
    reclamation_preview_ttl_seconds: 900,
    physical_reclamation: "preview_then_explicit_exact_version_worker_delete",
    ordinary_reads_create_work: false,
    ...overrides
  };
}

function spatialCoveragePayload(overrides = {}) {
  return {
    id: IDS.spatialCoverage,
    project_id: IDS.projects[0],
    service_id: IDS.spatialService,
    coverage_name: "elevation",
    dataset_id: IDS.dataset,
    dataset_version_id: IDS.version,
    data_object_id: "84000000-0000-4000-8000-000000000001",
    sealed_dataset_version_number: 1,
    current_dataset_version_id: IDS.version,
    current_dataset_version_number: 1,
    crs: "EPSG:4326",
    extent: [-77.2, 38.8, -76.8, 39.2],
    width: 512,
    height: 256,
    band_count: 1,
    bands: [{index: 1, data_type: "Float32", color_interpretation: "Gray"}],
    content_type: "image/tiff",
    size_bytes: 16384,
    checksum_sha256: "a".repeat(64),
    stale: false,
    target_active: true,
    title: "Research elevation",
    description: "Exact test coverage.",
    created_by: IDS.user,
    created_at: "2026-08-20T16:00:00Z",
    withdrawn_by: null,
    withdrawn_at: null,
    ...overrides
  };
}

function coverageDerivativePayload(overrides = {}) {
  return {
    id: IDS.coverageDerivative,
    project_id: IDS.projects[0],
    service_id: IDS.spatialService,
    coverage_id: IDS.spatialCoverage,
    coverage_name: "elevation",
    subset_extent: [-77.2, 38.8, -76.8, 39.2],
    target_crs: "EPSG:3857",
    target_width: 256,
    target_height: 128,
    resampling: "bilinear",
    request_schema_version: 2,
    band_indexes: [1],
    scale_mode: "size",
    requested_resolution: null,
    request_checksum_sha256: "b".repeat(64),
    state: "completed",
    output_object_id: IDS.coverageDerivativeObject,
    output_crs: "EPSG:3857",
    output_extent: [-8592733.3, 4694777.1, -8548205.4, 4756928.6],
    output_width: 256,
    output_height: 128,
    output_band_count: 1,
    output_bands: [{
      index: 1,
      source_index: 1,
      data_type: "Float32",
      color_interpretation: "Gray"
    }],
    output_content_type: "image/tiff",
    output_size_bytes: 8192,
    output_checksum_sha256: "c".repeat(64),
    error_code: null,
    attempt_count: 1,
    created_by: IDS.user,
    created_at: "2026-08-20T16:55:00Z",
    started_at: "2026-08-20T16:56:00Z",
    finished_at: "2026-08-20T17:00:00Z",
    source_available: true,
    reclamation_state: null,
    output_available: true,
    ...overrides
  };
}

function coverageReclamationPreviewPayload(overrides = {}) {
  return {
    derivative_job_id: IDS.coverageDerivative,
    output_object_id: IDS.coverageDerivativeObject,
    size_bytes: 8192,
    checksum_sha256: "c".repeat(64),
    derivative_finished_at: "2026-08-20T17:00:00Z",
    expires_at: "2026-08-21T17:15:00Z",
    preview_checksum_sha256: "f".repeat(64),
    physical_action: "delete_exact_storage_version",
    history_retained: true,
    ordinary_reads_create_work: false,
    ...overrides
  };
}

function coverageReclamationPayload(overrides = {}) {
  return {
    id: IDS.coverageReclamation,
    derivative_job_id: IDS.coverageDerivative,
    output_object_id: IDS.coverageDerivativeObject,
    state: "queued",
    size_bytes: 8192,
    checksum_sha256: "c".repeat(64),
    preview_checksum_sha256: "f".repeat(64),
    preview_expires_at: "2026-08-21T17:15:00Z",
    error_code: null,
    attempt_count: 0,
    delete_started_at: null,
    created_by: IDS.user,
    created_at: "2026-08-21T17:05:00Z",
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

function sitePayload(overrides = {}) {
  return {
    id: IDS.site,
    project_id: IDS.projects[0],
    slug: "research-field-report",
    version_id: IDS.siteVersion,
    version_number: 1,
    state: "draft",
    title: "Research field report",
    description: "A general publishing project built from governed editorial pages.",
    language: "en",
    theme: "paper",
    theme_options: {accentColor: "#176b87"},
    print_layout: {schemaVersion: "opengeo.print-layout.1.0.0", pages: []},
    change_message: null,
    created_by: IDS.user,
    created_at: "2026-08-20T20:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-20T20:00:00Z",
    pages: [{
      id: IDS.sitePage,
      slug: "findings",
      navigation_label: "Findings",
      position: 0,
      is_home: true,
      resource_id: IDS.resource,
      resource_version_id: IDS.resourceVersion,
      resource_version_number: 1,
      resource_kind: "story",
      resource_title: "Nepal energy access story",
      resource_state: "review",
      resource_visibility: "organization",
      content: {blocks: [{id: "introduction", type: "markdown", markdown: "# Findings"}]}
    }],
    publication_destination: {
      revision: 1,
      reach: "unpublished",
      listed_slug: null,
      is_primary: false,
      configured_by: IDS.user,
      configured_at: "2026-08-20T20:00:00Z"
    },
    active_edition: null,
    ...overrides
  };
}

function observableResourceLimits() {
  return {
    cpuMillis: 1_000,
    memoryMiB: 2_048,
    timeoutSeconds: 120,
    maxInputFiles: 128,
    maxInputBytes: 16_777_216,
    maxOutputFiles: 512,
    maxOutputBytes: 33_554_432
  };
}

function observableSourceProjectPayload(overrides = {}) {
  return {
    id: IDS.sourceProject,
    project_id: IDS.projects[0],
    site_id: IDS.site,
    route_namespace: "research-field-report",
    title: "Research field report source",
    rights_status: "unreviewed",
    owner_user_id: IDS.user,
    current_revision_id: null,
    current_revision_number: 0,
    build_policy: {
      compiler_image_digest: `sha256:${"c".repeat(64)}`,
      framework_version: "1.13.4",
      lockfile_format: "npm-package-lock-v3",
      network_policy: "deny_all",
      resource_limits: observableResourceLimits()
    },
    created_by: IDS.user,
    created_at: "2026-08-22T18:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-22T18:00:00Z",
    ...overrides
  };
}

function observableSourceRevisionPayload(payload) {
  const sourceFiles = [
    ["index.md", IDS.sourceUploadMarkdown, IDS.sourceObjectMarkdown],
    ["package-lock.json", IDS.sourceUploadLock, IDS.sourceObjectLock]
  ].map(([relativePath, uploadId, objectId]) => {
    const upload = browserObservableSourceUploads.get(uploadId);
    return {
      relative_path: relativePath,
      source_object_id: objectId,
      bucket: "source.opengeo.tools",
      object_key: `organizations/${IDS.organization}/projects/${IDS.projects[0]}/source-projects/${IDS.sourceProject}/objects/${objectId}/${relativePath}`,
      s3_version_id: `${uploadId}-version`,
      etag: `${uploadId}-etag`,
      content_type: upload.content_type,
      size_bytes: upload.size_bytes,
      checksum_sha256: upload.checksum_sha256
    };
  });
  return {
    id: IDS.sourceRevision,
    source_project_id: IDS.sourceProject,
    revision_number: 1,
    parent_revision_id: null,
    title: payload.title,
    rights_status: payload.rights_status,
    entry_path: payload.entry_path,
    lockfile_path: payload.lockfile_path,
    manifest: {
      schemaVersion: "opengeo.observable-source-revision.1.0.0",
      sourceProjectId: IDS.sourceProject,
      revisionId: IDS.sourceRevision,
      revisionNumber: 1,
      entryPath: payload.entry_path,
      lockfilePath: payload.lockfile_path,
      files: sourceFiles.map((file) => ({
        relativePath: file.relative_path,
        sourceObjectId: file.source_object_id,
        bucket: file.bucket,
        objectKey: file.object_key,
        s3VersionId: file.s3_version_id,
        etag: file.etag,
        contentType: file.content_type,
        sizeBytes: file.size_bytes,
        checksumSha256: file.checksum_sha256
      }))
    },
    manifest_checksum_sha256: "d".repeat(64),
    change_summary: payload.change_summary,
    created_by: IDS.user,
    created_at: "2026-08-22T18:05:00Z",
    files: sourceFiles
  };
}

function observableBuildPayload() {
  return {
    id: IDS.observableBuild,
    source_project_id: IDS.sourceProject,
    source_revision_id: IDS.sourceRevision,
    source_revision_number: 1,
    purpose: "preview",
    state: "pending",
    request: {
      schemaVersion: "opengeo.observable-build-request.1.0.0",
      sourceProjectId: IDS.sourceProject,
      sourceRevisionId: IDS.sourceRevision,
      sourceRevisionNumber: 1,
      sourceManifestChecksumSha256: "d".repeat(64),
      purpose: "preview",
      compilerImageDigest: `sha256:${"c".repeat(64)}`,
      frameworkVersion: "1.13.4",
      lockfileFormat: "npm-package-lock-v3",
      lockfileChecksumSha256: browserObservableSourceUploads.get(
        IDS.sourceUploadLock
      ).checksum_sha256,
      networkPolicy: "deny_all",
      resourceLimits: observableResourceLimits()
    },
    request_checksum_sha256: "e".repeat(64),
    result: null,
    result_checksum_sha256: null,
    attempt_count: 0,
    error_code: null,
    created_by: IDS.user,
    created_at: "2026-08-22T18:06:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-22T18:06:00Z",
    execution_available: false,
    coordination_status: "not_configured"
  };
}

function resourceDetailPayload(summary = resourceSummaryPayload()) {
  return {
    ...summary,
    metadata_profile: "opengeo.core.v1",
    metadata_extensions: {geonode: {resource_type: "geoapp", subtype: "geostory"}},
    translations: {
      ne: {
        title: "नेपाल ऊर्जा पहुँच कथा",
        abstract: "ऊर्जा पहुँच अनुसन्धान कथा।",
        attribution: "अनुसन्धान टोली",
        keywords: ["ऊर्जा"]
      }
    },
    managed_metadata_profile_id: null,
    managed_metadata_profile_version: null,
    metadata_validation: null,
    content: {
      blocks: [{id: "introduction", type: "markdown", markdown: "# Nepal energy access"}]
    },
    provenance: {source_product: "geonode", source_version: "5.1.0"},
    change_message: null,
    version_created_by: IDS.user,
    version_created_at: "2026-08-19T12:00:00Z",
    external_identifiers: [{
      namespace: "geonode",
      identifier: "5.1.0:resource:42",
      source_url: "https://geonode.example.test/catalogue/42",
      source_version: "5.1.0",
      source_payload_sha256: "d".repeat(64),
      imported_at: "2026-08-19T12:00:00Z"
    }],
    relationships: []
  };
}

function ogcRecordPayload(summary, requestedLanguage) {
  const detail = resourceDetailPayload(summary);
  const language = Object.hasOwn(detail.translations, requestedLanguage)
    ? requestedLanguage
    : detail.language;
  const localized = detail.translations[language] ?? {
    title: detail.title,
    abstract: detail.abstract,
    keywords: detail.keywords
  };
  return {
    type: "Feature",
    id: detail.id,
    geometry: null,
    properties: {
      created: detail.created_at,
      updated: detail.updated_at,
      type: detail.kind,
      title: localized.title,
      description: localized.abstract,
      keywords: localized.keywords,
      language: {code: language},
      languages: ["en", ...Object.keys(detail.translations)]
        .filter((candidate) => candidate !== language)
        .map((code) => ({code})),
      externalIds: detail.external_identifiers.map((identifier) => ({
        scheme: identifier.namespace,
        value: identifier.identifier
      }))
    },
    links: [
      {
        href: `/projects/${detail.project_id}/records/collections/resources/items/${detail.id}?language=${language}`,
        rel: "self",
        type: "application/geo+json",
        hreflang: language
      },
      {
        href: `/projects/${detail.project_id}/records/collections/resources`,
        rel: "collection",
        type: "application/ogc-catalog+json"
      }
    ]
  };
}

function metadataProfilePayload() {
  return {
    id: IDS.metadataProfile,
    slug: "research.core",
    title: "Research core",
    description: "Curated research metadata",
    version_number: 1,
    definition: {
      schema_version: "1.0.0",
      required_core: ["title", "abstract", "license", "attribution"],
      core_vocabularies: {license: ["CC-BY-4.0", "CC0-1.0"]},
      required_languages: [],
      extension_fields: []
    },
    checksum_sha256: "a".repeat(64),
    change_message: null,
    created_by: IDS.user,
    version_created_by: IDS.user,
    created_at: "2026-08-20T16:00:00Z",
    updated_at: "2026-08-20T16:00:00Z",
    version_created_at: "2026-08-20T16:00:00Z"
  };
}

function sourceDiscoveryJobPayload(projectId, payload) {
  const arcgis = payload.source_type === "arcgis";
  const catalog = payload.kind === "catalog";
  const collectionRef = catalog
    ? null
    : payload.collection_ref;
  const collection = arcgis
    ? {
        ref: collectionRef ?? "7",
        name: "Environmental screening areas",
        title: "Environmental screening areas",
        geometry_type: "MultiPolygon",
        bounds: [-73.5, 41.2, -69.8, 42.9]
      }
    : {
        ref: collectionRef ?? "massgis:screening",
        name: "massgis:screening",
        title: "Environmental screening areas",
        geometry_type: catalog ? null : "MultiPolygon",
        bounds: [-73.5, 41.2, -69.8, 42.9]
      };
  const sourceDefinition = catalog
    ? null
    : arcgis
      ? {
          type: "arcgis",
          url: `${payload.service_url.replace(/\/$/, "")}/${collection.ref}`,
          object_id_field: "OBJECTID",
          fields: ["OBJECTID", "name", "screening_score"],
          available_fields: ["OBJECTID", "name", "screening_score"],
          geometry_type: "MultiPolygon",
          page_size: 1000,
          attribution: null,
          requires_field_selection: false,
          excluded_field_count: 0
        }
      : {
          type: "wfs",
          url: payload.service_url,
          version: "2.0.0",
          type_name: collection.ref,
          geometry_name: "geom",
          fields: ["feature_id", "name", "screening_score"],
          available_fields: ["feature_id", "name", "screening_score"],
          sort_by: "feature_id",
          geometry_type: "MultiPolygon",
          page_size: 1000,
          attribution: null,
          requires_field_selection: false,
          requires_sort_confirmation: true,
          excluded_field_count: 0
        };
  return {
    schema_version: "opengeo.external-source-discovery-job.1.0.0",
    job_id: catalog
      ? "7a000000-0000-4000-8000-000000000001"
      : "7a000000-0000-4000-8000-000000000002",
    project_id: projectId,
    source_type: payload.source_type,
    kind: payload.kind,
    service_url: payload.service_url,
    collection_ref: collectionRef,
    request_checksum_sha256: catalog ? "c".repeat(64) : "d".repeat(64),
    idempotency_key: payload.idempotency_key,
    state: "completed",
    result: {
      schema_version: "opengeo.external-source-discovery-result.1.0.0",
      source_type: payload.source_type,
      kind: payload.kind,
      service_url: payload.service_url,
      collections: [collection],
      source_definition: sourceDefinition,
      limitations: catalog
        ? ["Select one layer to inspect its schema and stable paging identity."]
        : ["Review fields, stable identity, rights, and attribution before registration."]
    },
    error_code: null,
    attempt_count: 1,
    created_by: IDS.user,
    created_at: "2026-08-30T12:00:00Z",
    started_at: "2026-08-30T12:00:00Z",
    finished_at: "2026-08-30T12:00:01Z",
    cancellable: false
  };
}

function externalSourcePayload(overrides = {}) {
  return {
    dataset_id: IDS.sourceDataset,
    project_id: IDS.projects[0],
    name: "Public tiles",
    description: null,
    classification: "internal",
    status: "active",
    owner_user_id: IDS.user,
    source_type: "xyz",
    access_mode: "direct_browser",
    credential_mode: "none",
    version_number: 1,
    source_url: "https://tiles.example.test/{z}/{x}/{y}.png",
    configuration: {
      min_zoom: 0,
      max_zoom: 22,
      tile_size: 256,
      scheme: "xyz",
      attribution: null
    },
    verification_state: "syntax_only",
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    capabilities: {read: true, edit: true},
    ...overrides
  };
}

function externalSourceCopyEstimatePayload({
  projectId = IDS.projects[0],
  sourceDatasetId = IDS.sourceDataset,
  sourceRevisionNumber = 1,
  payload = {
    source_type: "wms",
    scope: {kind: "bounded_image", bounds: [-73.5, 42, -70, 43], width: 1024, height: 768}
  }
} = {}) {
  const featureSource = ["arcgis", "wfs"].includes(payload.source_type);
  const pageCount = featureSource
    ? Math.ceil(payload.scope.maximum_features / payload.scope.page_size)
    : 1;
  return {
    schema_version: "opengeo.external-source-copy-estimate.1.0.0",
    estimate_id: IDS.protectedCopyEstimate,
    project_id: projectId,
    source_dataset_id: sourceDatasetId,
    source_revision_number: sourceRevisionNumber,
    source_type: payload.source_type,
    copy_method: payload.source_type === "pmtiles"
      ? "exact_object_copy"
      : featureSource ? "bounded_feature_capture" : "bounded_map_capture",
    capture_scope: payload.source_type === "wms"
      ? {
          kind: payload.scope.kind,
          bounds: payload.scope.bounds,
          width: payload.scope.width,
          height: payload.scope.height
        }
      : payload.scope,
    output_format: payload.source_type === "pmtiles" ? "pmtiles" : featureSource ? "geojson" : "png",
    output_content_type: payload.source_type === "pmtiles"
      ? "application/vnd.pmtiles"
      : featureSource ? "application/geo+json" : "image/png",
    maximum_requests: pageCount,
    maximum_output_bytes: featureSource ? 134_217_728 : 16_777_216,
    estimated_cost_usd: 0.00042,
    estimate_checksum_sha256: "c".repeat(64),
    created_at: "2026-08-28T12:00:00Z",
    expires_at: "2026-08-28T12:15:00Z"
  };
}

function protectedCopyJobPayload({
  projectId = IDS.projects[0],
  sourceDatasetId = IDS.sourceDataset,
  sourceRevisionNumber = 1,
  payload
} = {}) {
  const estimate = externalSourceCopyEstimatePayload({
    projectId,
    sourceDatasetId,
    sourceRevisionNumber,
    payload: browserProtectedCopyEstimateRequests.at(-1)?.payload
  });
  return {
    schema_version: "opengeo.protected-copy-job.1.0.0",
    job_id: IDS.protectedCopyJob,
    project_id: projectId,
    estimate_id: payload.estimate.estimate_id,
    source_dataset_id: sourceDatasetId,
    source_revision_number: sourceRevisionNumber,
    destination_dataset_id: IDS.protectedCopyDataset,
    destination_name: payload.destination.name,
    destination_classification: payload.destination.classification,
    copy_method: estimate.copy_method,
    capture_scope: estimate.capture_scope,
    output_format: estimate.output_format,
    output_content_type: estimate.output_content_type,
    maximum_requests: estimate.maximum_requests,
    maximum_output_bytes: estimate.maximum_output_bytes,
    estimated_cost_usd: estimate.estimated_cost_usd,
    estimate_checksum_sha256: payload.estimate.estimate_checksum_sha256,
    estimate_expires_at: estimate.expires_at,
    rights_basis: payload.rights.basis,
    attribution: payload.rights.attribution,
    request_checksum_sha256: "d".repeat(64),
    idempotency_key: payload.idempotency_key,
    state: "queued",
    output_object_id: null,
    output_dataset_version_id: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-28T12:01:00Z",
    started_at: null,
    finished_at: null,
    cancellable: true
  };
}

function projectImportPayload(overrides = {}) {
  const record = {
    import_id: IDS.projectImport,
    project_id: IDS.projects[0],
    map_id: IDS.maps[0],
    idempotency_key: "95000000-0000-5000-8000-000000000001",
    source_product: "geolibre",
    source_version: "2.6.0",
    source_sha256: "a".repeat(64),
    plan_digest: "b".repeat(64),
    expected_map_version: 1,
    state: "open",
    ready: false,
    unresolved_import_refs: [],
    items: [],
    created_by: IDS.user,
    created_at: "2026-08-19T13:00:00Z",
    updated_at: "2026-08-19T13:00:00Z",
    completed_at: null,
    final_map_version: null,
    ...overrides
  };
  record.ready = record.state === "open" && record.unresolved_import_refs.length === 0;
  return record;
}

function importItemPayload(overrides = {}) {
  return {
    import_ref: "geolibre:embedded",
    kind: "embedded_dataset",
    expected_source_type: "upload",
    expected_format: "geojson",
    candidate: {filename: "embedded.geojson"},
    state: "pending",
    dataset_id: null,
    bound_at: null,
    ...overrides
  };
}

function configurationForSourceDefinition(source) {
  if (source.type === "xyz") {
    return {
      min_zoom: source.min_zoom,
      max_zoom: source.max_zoom,
      tile_size: source.tile_size,
      scheme: source.scheme,
      attribution: source.attribution ?? null,
      ...(source.presentation_role ? {
        presentation_role: source.presentation_role,
        license: source.license,
        coverage_bounds: source.coverage_bounds,
        coordinate_behavior: source.coordinate_behavior
      } : {})
    };
  }
  if (source.type === "wms") {
    return {
      version: source.version,
      layers: source.layers,
      styles: source.styles.length ? source.styles : source.layers.map(() => ""),
      format: source.image_format,
      transparent: source.transparent,
      crs: source.crs,
      tile_size: source.tile_size,
      attribution: source.attribution ?? null
    };
  }
  if (source.type === "arcgis") {
    return {
      object_id_field: source.object_id_field,
      fields: source.fields,
      geometry_type: source.geometry_type,
      page_size: source.page_size,
      attribution: source.attribution ?? null
    };
  }
  if (source.type === "wfs") {
    return {
      version: source.version,
      type_name: source.type_name,
      geometry_name: source.geometry_name,
      fields: source.fields,
      sort_by: source.sort_by,
      geometry_type: source.geometry_type,
      page_size: source.page_size,
      attribution: source.attribution ?? null
    };
  }
  return {
    tile_type: source.tile_type,
    source_layer: source.source_layer,
    geometry_type: source.geometry_type,
    min_zoom: source.min_zoom,
    max_zoom: source.max_zoom,
    attribution: source.attribution ?? null
  };
}

function finalizeBrowserImportDefinition(operation) {
  const definition = structuredClone(operation.request.map_definition);
  const sources = new Map(operation.request.external_sources.map((candidate, index) => [
    candidate.import_ref,
    {candidate, datasetId: IDS.importSourceDatasets[index]}
  ]));
  for (const layer of definition.layers) {
    const source = sources.get(layer.importRef);
    if (source) {
      const configuration = configurationForSourceDefinition(source.candidate.source);
      layer.datasetId = source.datasetId;
      layer.sourceType = source.candidate.source.type === "pmtiles"
        ? `pmtiles-${source.candidate.source.tile_type}`
        : `${source.candidate.source.type}-raster`;
      layer.sourceVersion = 1;
      layer.sourceUrl = source.candidate.source.url;
      layer.sourceConfiguration = browserMapConfiguration(source.candidate.source.type, configuration);
    } else if (layer.importRef === "geolibre:field-sites") {
      layer.datasetId = IDS.importEmbeddedDataset;
      layer.objectId = IDS.importObject;
    }
    delete layer.importRef;
  }
  return definition;
}

function browserMapConfiguration(sourceType, configuration) {
  if (sourceType === "xyz") {
    return {
      minZoom: configuration.min_zoom,
      maxZoom: configuration.max_zoom,
      tileSize: configuration.tile_size,
      scheme: configuration.scheme,
      attribution: configuration.attribution
    };
  }
  if (sourceType === "wms") {
    return {
      version: configuration.version,
      layers: configuration.layers,
      styles: configuration.styles,
      imageFormat: configuration.format,
      transparent: configuration.transparent,
      crs: configuration.crs,
      tileSize: configuration.tile_size,
      attribution: configuration.attribution
    };
  }
  return {
    tileType: configuration.tile_type,
    sourceLayer: configuration.source_layer,
    geometryType: configuration.geometry_type,
    minZoom: configuration.min_zoom,
    maxZoom: configuration.max_zoom,
    attribution: configuration.attribution
  };
}

function datasetVersionPayload(dataset) {
  const documentSchema = dataset.format === "odt" ? {
    kind: "odf_text",
    source_format: "odt",
    odf_version: "1.4",
    page_count: 1,
    block_count: 3,
    text_characters: 42,
    embedded_media_count: 0,
    accessible_preview_schema: "opengeo.document-preview.1.0.0"
  } : dataset.format === "pdf" ? {
    kind: "pdf",
    source_format: "pdf",
    pdf_version: "1.7",
    page_count: 2,
    accessible_preview_schema: "opengeo.document-preview.2.0.0",
    text_extraction: "poppler_pdftotext",
    reading_order: "heuristic",
    ocr_performed: false,
    tagged: true,
    text_available: true,
    text_block_count: 1,
    text_characters: 26
  } : null;
  return {
    id: dataset.current_version_id ?? IDS.version,
    version_number: dataset.current_version_number ?? 1,
    parent_version_id: null,
    state: dataset.current_version_state ?? "active",
    change_message: "Browser-verified logical version",
    feature_count: dataset.feature_count,
    extent: dataset.extent,
    crs: dataset.crs,
    geometry_type: dataset.geometry_type,
    schema_definition: documentSchema === null ? {fields: []} : {document: documentSchema},
    quality_results: dataset.quality_results,
    created_by: dataset.owner_user_id,
    created_at: dataset.updated_at,
    current: true,
    objects: [{
      id: "82000000-0000-4000-8000-000000000099",
      role: "derived",
      filename: ["odt", "pdf"].includes(dataset.format)
        ? "accessible-preview.json"
        : "access-roads.parquet",
      content_type: ["odt", "pdf"].includes(dataset.format)
        ? "application/json"
        : "application/vnd.apache.parquet",
      size_bytes: 4096,
      checksum_sha256: "a".repeat(64),
      created_at: dataset.updated_at
    }]
  };
}

function documentPreviewPayload() {
  return {
    schemaVersion: "opengeo.document-preview.1.0.0",
    sourceFormat: "odt",
    odfVersion: "1.4",
    title: "नेपाल field report",
    language: "ne",
    pages: [{
      number: 1,
      blocks: [
        {type: "heading", level: 1, text: "Findings"},
        {type: "paragraph", text: "Exact semantic preview text."},
        {
          type: "table",
          label: "Results",
          headerRows: 1,
          rows: [["Place", "Count"], ["Kathmandu", "7"]]
        }
      ]
    }]
  };
}

function pdfDocumentPreviewPayload() {
  return {
    schemaVersion: "opengeo.document-preview.2.0.0",
    sourceFormat: "pdf",
    pdfVersion: "1.7",
    title: "Investigation PDF",
    language: "en-US",
    extraction: {
      engine: "poppler-pdftotext",
      mode: "layout",
      ocrPerformed: false,
      readingOrder: "heuristic",
      tagged: true,
      textAvailable: true
    },
    pages: [
      {
        number: 1,
        blocks: [{type: "paragraph", text: "Exact first-page PDF text."}]
      },
      {number: 2, blocks: []}
    ]
  };
}

function datasetPermissionPayload(overrides = {}) {
  return {
    user_id: IDS.member,
    email: "member@opengeo.tools",
    display_name: "Browser Member",
    role: "view",
    granted_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function browserDownloadTicket() {
  const parameters = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "browser-credential",
    "X-Amz-Date": "20260819T120000Z",
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
    "X-Amz-Signature": "a".repeat(64),
    "response-content-disposition": 'attachment; filename="access-roads.parquet"',
    versionId: "browser-immutable-version"
  });
  return {
    url: `https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/exact/access-roads.parquet?${parameters}`,
    method: "GET",
    expires_at: "2099-08-19T12:05:00Z"
  };
}

function browserUploadInstructions() {
  return {
    url: "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools",
    method: "POST",
    fields: {
      key: "organizations/org/projects/project/datasets/data/uploads/upload/original/browser-roads.geojson",
      "Content-Type": "application/geo+json",
      "x-amz-checksum-sha256": "checksum",
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:us-east-1:123456789012:key/browser",
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": "credential",
      "x-amz-date": "20260819T120000Z",
      policy: "policy",
      "x-amz-signature": "signature",
      "x-amz-security-token": "session-token"
    }
  };
}

function pageSourceUploadInstructionsPayload() {
  return {
    ...browserUploadInstructions(),
    url: "https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
    fields: {
      ...browserUploadInstructions().fields,
      key: `organizations/${IDS.organization}/projects/${IDS.projects[0]}/pages/${IDS.resource}/versions/2/uploads/${IDS.upload}/source.md`,
      "Content-Type": "text/markdown"
    }
  };
}

function observableSourceUploadInstructionsPayload(payload, uploadId) {
  return {
    ...browserUploadInstructions(),
    url: "https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
    fields: {
      ...browserUploadInstructions().fields,
      key: `organizations/${IDS.organization}/projects/${IDS.projects[0]}/source-projects/${IDS.sourceProject}/uploads/${uploadId}/files/${payload.relative_path}`,
      "Content-Type": payload.content_type,
      "x-amz-checksum-sha256": payload.checksum_sha256
    }
  };
}

function pageSourcePayload(overrides = {}) {
  return {
    id: IDS.resourceVersion,
    resource_id: IDS.resource,
    resource_version_id: IDS.resourceVersion,
    resource_version_number: 2,
    parent_version_number: 1,
    source_block_id: "introduction",
    bucket: "source.opengeo.tools",
    object_key: `organizations/${IDS.organization}/projects/${IDS.projects[0]}/pages/${IDS.resource}/versions/2/uploads/${IDS.upload}/source.md`,
    s3_version_id: "browser-page-source-version",
    etag: "browser-page-source-etag",
    content_type: "text/markdown",
    size_bytes: 18,
    checksum_sha256: "a".repeat(64),
    dialect: "opengeo-markdown",
    dialect_version: "1.0.0",
    compiler_version: "opengeo-page-renderer-1.1.0",
    change_summary: "Verify browser-safe page source",
    created_by: IDS.user,
    created_at: "2026-08-22T12:00:00Z",
    source_markdown: null,
    ...overrides
  };
}

async function readRequestJson(request) {
  const text = await readRequestText(request);
  return text ? JSON.parse(text) : null;
}

async function readRequestText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function writeJson(response, status, payload, requestId) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "X-Request-ID": requestId,
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function routeFile(url) {
  const {pathname} = new URL(url, "http://localhost");
  const decoded = decodeURIComponent(pathname);
  const candidates = decoded === "/"
    ? ["index.html"]
    : extname(decoded)
      ? [decoded.slice(1)]
      : [`${decoded.slice(1)}.html`, join(decoded.slice(1), "index.html")];

  for (const candidate of candidates) {
    const filePath = resolve(distRoot, normalize(candidate));
    if (filePath.startsWith(distRoot) && existsSync(filePath)) return filePath;
  }

  return null;
}

function contentType(filePath) {
  const extension = extname(filePath);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json" || extension === ".geojson") return "application/json; charset=utf-8";
  if (extension === ".csv") return "text/csv; charset=utf-8";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

function flattenPages(pages) {
  return pages.flatMap((page) => page.pages ? flattenPages(page.pages) : [page.path]);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(httpServer) {
  return new Promise((resolvePromise, reject) => {
    httpServer.close((error) => error ? reject(error) : resolvePromise());
  });
}

function chromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ].filter(Boolean);

  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? {executablePath} : {};
}
