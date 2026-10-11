import {isRendererHostHtml} from "./application-route-inventory.mjs";
import {prepareCesiumRuntime} from "./prepare-cesium-runtime.mjs";
import {prepareMapboxRuntime} from "./prepare-mapbox-runtime.mjs";
import {writeMaplibreExportAssets, prepareMapWorkerAsset} from "./build-maplibre-render-bundle.mjs";
import {spawnSync} from "node:child_process";
import {constants} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";

import {
  assertPublicArtifactBoundary,
  sealManifest,
  sha256,
  snapshotTree,
  writeJson
} from "./release-utils.mjs";
import {writeStudioPwaAssets} from "./studio-pwa-assets.mjs";
import {buildPublicationEditor} from "./build-publication-editor.mjs";

const DEMO_ORIGIN = "https://demo.studio.opengeo.tools";
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const sourceRoot = resolve(appRoot, "dist/demo-source");
const outputRoot = resolve(appRoot, "dist/demo-build");
const manifestPath = resolve(workspaceRoot, "dist/opengeo-demo-build.json");

await Promise.all([
  rm(sourceRoot, {recursive: true, force: true}),
  rm(outputRoot, {recursive: true, force: true})
]);
await stageDemoSource();
const sourceTree = await snapshotTree(sourceRoot);
const sharedCacheRoot = resolve(appRoot, "src/.observablehq/cache");
const demoCacheRoot = resolve(sourceRoot, ".observablehq/cache");
await copyDirectoryStructure(sharedCacheRoot, demoCacheRoot);
await copyTree(sharedCacheRoot, demoCacheRoot);
await prepareMapWorkerAsset(sourceRoot);
try {
  runObservableBuild();
} finally {
  await rm(resolve(sourceRoot, ".observablehq"), {recursive: true, force: true});
}
// Same pinned editor and local compilers as Studio; no authentication assets.
// Publications load these optional assets only when an anonymous draft opens.
await buildPublicationEditor(outputRoot);
const pwa = await writeStudioPwaAssets({
  outputRoot,
  applicationId: "opengeo-browser-demo",
  name: "OpenGeo Studio GIS Workbench Demo",
  description: "An anonymous browser-only geospatial workbench with nonpersistent local editing.",
  routes: ["/"]
});

await writeMaplibreExportAssets(outputRoot);
await prepareMapboxRuntime(outputRoot);
await prepareCesiumRuntime(outputRoot);
await writeFile(resolve(outputRoot, "third-party-notices.txt"), [
  "@categori/workspace-contracts · Apache-2.0",
  await readFile(resolve(appRoot, "vendor/workspace-contracts/LICENSE"), "utf8"),
  await readFile(resolve(appRoot, "vendor/workspace-contracts/NOTICE"), "utf8")
].join("\n\n"));

const artifactTree = await snapshotTree(outputRoot);
const requiredDemoArtifacts = [
  ["MassGIS configuration", /^_file\/data\/massgis-enviroscreen\.[A-Za-z0-9_-]+\.json$/],
  ["MassGIS loader", /^_import\/lib\/massgisDemo\.[A-Za-z0-9_-]+\.js$/],
  ["bounded live feature reader", /^_import\/lib\/liveFeatureSource\.[A-Za-z0-9_-]+\.js$/],
  ["governed browser-platform contract", /^_import\/lib\/browserPlatform\.[A-Za-z0-9_-]+\.js$/],
  ["public demo project model", /^_import\/lib\/publicDemoProject\.[A-Za-z0-9_-]+\.js$/],
  ["anonymous publication workspace", /^_import\/components\/PublicDemoPublication\.[A-Za-z0-9_-]+\.js$/],
  ["native publication editor", /^_import\/components\/PublicationCodeEditor\.[A-Za-z0-9_-]+\.js$/],
  ["publication editor asset manifest", /^editor-assets\/manifest\.json$/],
  ["saved path measurement", /^_import\/lib\/pathMeasurement\.[A-Za-z0-9_-]+\.js$/],
  ["saved area measurement", /^_import\/lib\/areaMeasurement\.[A-Za-z0-9_-]+\.js$/],
  ["saved measurement collection", /^_import\/lib\/savedMeasurement\.[A-Za-z0-9_-]+\.js$/],
  ["layer-order model", /^_import\/lib\/layerOrder\.[A-Za-z0-9_-]+\.js$/],
  ["thematic styling", /^_import\/lib\/thematicStyle\.[A-Za-z0-9_-]+\.js$/]
];
for (const [label, pattern] of requiredDemoArtifacts) {
  if (!artifactTree.files.some(({path}) => pattern.test(path))) {
    throw new Error(`Dedicated demo build is missing its reviewed ${label} artifact`);
  }
}
const html = artifactTree.files.filter(({path}) => path.endsWith(".html") && path !== "offline.html" && !isRendererHostHtml(path));
if (html.length !== 1 || html[0].path !== "index.html") {
  throw new Error("Demo build must contain exactly one root index.html page");
}
const demoHome = await readFile(resolve(outputRoot, "index.html"), "utf8");
if (!/_observablehq\/theme-near-midnight,wide\.[0-9a-f]+\.css/.test(demoHome)
  || /_observablehq\/theme-air,/.test(demoHome)) {
  throw new Error("Demo does not use the same single Observable near-midnight palette as Studio");
}
assertPublicArtifactBoundary(
  artifactTree.files.map(({path}) => path),
  "Dedicated workbench demo",
  {allowWorkbenchDemo: true}
);
for (const forbidden of ["auth-config.json", "login.html", "admin.html", "workspaces.html"]) {
  if (artifactTree.files.some(({path}) => path === forbidden)) {
    throw new Error(`Dedicated demo contains a private Studio artifact: ${forbidden}`);
  }
}

const configuration = await Promise.all([
  "app/observablehq.config.js",
  "app/scripts/demo.observablehq.config.mjs",
  "app/package.json",
  "app/package-lock.json"
].map(async (path) => {
  const body = await readFile(resolve(workspaceRoot, path));
  return {path, bytes: body.length, sha256: sha256(body)};
}));
const manifest = sealManifest({
  schemaVersion: "opengeo.demo-build.1.0.0",
  demoOrigin: DEMO_ORIGIN,
  framework: "@observablehq/framework@1.13.4",
  source: {
    kind: "reviewed-browser-only-workbench",
    configuration,
    sourceTree
  },
  artifactTree,
  routes: [{
    path: "/",
    htmlPath: "index.html",
    bytes: html[0].bytes,
    sha256: html[0].sha256,
    aliases: []
  }],
  aliases: []
});
await writeJson(manifestPath, manifest);

console.log(JSON.stringify({
  outputRoot,
  manifestPath,
  files: artifactTree.files.length,
  htmlPages: 1,
  aliases: 0,
  pwaCache: pwa.cacheName,
  pwaShellBytes: pwa.shellBytes,
  observableTheme: "near-midnight",
  treeDigest: artifactTree.digest
}, null, 2));

function runObservableBuild() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, [
    "exec", "--", "observable", "build", "--config", "scripts/demo.observablehq.config.mjs"
  ], {cwd: appRoot, stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function stageDemoSource() {
  const paths = [
    ["../demo/index.md", "index.md"],
    ["style.css", "style.css"],
    ["components/PublicDemoWorkbench.js", "components/PublicDemoWorkbench.js"],
    ["components/PublicDemoPublication.js", "components/PublicDemoPublication.js"],
    ["components/PublicationCodeEditor.js", "components/PublicationCodeEditor.js"],
    ["components/PublicationCommands.js", "components/PublicationCommands.js"],
    ["components/PublicationPanels.js", "components/PublicationPanels.js"],
    ["components/SourceFileExplorer.js", "components/SourceFileExplorer.js"],
    ["components/ObservableNotebookPreview.js", "components/ObservableNotebookPreview.js"],
    ["components/NotebookCellEditor.js", "components/NotebookCellEditor.js"],
    ["components/FrameworkDraftPreview.js", "components/FrameworkDraftPreview.js"],
    ["lib/publicationDrafts.js", "lib/publicationDrafts.js"],
    ["components/StaticItemSearch.js", "components/StaticItemSearch.js"],
    ["lib/staticItemSearch.js", "lib/staticItemSearch.js"],
    ["lib/providerJson.js", "lib/providerJson.js"],
    ["lib/cogMapLayer.js", "lib/cogMapLayer.js"],
    ["lib/cogPreview.js", "lib/cogPreview.js"],
    ["lib/cogReaderAsset.js", "lib/cogReaderAsset.js"],
    ["assets/cog-reader-3.1.0-beta.0.js.js", "assets/cog-reader-3.1.0-beta.0.js.js"],
    ["assets/licenses/geotiff-3.1.0-beta.0.LICENSE.txt", "assets/licenses/geotiff-3.1.0-beta.0.LICENSE.txt"],
    ["lib/projectFileFormat.js", "lib/projectFileFormat.js"],
    ["components/ProjectVersionExport.js", "components/ProjectVersionExport.js"],
    ["components/WorkbenchView.js", "components/WorkbenchView.js"],
    ["components/RendererPanel.js", "components/RendererPanel.js"],
    ["components/LayerFolders.js", "components/LayerFolders.js"],
    ["components/LayerInfo.js", "components/LayerInfo.js"],
    ["components/PatternLegend.js", "components/PatternLegend.js"],
    ["lib/cartographicPatterns.js", "lib/cartographicPatterns.js"],
    ["lib/featureHalo.js", "lib/featureHalo.js"],
    ["lib/cesiumAdapter.js", "lib/cesiumAdapter.js"],
    ["lib/cesiumBasemap.js", "lib/cesiumBasemap.js"],
    ["lib/cesiumFrame.js", "lib/cesiumFrame.js"],
    ["lib/cesiumFrameHost.js", "lib/cesiumFrameHost.js"],
    ["lib/cesiumLabelAnchors.js", "lib/cesiumLabelAnchors.js"],
    ["lib/cesiumLabelLayout.js", "lib/cesiumLabelLayout.js"],
    ["lib/cesiumLabels.js", "lib/cesiumLabels.js"],
    ["lib/cesiumLayers.js", "lib/cesiumLayers.js"],
    ["lib/cesiumLoader.js", "lib/cesiumLoader.js"],
    ["lib/cesiumRuntime.js", "lib/cesiumRuntime.js"],
    ["lib/cesiumStyle.js", "lib/cesiumStyle.js"],
    ["lib/cesiumStyleAdmission.js", "lib/cesiumStyleAdmission.js"],
    ["lib/cesiumWorkbench.js", "lib/cesiumWorkbench.js"],
    ["lib/mapboxSession.js", "lib/mapboxSession.js"],
    ["lib/mapboxAdapter.js", "lib/mapboxAdapter.js"],
    ["lib/mapboxLoader.js", "lib/mapboxLoader.js"],
    ["lib/mapboxRuntime.js", "lib/mapboxRuntime.js"],
    ["lib/rendererSwitch.js", "lib/rendererSwitch.js"],
    ["components/LayerArchiveControl.js", "components/LayerArchiveControl.js"],
    ["lib/layerArchiveRead.js", "lib/layerArchiveRead.js"],
    ["lib/whenConnected.js", "lib/whenConnected.js"],
    ["lib/reviewedDisplayIdentity.js", "lib/reviewedDisplayIdentity.js"],
    ["lib/reviewedArchiveRange.js", "lib/reviewedArchiveRange.js"],
    ["lib/reviewedArchiveTiles.js", "lib/reviewedArchiveTiles.js"],
    ["lib/reviewedArchivePresentation.js", "lib/reviewedArchivePresentation.js"],
    ["lib/reviewedArchiveLayerRanges.js", "lib/reviewedArchiveLayerRanges.js"],
    ["lib/reviewedRasterOverview.js", "lib/reviewedRasterOverview.js"],
    ["lib/browserProjectFile.js", "lib/browserProjectFile.js"],
    ["components/BrowserLayerRegistration.js", "components/BrowserLayerRegistration.js"],
    ["components/LayerStylePicker.js", "components/LayerStylePicker.js"],
    ["lib/layerStyleReference.js", "lib/layerStyleReference.js"],
    ["lib/artifactCanonicalJson.js", "lib/artifactCanonicalJson.js"],
    ["lib/legacyCanonicalJson.js", "lib/legacyCanonicalJson.js"],
    ["lib/portableMapArtifact.js", "lib/portableMapArtifact.js"],
    ["components/StudioNavigation.js", "components/StudioNavigation.js"],
    ["components/StaticMapExport.js", "components/StaticMapExport.js"],
    ["components/StudioAccountControls.js", "components/StudioAccountControls.js"],
    ["lib/staticMapExport.js", "lib/staticMapExport.js"],
    ["lib/imageServer.js", "lib/imageServer.js"],
    ["lib/mapServer.js", "lib/mapServer.js"],
    ["lib/mapGraticule.js", "lib/mapGraticule.js"],
    ["components/ImageOverlayEditor.js", "components/ImageOverlayEditor.js"],
    ["components/ShapeEditor.js", "components/ShapeEditor.js"],
    ["components/ResizablePanels.js", "components/ResizablePanels.js"],
    ["components/CameraControls.js", "components/CameraControls.js"],
    ["components/EsriBasemapOptions.js", "components/EsriBasemapOptions.js"],
    ["lib/esriBasemaps.js", "lib/esriBasemaps.js"],
    ["lib/webMapContext.js", "lib/webMapContext.js"],
    ["lib/imageOverlayEditing.js", "lib/imageOverlayEditing.js"],
    ["lib/mapAuthoringPreview.js", "lib/mapAuthoringPreview.js"],
    ["lib/shapeEditing.js", "lib/shapeEditing.js"],
    ["lib/loadedLayerInstallation.js", "lib/loadedLayerInstallation.js"],
    ["lib/mapFonts.js", "lib/mapFonts.js"],
    ["lib/mapFontAttachments.js", "lib/mapFontAttachments.js"],
    ["lib/archivedGeojson.js", "lib/archivedGeojson.js"],
    ["lib/liveFeatureSource.js", "lib/liveFeatureSource.js"],
    ["lib/browserPlatform.js", "lib/browserPlatform.js"],
    ["lib/basemapActivation.js", "lib/basemapActivation.js"],
    ["lib/basemapCatalog.js", "lib/basemapCatalog.js"],
    ["lib/basemapGovernance.js", "lib/basemapGovernance.js"],
    ["lib/basemapRuntimeHealth.js", "lib/basemapRuntimeHealth.js"],
    ["lib/basemapSource.js", "lib/basemapSource.js"],
    ["lib/reviewedBasemapSources.js", "lib/reviewedBasemapSources.js"],
    ["lib/geolibreProject.js", "lib/geolibreProject.js"],
    ["lib/geomooseMapbook.js", "lib/geomooseMapbook.js"],
    ["lib/portalConfiguration.js", "lib/portalConfiguration.js"],
    ["lib/portalCatalog.js", "lib/portalCatalog.js"],
    ["lib/applicationRoutes.js", "lib/applicationRoutes.js"],
    ["lib/mapDefinition.js", "lib/mapDefinition.js"],
    ["lib/mapFilter.js", "lib/mapFilter.js"],
    ["lib/layerFieldDependencies.js", "lib/layerFieldDependencies.js"],
    ["components/MapFilterEditor.js", "components/MapFilterEditor.js"],
    ["components/LayerVersionPicker.js", "components/LayerVersionPicker.js"],
    ["lib/mapLayers.js", "lib/mapLayers.js"],
    ["lib/mapRenderer.js", "lib/mapRenderer.js"],
    ["lib/glRendererAdapter.js", "lib/glRendererAdapter.js"],
    ["lib/maplibreAdapter.js", "lib/maplibreAdapter.js"],
    ["lib/mapRendererWorker.js", "lib/mapRendererWorker.js"],
    ["assets/maplibre-worker.js.js", "assets/maplibre-worker.js.js"],
    ["lib/layerOrder.js", "lib/layerOrder.js"],
    ["lib/layerOpacity.js", "lib/layerOpacity.js"],
    ["lib/massgisDemo.js", "lib/massgisDemo.js"],
    ["lib/managedUpload.js", "lib/managedUpload.js"],
    ["lib/temporaryAnnotations.js", "lib/temporaryAnnotations.js"],
    ["lib/publicDemoProject.js", "lib/publicDemoProject.js"],
    ["lib/browserCatalogRestore.js", "lib/browserCatalogRestore.js"],
    ["lib/browserLayerCatalogStore.js", "lib/browserLayerCatalogStore.js"],
    ["lib/publicationPolicy.js", "lib/publicationPolicy.js"],
    ["lib/processingRegistry.js", "lib/processingRegistry.js"],
    ["lib/featureQuery.js", "lib/featureQuery.js"],
    ["lib/governedIdentify.js", "lib/governedIdentify.js"],
    ["lib/spatialBody.js", "lib/spatialBody.js"],
    ["lib/thematicStyle.js", "lib/thematicStyle.js"],
    ["lib/workspaceUiState.js", "lib/workspaceUiState.js"],
    ["lib/workbenchConfig.js", "lib/workbenchConfig.js"],
    ["lib/workbenchStorage.js", "lib/workbenchStorage.js"],
    ["lib/globeView.js", "lib/globeView.js"],
    ["lib/terrainView.js", "lib/terrainView.js"],
    ["lib/terrainGovernance.js", "lib/terrainGovernance.js"],
    ["lib/openScene3d.js", "lib/openScene3d.js"],
    ["lib/historicalImagery.js", "lib/historicalImagery.js"],
    ["lib/cameraTour.js", "lib/cameraTour.js"],
    ["lib/flightSimulation.js", "lib/flightSimulation.js"],
    ["lib/pathMeasurement.js", "lib/pathMeasurement.js"],
    ["lib/areaMeasurement.js", "lib/areaMeasurement.js"],
    ["lib/savedMeasurement.js", "lib/savedMeasurement.js"],
    ["lib/globeTelemetry.js", "lib/globeTelemetry.js"],
    ["lib/globeInteraction.js", "lib/globeInteraction.js"],
    ["lib/kmlPlaces.js", "lib/kmlPlaces.js"],
    ["lib/kmlNetworkLink.js", "lib/kmlNetworkLink.js"],
    ["lib/spatialInterchange.js", "lib/spatialInterchange.js"],
    ["lib/archiveLayerExport.js", "lib/archiveLayerExport.js"],
    ["data/massgis-enviroscreen.json", "data/massgis-enviroscreen.json"],
    ["data/public-demo-catalog.json", "data/public-demo-catalog.json"],
    ["data/sample-public-facilities.geojson", "data/sample-public-facilities.geojson"]
  ];
  for (const [sourcePath, destinationPath] of paths) {
    const source = resolve(appRoot, "src", sourcePath);
    const destination = resolve(sourceRoot, destinationPath);
    await mkdir(dirname(destination), {recursive: true});
    await copyPreservingTimes(source, destination);
  }
  // Package the shared capture form's reachable code behind the anonymous entry.
  // Do not copy authenticated directory/routes into the public surface. Existing
  // staged map modules remain shared rather than bundling another renderer.
  const entry = resolve(appRoot, "src/components/PublicDemoCapture.js");
  const shared = new Set(paths.map(([path]) => resolve(appRoot, "src", path)));
  const capture = await build({entryPoints: [entry], bundle: true, format: "esm",
    platform: "browser", write: false, treeShaking: true, plugins: [{name: "shared-demo-modules", setup(builder) {
      builder.onResolve({filter: /^\.\.?\//}, args => {
        const path = resolve(args.resolveDir, args.path);
        if (shared.has(path)) return {path: relative(dirname(entry), path).replace(/^(?!\.)/, "./"), external: true};
      });
    }}]});
  const captureCode = capture.outputFiles[0].text;
  if (Buffer.byteLength(captureCode) > 2 * 1024 * 1024
    || /class OpenGeoApiClient|class CognitoBrowserAuth|\/oauth2\/token/.test(captureCode)) {
    throw new Error("Public capture bundle exceeds its size or authentication boundary");
  }
  await writeFile(resolve(sourceRoot, "components/PublicDemoCapture.js"), captureCode);
  const fontSource = resolve(appRoot, "src/assets/render-fonts");
  const fontDestination = resolve(sourceRoot, "assets/render-fonts");
  await mkdir(fontDestination, {recursive: true});
  await copyTree(fontSource, fontDestination);
}

async function copyDirectoryStructure(source, destination) {
  await mkdir(destination, {recursive: true});
  for (const entry of await readdir(source, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      await copyDirectoryStructure(resolve(source, entry.name), resolve(destination, entry.name));
    }
  }
}

async function copyPreservingTimes(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const info = await stat(source);
  await utimes(destination, info.atime, info.mtime);
}

async function copyTree(source, destination) {
  for (const entry of await readdir(source, {withFileTypes: true})) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, {recursive: true});
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
  }
}
