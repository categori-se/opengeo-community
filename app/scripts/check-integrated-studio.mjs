import {exerciseFieldComparisons} from "./integrated-studio-field-comparisons.mjs";
import assert from "node:assert/strict";
import {localPublicationBridge, processLocalBuildQueue, processLocalPublicationQueue, boundedLocalPublicationReader} from "../../services/observable-coordinator/src/local-adapters.mjs";
import {startLocalPreviewServer} from "../../services/observable-preview/src/local-server.mjs";
import {appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync} from "node:fs";
import {createServer, request as httpRequest} from "node:http";
import {spawn} from "node:child_process";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {chromium} from "playwright";
import {unzipSync} from "fflate";
import {createHash, randomUUID} from "node:crypto";
import {FONT_ROUTE, FONT_LABELS, FONT_LABEL_SIZE, FONT_COMPOSITION_PROBES,
  loadIntegratedStudioFontAssets, integratedStudioFontTransport} from "./integrated-studio-font-mode.mjs";
import {integratedStudioShellMode, loadIntegratedStudioBuild, integratedStudioAuthConfig,
  initializeIntegratedStudioSession} from "./integrated-studio-built-shell.mjs";
import {exerciseServiceClients} from "./integrated-studio-service-clients.mjs";
import {exerciseStudioAnalysis,exerciseBaselineStudy,exerciseBuildingReview,exerciseBuildingInputPreview,assertBuildingInputPreviewRequest,exerciseReceptorScreening,exerciseRasterCatalog,exerciseStacItems,installIntegratedNativeUploadCapture} from "./integrated-studio-analysis.mjs";
import {exerciseStudioWcs} from "./integrated-studio-wcs.mjs";
import {localObjectDownload} from "./integrated-studio-object-transport.mjs";
import {exerciseManagedConversion} from "./integrated-studio-conversion.mjs";
import {exerciseStudioAccess} from "./integrated-studio-access.mjs";
import {createLocalAnalysisBridge, loadLocalAnalysisRunner} from "./integrated-studio-analysis-runner.mjs";
import {loadPublicationSecurityReconciliation,validatePublicationSecurityResume} from "./integrated-studio-publication.mjs";

const work = resolve(process.argv[2] ?? "");
const {built:builtStudio, pinnedFonts:pinnedFontMode, restore:restoreCheckpoint,serviceClients:allServicesMode,wcsOnly:wcsOnlyMode,analysisOnly:analysisOnlyMode,development:developmentMode,publicationOnly:publicationOnlyMode} = integratedStudioShellMode(process.argv.slice(3));
const serviceClientsMode=allServicesMode||wcsOnlyMode;
const rendererPersistenceMode=process.env.OPENGEO_RENDERER_PERSISTENCE_ONLY === "1";
const geolibreImportMode=process.env.OPENGEO_GEOLIBRE_IMPORT_ONLY === "1";
const publicationSecurityOnly=process.env.OPENGEO_PUBLICATION_SECURITY_ONLY === "1";
const catalogStudyMode=process.env.OPENGEO_PUBLICATION_CATALOG_STUDY_ONLY === "1";
const mapArtifactMode=process.env.OPENGEO_PUBLICATION_MAP_ARTIFACT_ONLY === "1";
const publicationSecurityReconciliationPin=process.env.OPENGEO_PUBLICATION_SECURITY_RECONCILED;
if(publicationSecurityReconciliationPin!==undefined)assert.ok(publicationSecurityOnly,
  'Reconciled security acceptance requires the exact retained security-only mode.');
if(publicationSecurityOnly)assert.ok(publicationOnlyMode&&developmentMode&&!builtStudio,
  "Publication security acceptance requires the retained development publication-only mode.");
if(mapArtifactMode)assert.ok(publicationOnlyMode&&developmentMode&&!builtStudio&&!publicationSecurityOnly&&!catalogStudyMode,
  "Map Artifact acceptance requires only the retained local publication mode.");
if(catalogStudyMode)assert.ok(publicationOnlyMode&&developmentMode&&!builtStudio&&!publicationSecurityOnly,
  "Catalog study acceptance requires only the existing local publication mode.");
if (rendererPersistenceMode || geolibreImportMode) assert.ok(builtStudio && !pinnedFontMode && !restoreCheckpoint && !serviceClientsMode && !analysisOnlyMode);
assert.ok(!(rendererPersistenceMode && geolibreImportMode), "Choose one scoped renderer journey");
if (developmentMode) assert.equal(JSON.parse(readFileSync(join(work,"development-state.json"))).schemaVersion,"opengeo.community-development.1");
else assert.match(work, /^\/tmp\/opengeo-integrated-studio-[A-Za-z0-9_-]+$/);
assert.ok(existsSync(join(work, "api.sock")), "Run through the isolated Python orchestrator");
const root = fileURLToPath(new URL("../../", import.meta.url));
const builtShell = builtStudio ? await loadIntegratedStudioBuild(work) : null;
const builtRequests = [];
const fontAssets = pinnedFontMode ? loadIntegratedStudioFontAssets(root) : null;
const fontRequests = [];
const fontProof = pinnedFontMode ? {enabled: true, fontRef: fontAssets.fontRef,
  assets: fontAssets.evidence, maplibre: fontAssets.maplibre, labels: FONT_LABELS, labelSize: FONT_LABEL_SIZE} : null;
if (pinnedFontMode) {
  const manifest = readFileSync(join(work, "font-runtime-manifest.json"));
  fontProof.runtimeReference = {schemaVersion:"opengeo.render-runtime-reference.1.0.0",
    manifestSha256:createHash("sha256").update(manifest).digest("hex"),
    architecture:JSON.parse(manifest).architecture};
}
const organization = "10000000-0000-4000-8000-000000000001";
const uploadUrl = "https://s3.us-east-1.amazonaws.com/local-pilot.invalid";
const requests = [];
const receptorScreeningMode=process.env.OPEN_GEO_INTEGRATED_RECEPTOR_SCREENING==='1';
const buildingInputPreviewMode=process.env.OPEN_GEO_INTEGRATED_BUILDING_INPUT_PREVIEW==='1';
const realBuildingReviewMode=process.env.OPEN_GEO_INTEGRATED_BUILDING_REAL_REVIEW==='1';
const stacItemsMode=process.env.OPEN_GEO_INTEGRATED_STAC_ITEMS==='1';
const rasterCatalogMode=process.env.OPEN_GEO_INTEGRATED_RASTER_CATALOG==='1';
const rasterValidationMode=process.env.OPEN_GEO_INTEGRATED_RASTER_VALIDATION==='1';
const rasterAccountMode=rasterCatalogMode||rasterValidationMode;
assert.ok([realBuildingReviewMode,buildingInputPreviewMode,stacItemsMode,rasterCatalogMode,rasterValidationMode,receptorScreeningMode,process.env.OPEN_GEO_INTEGRATED_BUILDING_REVIEW==='1'].filter(Boolean).length<=1,'Choose one scoped account journey');
// Account profiles share transport, guard, worker and shutdown machinery.
const buildingReviewMode=realBuildingReviewMode||buildingInputPreviewMode||process.env.OPEN_GEO_INTEGRATED_BUILDING_REVIEW==='1'||receptorScreeningMode||rasterAccountMode||stacItemsMode;
const buildingReviewPrefix=realBuildingReviewMode?'building-real-review':buildingInputPreviewMode?'building-input-preview':stacItemsMode?'stac-items':rasterValidationMode?'raster-validation':rasterCatalogMode?'raster-catalog':receptorScreeningMode?'receptor-screening':'building-review';
const buildingInputKeys=stacItemsMode||rasterAccountMode?[]:receptorScreeningMode?['receptors','footprint','influence']:['source','comparison'];
const buildingApiLimit=buildingInputPreviewMode?80:stacItemsMode?140:rasterValidationMode?260:rasterCatalogMode?240:receptorScreeningMode?180:160,buildingUploadLimit=buildingInputPreviewMode?0:stacItemsMode?0:rasterValidationMode?1:rasterCatalogMode?2:receptorScreeningMode?4:3;
const buildingReviewPath=join(work,`${buildingReviewPrefix}-progress.json`);
const buildingReviewProfile=buildingReviewMode?JSON.parse(readFileSync(join(work,`${buildingReviewPrefix}-profile.json`))):null;
const buildingReviewProgress=buildingReviewMode?JSON.parse(readFileSync(buildingReviewPath)):null;
const buildingReviewRemaining=()=>(stacItemsMode||buildingInputPreviewMode?110_000:realBuildingReviewMode||receptorScreeningMode||rasterAccountMode?170_000:180_000)-(buildingReviewProfile?.priorMilliseconds??0)
  -(Date.now()-(buildingReviewProfile?.startedAtMilliseconds??Date.now()));
function checkpointBuildingReview(update={}){
  if(!buildingReviewMode)return;
  Object.assign(buildingReviewProgress,update);
  writeFileSync(buildingReviewPath,JSON.stringify(buildingReviewProgress,null,2)+'\n',{mode:0o600});
}
if(buildingReviewMode){
  assert.ok(developmentMode&&builtStudio&&!analysisOnlyMode&&!publicationOnlyMode&&!serviceClientsMode&&!pinnedFontMode
    &&!restoreCheckpoint&&!rendererPersistenceMode&&!geolibreImportMode&&!publicationSecurityOnly&&!catalogStudyMode&&!mapArtifactMode,
    'Building review uses only the retained built development journey');
  assert.equal(buildingReviewProfile.schemaVersion,`opengeo.integrated-${buildingReviewPrefix}.1`);
  assert.equal(buildingReviewProfile.maximumApiRequests,buildingApiLimit);assert.equal(buildingReviewProfile.maximumMilliseconds,stacItemsMode||buildingInputPreviewMode?120_000:180_000);
  if(realBuildingReviewMode){
    assert.equal(buildingReviewProfile.admissionBatchId,'BI-02-07-real-building-account-review');
    assert.equal(buildingReviewProfile.inputPairSha256,buildingReviewProgress.inputPairSha256);
    assert.equal(buildingReviewProfile.maximumOriginalUploads,3);assert.equal(buildingReviewProfile.maximumWorkerBatches,2);
    assert.equal(buildingReviewProfile.maximumNativeComparisons,1);assert.ok(buildingReviewProfile.admittedAttempt<=2);
    assert.deepEqual(Object.keys(buildingReviewProfile.inputProfile.inputs).sort(),['comparison','source']);
    assert.equal(createHash('sha256').update(readFileSync(join(work,'building-review-progress.json'))).digest('hex'),buildingReviewProfile.acceptedSyntheticReceiptSha256);
  }
  if(buildingInputPreviewMode){
    assert.equal(buildingReviewProfile.admissionBatchId,'BI-02-retained-building-input-preview');
    for(const [key,value] of Object.entries({maximumWorkMilliseconds:110_000,shutdownReserveMilliseconds:10_000,
      maximumOriginalUploads:0,maximumWorkerBatches:0,maximumNativeComputations:0,maximumOriginalReadbacks:6,maximumOriginalReadbackBytes:20_000}))assert.equal(buildingReviewProfile[key],value);
    assert.ok(buildingReviewProfile.admittedAttempt<=2);
    for(const key of ['projectId','mapId','map','records'])assert.deepEqual(buildingReviewProgress[key],buildingReviewProfile[key]);
    const accepted=readFileSync(join(work,'building-review-progress.json'));
    assert.equal(createHash('sha256').update(accepted).digest('hex'),buildingReviewProfile.acceptedBuildingReceiptSha256);
  }
  if(stacItemsMode){
    assert.equal(buildingReviewProfile.admissionBatchId,'BI-03-external-stac-item-assets');
    for(const [key,value] of Object.entries({maximumWorkMilliseconds:110_000,shutdownReserveMilliseconds:10_000,maximumCatalogReferences:1,maximumProjectCompositions:1,maximumIngestionJobs:0,maximumWorkerBatches:0,maximumNativeComputations:0,maximumRetainedRasterRanges:6,maximumRetainedRasterBytes:1769472,maximumMetadataFixtureReplays:2}))assert.equal(buildingReviewProfile[key],value);
    assert.deepEqual(buildingReviewProgress.source,buildingReviewProfile.source);assert.ok(buildingReviewProfile.admittedAttempt<=3);
    if(buildingReviewProfile.admittedAttempt===3){assert.equal(buildingReviewProfile.readOnlyProjectRemainder,true);
      assert.equal(buildingReviewProgress.record?.datasetId,'10ff7941-cdcc-4521-8445-c1fd8048ee5e');
      assert.equal(buildingReviewProgress.mapId,'7d5b4d46-1fbd-491b-b90e-edd9d051d7d1');}
  }
  if(receptorScreeningMode){
    assert.equal(buildingReviewProfile.admissionBatchId,'BI-05-main-account-receptor-screening');
    for(const [key,value] of Object.entries({maximumWorkMilliseconds:170_000,maximumOriginalUploads:4,
      maximumWorkerBatches:2,maximumNativeClips:2,maximumNativeCollections:3,maximumOriginalArchiveReadbacks:1}))assert.equal(buildingReviewProfile[key],value);
    assert.ok(buildingReviewProfile.admittedAttempt<=2);
    assert.ok(Object.keys(buildingReviewProgress.records??{}).every(key=>[...buildingInputKeys,'output'].includes(key)));
  }
  if(rasterAccountMode){
    assert.equal(buildingReviewProfile.admissionBatchId,rasterValidationMode?'BI-07-stratified-validation':'BI-04-07-raster-output-catalog');
    for(const [key,value] of Object.entries({maximumWorkMilliseconds:170_000,shutdownReserveMilliseconds:10_000,
      maximumOriginalUploads:buildingUploadLimit,maximumWorkerBatches:1,maximumNativeComputations:0,maximumOriginalArchiveReadbacks:rasterValidationMode?1:2,
      maximumCogRangeRequests:rasterValidationMode?4:8,maximumCogRangeBytes:rasterValidationMode?3240:6480,maximumArchiveReadbackBytes:rasterValidationMode?1_048_576:4_400_000,
      maximumOutputDisplayTickets:rasterValidationMode?2:4,maximumOutputDisplayOriginalReads:rasterValidationMode?2:4,maximumOutputDisplayBytes:rasterValidationMode?2_097_152:305_244}))assert.equal(buildingReviewProfile[key],value);
    assert.ok(buildingReviewProfile.admittedAttempt<=2);
    assert.deepEqual(buildingReviewProgress.source,buildingReviewProfile.source);
    assert.ok(Object.keys(buildingReviewProgress.records??{}).every(key=>(rasterValidationMode?['validation']:['comparison','patches']).includes(key)));
  }
  assert.equal(buildingReviewProfile.appTree,builtShell.evidence.treeDigest,'Use the explicitly admitted sealed Studio tree');
  assert.ok(Number.isSafeInteger(buildingReviewProfile.startedAtMilliseconds)&&Number.isSafeInteger(buildingReviewProfile.priorMilliseconds)
    &&buildingReviewProfile.priorMilliseconds>=0&&buildingReviewRemaining()>0);
  assert.ok(Number.isSafeInteger(buildingReviewProfile.admittedAttempt)&&buildingReviewProfile.admittedAttempt>=1);
  assert.equal(process.env.OPENGEO_BASELINE_STUDY,undefined,'Building review must not activate the accepted baseline phase');
}
const stacFixture=stacItemsMode?(()=>{
  const fixture=buildingReviewProfile.fixture,files={};
  assert.equal(resolve(fixture.directory),join(root,'.local-archives/baseline-intelligence-20261023'));
  for(const [name,sha256] of Object.entries(fixture.files)){
    assert.equal(name.split('/').length,1);const path=join(fixture.directory,name);assert.ok(!lstatSync(path).isSymbolicLink());
    const bytes=readFileSync(path);assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256);files[name]=bytes;
  }
  const metadata=files['stac-provider-search.json'],response=JSON.parse(metadata),item=response.features[0],
    receipt=JSON.parse(files['stac-provider-metadata-receipt.json']),raster=Buffer.concat(['prefix','overview','block-tail'].map(name=>files[`stac-red-${name}.bin`]));
  assert.equal(response.features.length,1);assert.equal(item.id,fixture.itemId);assert.equal(metadata.length,22215);assert.equal(raster.length,589824);
  buildingReviewProfile.stac={item,responseSha256:fixture.files['stac-provider-search.json'],responseBytes:metadata.length,
    assetUrl:item.assets[fixture.selectedAsset].href,sizeBytes:fixture.knownSizeBytes};
  return {metadata,raster,receipt,assetUrl:buildingReviewProfile.stac.assetUrl,rangeReceipt:JSON.parse(files['stac-red-prefix-receipt.json'])};
})():null;
const baselineStudyMode=process.env.OPENGEO_BASELINE_STUDY==='1';
const baselineProfile=baselineStudyMode?JSON.parse(readFileSync(join(work,'baseline-profile.json'))):null;
const baselineCheckpoint=join(work,'baseline-progress.json');
const baselineProgress=baselineStudyMode?JSON.parse(readFileSync(baselineCheckpoint)):null;
const baselineApiCeiling=baselineProgress?.apiRequestCeiling??220;
const baselineTimeCeiling=baselineProgress?.cumulativeMillisecondsCeiling??180000;
const baselinePriorMilliseconds=baselineProgress?.activeMilliseconds??0;
const baselineRemaining=()=>baselineTimeCeiling-baselinePriorMilliseconds-(Date.now()-(baselineProgress?.runnerStartedAtMilliseconds??Date.now()));
function checkpointBaseline(update={}){
  if(!baselineStudyMode)return;
  Object.assign(baselineProgress,update,{activeMilliseconds:baselineTimeCeiling-baselineRemaining()});
  writeFileSync(baselineCheckpoint,JSON.stringify(baselineProgress,null,2)+'\n',{mode:0o600});
}
if(baselineStudyMode){
  const previewReadback=baselineApiCeiling===480&&baselineTimeCeiling===280000&&baselineProgress.serviceAttempts===9
    &&baselineProgress.previewReadback?.buildJobId===baselineProgress.publication?.buildId
    &&baselineProgress.publication?.compilerOutcome==='succeeded'&&baselineProgress.publication?.nativeCompilerInvocations===3;
  const compilerCorrection=baselineApiCeiling===480&&baselineTimeCeiling===240000
    &&(baselineProgress.serviceAttempts===7||(baselineProgress.serviceAttempts===8&&baselineProgress.compilerReportCorrection
      &&baselineProgress.compilerRefreshTransition?.sequence===1))
    &&baselineProgress.compilerRefresh?.newDigest!==baselineProgress.compilerRefresh?.oldDigest
    &&baselineProgress.compilerRefreshTransition?.effectiveDigest===baselineProgress.compilerRefresh?.newDigest
    &&baselineProgress.publication?.revisionId===baselineProgress.compilerRefresh?.sourceRevisionId
    &&baselineProgress.figure?.presentationReview?.status==='accepted-local-visual';
  assert.ok(previewReadback||compilerCorrection||(baselineTimeCeiling===180000&&(baselineApiCeiling===220||([280,400].includes(baselineApiCeiling)
    &&(baselineApiCeiling===280?baselineProgress.serviceAttempts===4:[5,6].includes(baselineProgress.serviceAttempts))
    &&baselineProgress.workerCompleted&&['fields','landcover'].every(key=>baselineProgress.records[key]?.knowledgeReadback)
    &&(baselineApiCeiling!==400||(baselineProgress.mapSaved&&baselineProgress.mapReopened&&baselineProgress.publication?.revisionId
      &&baselineProgress.figure?.presentationReview?.status==='needs-closer-extent'))))),
    'Only the reviewed delivery/presentation phases have a revised local API ceiling');
  assert.ok(developmentMode&&builtStudio&&!analysisOnlyMode&&!publicationOnlyMode,'Baseline uses the persistent built development path');
  assert.equal(baselineProfile.admissionBatchId,'BI-01-private-baseline-publication');
  for(const input of Object.values(baselineProfile.inputs)){
    const bytes=readFileSync(join(work,input.file)),knowledge=readFileSync(join(work,input.knowledge));
    assert.equal(bytes.length,input.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),input.sha256);
    assert.ok(knowledge.length<=49152);assert.equal(createHash('sha256').update(knowledge).digest('hex'),input.knowledgeSha256);
  }
}
const ftwProfilePath=join(work,"ftw-profile.json"),ftwMode=existsSync(ftwProfilePath);
const ftwProfile=ftwMode?JSON.parse(readFileSync(ftwProfilePath)):null;
const managedCogProfilePath=join(work,"managed-cog-profile.json"),managedCogMode=existsSync(managedCogProfilePath);
const managedCogProfile=managedCogMode?JSON.parse(readFileSync(managedCogProfilePath)):null;
assert.ok(!(ftwMode&&managedCogMode),"Choose one retained analysis input");
const retainedAnalysisMode=ftwMode||managedCogMode,retainedProfile=managedCogProfile??ftwProfile;
const retainedPrefix=managedCogMode?"managed-cog":"ftw";
if(retainedAnalysisMode){
  assert.ok(analysisOnlyMode&&builtStudio&&!developmentMode,"Retained inputs require the scoped built analysis journey");
  assert.equal(retainedProfile.schemaVersion,managedCogMode?"opengeo.integrated-managed-cog.1":"opengeo.integrated-ftw.1");
  assert.equal(retainedProfile.maximumApiRequests,120);assert.equal(retainedProfile.maximumMilliseconds,120_000);
  assert.equal(createHash("sha256").update(readFileSync(join(work,managedCogMode?"managed-cog.tif":"ftw-query.json"))).digest("hex"),retainedProfile.sourceSha256);
  if(managedCogMode){
    const knowledge=readFileSync(join(work,"managed-cog-knowledge.json"));
    assert.equal(knowledge.length,managedCogProfile.knowledgeBytes);assert.ok(knowledge.length<=49_152,"Preflight knowledge before any API write");
    assert.equal(JSON.parse(knowledge).schemaVersion,"1.0.0");
  }
}
let ftwApiAttempts=0,ftwUploadTickets=0,ftwUploadCompletions=0,ftwWorkerRuns=0,ftwStatus="running";
const ftwBlockedExternal=[];
const managedCogRanges=[];
const ftwRemaining=()=>120_000-(retainedProfile?.priorMilliseconds??0)-(Date.now()-(retainedProfile?.startedAtMilliseconds??Date.now()));
const checkpointFtw=()=>{if(retainedAnalysisMode)writeFileSync(join(work,`${retainedPrefix}-progress.json`),JSON.stringify({
  status:ftwStatus,sourceSha256:retainedProfile.sourceSha256,priorApiRequestAttempts:retainedProfile.priorApiRequests,
  apiRequestAttempts:ftwApiAttempts,cumulativeApiRequestAttempts:retainedProfile.priorApiRequests+ftwApiAttempts,
  cumulativeMilliseconds:retainedProfile.priorMilliseconds+Date.now()-retainedProfile.startedAtMilliseconds,
  uploadTickets:ftwUploadTickets,uploadCompletions:ftwUploadCompletions,workerRuns:ftwWorkerRuns,
  blockedExternalOrigins:[...new Set(ftwBlockedExternal)],networkProviderRequests:0,
  ...(managedCogMode?{result:{status:ftwStatus,fullBaselineRowsClosed:0,
    requiredExceptions:['Publication delivery and the remaining finite baseline capabilities are unproven.'],
    managedNativeCogAccepted:ftwStatus==='pass'},objectRanges:managedCogRanges,
    objectRangeBytes:managedCogRanges.reduce((sum,range)=>sum+range.bytes,0)}:{})},null,2)+"\n");};
let apiSocket = join(work, "api.sock");
let restoration = null;
let serviceClients = null;
let developmentWorkerRunning = false;
const developmentSmoke = developmentMode && !baselineStudyMode && !buildingReviewMode && process.env.OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE === "1";
const printSmoke = process.env.OPENGEO_COMMUNITY_PRINT_SMOKE === "1";
const printTemplateSmoke = process.env.OPENGEO_COMMUNITY_PRINT_TEMPLATE_SMOKE === "1";
if (printTemplateSmoke) assert.ok(printSmoke, "Template acceptance requires the retained Print controller");
if (printSmoke) assert.ok(developmentSmoke && builtStudio && !publicationOnlyMode && !serviceClientsMode
  && !analysisOnlyMode && !pinnedFontMode && !restoreCheckpoint && !rendererPersistenceMode && !geolibreImportMode,
  "Print acceptance requires only the retained built Studio development journey");
const postgisFixturePath = join(work, "postgis-fixture.json");
const postgisFixture = !printSmoke && !buildingReviewMode && existsSync(postgisFixturePath);
if (postgisFixture) {
  assert.ok(developmentMode && builtStudio && !publicationOnlyMode && !rendererPersistenceMode
    && !geolibreImportMode && !existsSync(join(work, "analysis-profile.json"))
    && !existsSync(join(work, "publication-profile.json")), "PostGIS fixture requires only built Studio development");
  const directory = lstatSync(work), profile = lstatSync(postgisFixturePath);
  assert.ok(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700
    && realpathSync(work) === work, "PostGIS fixture requires the owned private development directory");
  assert.ok(profile.isFile() && profile.uid === process.getuid() && (profile.mode & 0o777) === 0o600
    && profile.size <= 256, "PostGIS fixture profile must be a small owned private regular file");
  assert.deepEqual(JSON.parse(readFileSync(postgisFixturePath)), {schemaVersion: "opengeo.local-postgis-fixture.1"});
}
const developmentActiveTimeLimit = 180_000;
const developmentCheckpoint = join(work, "development-smoke.json");
const developmentProgress = developmentSmoke && existsSync(developmentCheckpoint)
  ? JSON.parse(readFileSync(developmentCheckpoint)) : {};
const developmentStarted = Date.now();
const developmentPriorMilliseconds = developmentProgress.activeMilliseconds ?? 0;
let developmentApiAttempts = 0;
function checkpointDevelopment(update = {}) {
  Object.assign(developmentProgress, update, {
    activeMilliseconds: developmentPriorMilliseconds + Date.now() - developmentStarted
  });
  writeFileSync(developmentCheckpoint, JSON.stringify(developmentProgress, null, 2) + "\n");
}
const printCheckpoint = join(work, printTemplateSmoke ? "print-template-smoke.json" : "print-smoke.json");
if (printSmoke) {
  const directory = lstatSync(work);
  assert.ok(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700
    && realpathSync(work) === work, "Print acceptance requires the owned private state directory");
  assert.ok(developmentProgress.styledSaved && developmentProgress.reopened && developmentProgress.map?.id,
    "Print acceptance reuses the completed retained map");
  if (existsSync(printCheckpoint)) {
    const checkpoint = lstatSync(printCheckpoint);
    assert.ok(checkpoint.isFile() && checkpoint.uid === process.getuid() && (checkpoint.mode & 0o777) === 0o600);
  }
}
const printProgress = printSmoke && existsSync(printCheckpoint) ? JSON.parse(readFileSync(printCheckpoint)) : {};
if (printSmoke && printProgress.schemaVersion) {
  assert.equal(printProgress.schemaVersion, printTemplateSmoke ? "opengeo.print-template-smoke.1" : "opengeo.print-smoke.1");
  assert.equal(printProgress.mapId, developmentProgress.map.id);
  assert.equal(printProgress.projectId, developmentProgress.project);
}
const printPriorMilliseconds = printProgress.activeMilliseconds ?? 0;
let printApiAttempts = 0;
function checkpointPrint(update = {}) {
  Object.assign(printProgress, update, {schemaVersion: printTemplateSmoke ? "opengeo.print-template-smoke.1" : "opengeo.print-smoke.1",
    projectId: developmentProgress.project, mapId: developmentProgress.map.id,
    activeMilliseconds: printPriorMilliseconds + Date.now() - developmentStarted});
  writeFileSync(printCheckpoint, JSON.stringify(printProgress, null, 2) + "\n", {mode: 0o600});
}
const localAnalysisRunner = developmentMode && !printSmoke && !baselineStudyMode && !buildingReviewMode ? loadLocalAnalysisRunner(work) : null;
const publicationProfile = !printSmoke && !buildingReviewMode && existsSync(join(work, "publication-profile.json"))
  ? JSON.parse(readFileSync(join(work, "publication-profile.json"), "utf8")) : null;
let localAnalysisBridge;
let publicationSecurityRequests=0;
let catalogStudyApiAttempts=0;
const catalogStudyProgressPath=join(work,'publication-progress.json');
const catalogStudyPriorApiAttempts=catalogStudyMode&&existsSync(catalogStudyProgressPath)
  ? JSON.parse(readFileSync(catalogStudyProgressPath)).apiRequestAttempts??0 : 0;
const mapArtifactPrior=mapArtifactMode?JSON.parse(readFileSync(catalogStudyProgressPath)).mapArtifact??{}:{};
const mapArtifactPriorApiAttempts=mapArtifactPrior.apiRequestAttempts??0;
const mapArtifactPriorMilliseconds=mapArtifactPrior.activeMilliseconds??0;
const mapArtifactStarted=Date.now();let mapArtifactApiAttempts=0;
const requestReceiptPath=join(work,buildingReviewMode?`${buildingReviewPrefix}-requests.json`:baselineStudyMode?'baseline-requests.json':printTemplateSmoke?'print-template-requests.json':printSmoke?'print-requests.json':mapArtifactMode?'map-artifact-requests.json':'requests.json');
const priorBuildingReviewRequests=buildingReviewMode&&existsSync(requestReceiptPath)?JSON.parse(readFileSync(requestReceiptPath)):[];
const priorBaselineRequests=baselineStudyMode&&existsSync(requestReceiptPath)?JSON.parse(readFileSync(requestReceiptPath)):[];
let priorPrintTemplateRequests = [];
if (printTemplateSmoke && existsSync(requestReceiptPath)) {
  const receipt = lstatSync(requestReceiptPath);
  assert.ok(receipt.isFile() && receipt.uid === process.getuid() && (receipt.mode & 0o777) === 0o600,
    "Template request continuation requires its owned private receipt");
  priorPrintTemplateRequests = JSON.parse(readFileSync(requestReceiptPath));
  assert.ok(Array.isArray(priorPrintTemplateRequests) && priorPrintTemplateRequests.length <= 150);
}
let publicationSecurityRegularRequests=0,publicationSecurityCleanupRequests=0,securityInvitationId=null;
const securityFacts=publicationSecurityOnly?JSON.parse(readFileSync(join(work,'publication-progress.json'))):null;
const securityPreviousRequests=securityFacts?.previewSecurity
  ?JSON.parse(readFileSync(join(work,'requests.json'))):[];
const securityReconciliation=publicationSecurityReconciliationPin===undefined?undefined
  :loadPublicationSecurityReconciliation(work,publicationSecurityReconciliationPin);
const securityResume=publicationSecurityOnly
  ?validatePublicationSecurityResume(securityFacts,securityPreviousRequests,securityReconciliation):null;
const securityPriorApiRequests=securityResume?.priorApiRequests??securityPreviousRequests.length;
const securityCumulativeApiRequests=securityResume?.cumulativeApiRequests??42;
const securityReviewer='20000000-0000-4000-8000-000000000002';

function apiRequest(path, {method = "GET", headers = {}, body, cleanup = false, rasterReadPurpose = null} = {}) {
  let receptorNativeScope=null;
  let rasterDownloadRecord=null;
  if(buildingInputPreviewMode){
    assert.ok((buildingReviewProgress.apiRequestAttempts??0)<buildingApiLimit&&buildingReviewRemaining()>0,'Input preview cumulative API/time ceiling');
    assertBuildingInputPreviewRequest({path,method,progress:buildingReviewProgress});
    checkpointBuildingReview({apiRequestAttempts:(buildingReviewProgress.apiRequestAttempts??0)+1});
  }
  if(buildingReviewMode&&!buildingInputPreviewMode&&!rasterAccountMode&&!stacItemsMode){
    assert.ok((buildingReviewProgress.apiRequestAttempts??0)<buildingApiLimit&&buildingReviewRemaining()>0,'Scoped account cumulative API/time ceiling');
    const project=buildingReviewProgress.projectId,records=buildingReviewProgress.records??={},current=records[buildingReviewProgress.currentRecord];
    const realInputMetadataKey=realBuildingReviewMode&&buildingInputKeys.find(key=>path===`/datasets/${records[key]?.datasetId}/metadata`);
    const uploadRequest=method==='POST'&&path===`/projects/${project}/uploads/request`,
      uploadComplete=method==='POST'&&Object.values(records).some(record=>path===`/projects/${project}/uploads/${record.uploadId}/complete`),
      native=method==='POST'&&path===`/projects/${project}/datasets/${records[receptorScreeningMode?'receptors':'source']?.datasetId}/analysis-preview`,
      exactVersionDownload=method==='POST'&&Object.values(records).some(record=>{
        const prefix=`/projects/${project}/datasets/${record.datasetId}/versions/${record.datasetVersionId}/objects/`;
        return path.startsWith(prefix)&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/download$/.test(path.slice(prefix.length));
      });
    assert.ok(['GET','HEAD'].includes(method)||method==='POST'&&(path==='/projects'||path===`/projects/${project}/maps`
      ||uploadRequest||uploadComplete||path==='/__local/upload'||native
      ||buildingInputKeys.some(key=>path===`/projects/${project}/datasets/${records[key]?.datasetId}/feature-collection`)
      ||exactVersionDownload)
      ||method==='PATCH'&&path===`/projects/${project}/maps/${buildingReviewProgress.mapId}`
      ||method==='PUT'&&(path===`/datasets/${records.output?.datasetId}/metadata`||realInputMetadataKey),
      'Building review only mutates its explicitly scoped records');
    buildingReviewProgress.apiRequestAttempts=(buildingReviewProgress.apiRequestAttempts??0)+1;
    if(method==='POST'&&path==='/projects'){
      assert.ok(!buildingReviewProgress.projectRequestAttempted);buildingReviewProgress.projectRequestAttempted=true;
    }
    if(method==='POST'&&path===`/projects/${project}/maps`){
      assert.ok(!buildingReviewProgress.mapRequestAttempted);buildingReviewProgress.mapRequestAttempted=true;
    }
    if(uploadRequest){
      assert.ok(current&&!current.ticketAttempted,'One ticket per admitted inventory/output');
      if(receptorScreeningMode)assert.ok([...buildingInputKeys,'output'].includes(buildingReviewProgress.currentRecord));
      assert.ok(Object.values(records).filter(record=>record.ticketAttempted).length<buildingUploadLimit,'Preserve cumulative original upload limit');
      const input=JSON.parse(body);
      if(buildingReviewProgress.currentRecord!=='output'){
        assert.equal(input.filename,current.filename);assert.equal(input.size_bytes,current.sizeBytes);assert.equal(input.checksum_sha256,current.checksumSha256);
      }else{assert.equal(input.filename,'derived-analysis.geojson');assert.ok(input.size_bytes>0&&input.size_bytes<=2_200_000);}
      current.ticketAttempted=true;
    }
    if(uploadComplete){const record=Object.values(records).find(record=>path===`/projects/${project}/uploads/${record.uploadId}/complete`);
      assert.ok(!record.completionAttempted);record.completionAttempted=true;}
    if(path==='/__local/upload'&&method==='POST'){
      assert.ok(current?.ticketAttempted&&!current.transferAttempted);current.transferAttempted=true;
    }
    if(receptorScreeningMode&&method==='POST'&&path.endsWith('/feature-collection')){
      const key=buildingInputKeys.find(key=>path===`/projects/${project}/datasets/${records[key]?.datasetId}/feature-collection`),record=records[key];
      assert.ok(record?.uploadCompleted&&!record.nativeCollectionAttempted,'Each exact screening inventory is seeded once');
      const collection=JSON.parse(body);assert.equal(collection.geometry_type,'Polygon');
      assert.equal(createHash('sha256').update(JSON.stringify({type:'FeatureCollection',features:collection.features})).digest('hex'),record.checksumSha256);
      record.nativeCollectionAttempted=true;
    }
    if(native){
      if(receptorScreeningMode){
        const input=JSON.parse(body);receptorNativeScope=['footprint','influence'].find(key=>input.target_dataset_id===records[key]?.datasetId)??null;
        assert.ok(receptorNativeScope,'Clip only the two explicit admitted scope generations');
        assert.equal(input.operation,'clip');assert.equal(input.source_generation,records.receptors.collection.generation);
        assert.equal(input.target_generation,records[receptorNativeScope].collection.generation);
        const attempted=buildingReviewProgress.nativePreviewAttempted??={};
        assert.ok(!attempted[receptorNativeScope],'Reconcile a retained native Clip response instead of recomputing');attempted[receptorNativeScope]=true;
      }else{assert.ok(!buildingReviewProgress.nativePreviewAttempted,'Only one native building comparison across attempts');buildingReviewProgress.nativePreviewAttempted=true;}
    }
    if(receptorScreeningMode&&method==='PATCH'){
      for(const layer of JSON.parse(body).definition.layers){
        const record=Object.values(records).find(record=>record.datasetId===layer.datasetId);assert.ok(record,'Preserve the scoped Project composition');
        assert.equal(layer.datasetVersionId,record.datasetVersionId);assert.equal(layer.sourceVersion,record.versionNumber);
      }
    }
    if(method==='PUT'){
      if(realInputMetadataKey){const record=records[realInputMetadataKey];
        assert.ok(record.uploadCompleted&&!record.inputMetadataRequestAttempted,'Read back uncertain input metadata before retrying');
        record.inputMetadataRequestAttempted=true;record.preparedInputMetadata=JSON.parse(body).document;
      }else{assert.ok(!buildingReviewProgress.metadataAttempted,'Read back an uncertain metadata commit before retrying');
        buildingReviewProgress.metadataAttempted=true;buildingReviewProgress.preparedMetadata=JSON.parse(body).document;}
    }
    checkpointBuildingReview();
  }
  if(stacItemsMode){
    const progress=buildingReviewProgress,project=buildingReviewProfile.source.projectId,
      sourceCreate=method==='POST'&&path===`/projects/${project}/sources`,
      mapCreate=method==='POST'&&path===`/projects/${project}/maps`;
    assert.ok((progress.apiRequestAttempts??0)<buildingApiLimit&&buildingReviewRemaining()>0,'STAC account cumulative API/time ceiling');
    assert.ok(['GET','HEAD'].includes(method)||sourceCreate||mapCreate,'STAC account only creates its one reference and composition; no ingestion, jobs, archive or grants');
    if(buildingReviewProfile.readOnlyProjectRemainder)assert.ok(['GET','HEAD'].includes(method),'Committed STAC readback forbids every further write');
    progress.apiRequestAttempts=(progress.apiRequestAttempts??0)+1;
    if(sourceCreate){assert.ok(!progress.sourceWriteDispatched&&!progress.record?.datasetId,'Never replay a dispatched source registration');
      const bodyValue=JSON.parse(body);assert.equal(bodyValue.classification,'internal');assert.equal(bodyValue.source.type,'cog');
      assert.equal(bodyValue.source.url,stacFixture.assetUrl);
      assert.deepEqual(bodyValue.source.bands,[1]);progress.sourceWriteDispatched=true;progress.sourceWriteBody=bodyValue;}
    if(mapCreate){assert.ok(progress.record?.datasetId&&!progress.mapWriteDispatched&&!progress.mapId,'Never replay a dispatched composition');
      const value=JSON.parse(body);assert.equal(value.definition.layers.length,1);const layer=value.definition.layers[0];
      assert.equal(layer.datasetId,progress.record.datasetId);assert.equal(layer.sourceVersion,1);assert.equal(layer.sourceType,'cog-raster');
      progress.mapWriteDispatched=true;progress.mapWriteBody=value;}
    checkpointBuildingReview();
  }
  if(rasterAccountMode){
    const progress=buildingReviewProgress,source=buildingReviewProfile.source,records=progress.records??{},current=records[progress.currentRecord],
      project=source.projectId,sourcePath=`/projects/${project}/datasets/${source.datasetId}`,
      sourceDownload=`${sourcePath}/versions/${source.datasetVersionId}/objects/${source.dataObjectId}/download`,
      mapPath=`/projects/${project}/maps/${progress.mapId}`,
      upload=method==='POST'&&path===`/projects/${project}/uploads/request`,
      complete=method==='POST'&&Object.values(records).some(record=>path===`/projects/${project}/uploads/${record.uploadId}/complete`),
      metadata=method==='PUT'&&Object.values(records).some(record=>path===`/datasets/${record.datasetId}/metadata`),
      archive=method==='POST'&&Object.values(records).some(record=>record.archiveObjectId&&path===`/projects/${project}/datasets/${record.datasetId}/versions/${record.datasetVersionId}/objects/${record.archiveObjectId}/download`);
    assert.ok((progress.apiRequestAttempts??0)<buildingApiLimit&&buildingReviewRemaining()>0,'Raster account cumulative API/time ceiling');
    assert.ok(['GET','HEAD'].includes(method)||method==='POST'&&(path===sourceDownload||path===`/projects/${project}/maps`||upload||complete||path==='/__local/upload'||archive)
      ||method==='PATCH'&&progress.mapId&&path===mapPath||metadata,'Raster account permits only its new composition and two derived registrations');
    if(path.includes(source.datasetId))assert.ok(['GET','HEAD'].includes(method)&&[sourcePath,`/datasets/${source.datasetId}`,`${sourcePath}/versions?limit=100&offset=0`,
      `${sourcePath}/versions?limit=50&offset=0`,`/datasets/${source.datasetId}/resources?limit=25&offset=0`,
      `/datasets/${source.datasetId}/metadata`,`${sourcePath}/versions/${source.datasetVersionId}`,
      `${sourcePath}/versions/${source.datasetVersionId}/pmtiles-derivatives?limit=100&offset=0`].includes(path)||method==='POST'&&path===sourceDownload,
      'Retained source permits exact read authority and its pinned original only');
    progress.apiRequestAttempts=(progress.apiRequestAttempts??0)+1;
    if(method==='POST'&&path===`/projects/${project}/maps`){assert.ok(progress.sourceAuthorityVerified&&!progress.mapRequestAttempted);progress.mapRequestAttempted=true;}
    if(upload){
      assert.ok(progress.sourceAuthorityVerified&&(rasterValidationMode?['validation']:['comparison','patches']).includes(progress.currentRecord)&&current&&!current.ticketAttempted);
      assert.ok(Object.values(records).filter(record=>record.ticketAttempted).length<buildingUploadLimit);
      const value=JSON.parse(body);assert.equal(value.filename,'derived-analysis.geojson');assert.ok(value.size_bytes>0&&value.size_bytes<=(rasterValidationMode?1_048_576:2_200_000));
      current.ticketAttempted=true;
    }
    if(complete){const record=Object.values(records).find(record=>path.endsWith(`/uploads/${record.uploadId}/complete`));assert.ok(!record.completionAttempted);record.completionAttempted=true;}
    if(path==='/__local/upload'&&method==='POST'){assert.ok(current?.ticketAttempted&&!current.transferAttempted);current.transferAttempted=true;}
    if(metadata){const record=Object.values(records).find(record=>path===`/datasets/${record.datasetId}/metadata`);
      assert.ok(!record.metadataAttempted,'Read back an uncertain metadata commit before retrying');record.metadataAttempted=true;record.preparedMetadata=JSON.parse(body).document;}
    if(method==='PATCH'){
      const layers=JSON.parse(body).definition.layers;assert.ok(layers.length>=(rasterValidationMode?1:2)&&layers.length<=(rasterValidationMode?2:4));
      for(const layer of layers){
        const pin=layer.datasetId===source.datasetId?source:Object.values(records).find(record=>record.datasetId===layer.datasetId);
        assert.ok(pin,'Only retained source and admitted derived Layers may persist');assert.equal(layer.datasetVersionId,pin.datasetVersionId);assert.equal(layer.sourceVersion,pin.versionNumber);
        if(layer.datasetId===source.datasetId){assert.ok((rasterValidationMode?['raster-before']:['raster-before','raster-after']).includes(layer.layerId));assert.equal(layer.objectId,source.dataObjectId);}
      }
      assert.ok((rasterValidationMode?[0,1]:[0,2]).includes(layers.filter(layer=>layer.datasetId===source.datasetId).length));
    }
    if(archive){
      const record=Object.values(records).find(record=>path.includes(`/datasets/${record.datasetId}/`));
      assert.ok(rasterReadPurpose===null||rasterReadPurpose==='audit');rasterDownloadRecord=record;
      if(rasterReadPurpose==='audit'){
        assert.ok(!record.archiveReadAttempted,'Each explicit full original audit is read once');record.archiveReadAttempted=true;
      }else{
        assert.ok(record.archiveVerified,'Render only the output whose full original audit was verified');
        assert.ok((record.renderTicketAttempts??0)<2&&(progress.renderTicketAttempts??0)<buildingReviewProfile.maximumOutputDisplayTickets,'Two exact output render cycles: Catalog Add and fresh reopen');
        record.renderTicketAttempts=(record.renderTicketAttempts??0)+1;progress.renderTicketAttempts=(progress.renderTicketAttempts??0)+1;
      }
    }
    checkpointBuildingReview();
  }
  if(baselineStudyMode){
    if(baselineProgress.previewReadback)assert.ok(['GET','HEAD'].includes(method)
      ||method==='POST'&&(path.endsWith('/preview-capabilities')||path==='/observable-preview/exchange'),
      'Successful build readback may only read or authorize its private preview');
    assert.ok((baselineProgress.apiRequestAttempts??0)<baselineApiCeiling&&baselineRemaining()>0,'Baseline cumulative API/time ceiling');
    baselineProgress.apiRequestAttempts=(baselineProgress.apiRequestAttempts??0)+1;
    if(method==='POST'&&path.endsWith('/uploads/request')){
      const key=baselineProgress.currentRecord,record=baselineProgress.records[key],input=baselineProfile.inputs[key];
      assert.ok(record&&input&&!record.ticketAttempted,'One ticket for each admitted original');
      const candidate=JSON.parse(body);assert.equal(candidate.filename,input.filename);assert.equal(candidate.size_bytes,input.sizeBytes);
      assert.equal(candidate.checksum_sha256,input.sha256);record.ticketAttempted=true;
    }
    if(method==='POST'&&/^\/projects\/[^/]+\/uploads\/[^/]+\/complete$/.test(path)){
      const record=Object.values(baselineProgress.records).find(record=>path.endsWith(`/uploads/${record.uploadId}/complete`));
      assert.ok(record&&!record.completionAttempted,'One completion/ingestion for each retained ticket');record.completionAttempted=true;
    }
    if(method==='POST'&&path.endsWith('/build-jobs')){
      const prior=baselineProgress.nativeBuildRequests??0,refresh=baselineProgress.compilerRefresh;
      if(prior===2&&baselineProgress.compilerReportCorrection){
        assert.equal(path,`/projects/${baselineProgress.projectId}/source-projects/${baselineProgress.publication.sourceProjectId}/revisions/${refresh.sourceRevisionId}/build-jobs`);
        assert.equal(JSON.parse(body).purpose,'preview');assert.ok(!baselineProgress.compilerReportReplacementBuildRequested);
        assert.equal(baselineProgress.publication.nativeCompilerInvocations,2);
        baselineProgress.compilerReportReplacementBuildRequested=true;baselineProgress.nativeBuildRequests=3;
      }else if(prior===1&&refresh){
        assert.equal(path,`/projects/${baselineProgress.projectId}/source-projects/${baselineProgress.publication.sourceProjectId}/revisions/${refresh.sourceRevisionId}/build-jobs`);
        assert.equal(JSON.parse(body).purpose,'preview');assert.ok(!baselineProgress.compilerReplacementBuildRequested);
        assert.equal(baselineProgress.publication.nativeCompilerInvocations,1);
        baselineProgress.compilerReplacementBuildRequested=true;baselineProgress.nativeBuildRequests=2;
      }else{assert.equal(prior,0,'One original native baseline Publication build');baselineProgress.nativeBuildRequests=1;}
    }
    checkpointBaseline();
  }
  if(retainedAnalysisMode){
    assert.ok(retainedProfile.priorApiRequests+ftwApiAttempts<120,"Retained analysis cumulative API attempt limit is 120");
    assert.ok(ftwRemaining()>0,"Retained analysis cumulative local service/browser deadline is 120 seconds");
    ftwApiAttempts++;
    if(method==="POST"&&/^\/projects\/[^/]+\/uploads\/request$/.test(path)){
      assert.equal(ftwUploadTickets,0,"Retained analysis creates one governed Layer/upload ticket");ftwUploadTickets++;
    }
    if(method==="POST"&&/^\/projects\/[^/]+\/uploads\/[^/]+\/complete$/.test(path)){
      assert.equal(ftwUploadCompletions,0,"Retained analysis commits one ingestion job");ftwUploadCompletions++;
    }
    checkpointFtw();
  }
  if (printSmoke) {
    const mapPath = `/projects/${developmentProgress.project}/maps/${developmentProgress.map.id}`;
    const patch = method === "PATCH" && path === mapPath;
    assert.ok(method === "GET" || method === "HEAD" || patch
      || method === "POST" && path.startsWith(`/projects/${developmentProgress.project}/datasets/${developmentProgress.datasetId}/versions/${developmentProgress.datasetVersionId}/objects/`)
        && path.endsWith("/download"), "Print acceptance permits only reads and the one retained-map layout save");
    assert.ok(printApiAttempts < 100 && (printProgress.apiRequestAttempts ?? 0) < 150,
      "Print acceptance: 100 API attempts per run, 150 cumulative");
    assert.ok(printPriorMilliseconds + Date.now() - developmentStarted < 150_000,
      "Print acceptance: 150 seconds cumulative active browser time");
    if (patch) {
      assert.ok(printProgress.saveAttempted && (printProgress.patchAttempts ?? 0) === 0,
        "A Print save must be checkpointed and can be attempted once");
      if (printTemplateSmoke) {
        const payload = JSON.parse(body);
        assert.deepEqual(Object.keys(payload).sort(), ["change_message", "definition", "expected_version"],
          "Template acceptance saves only the prepared definition through the existing revision boundary");
        assert.equal(payload.expected_version, printProgress.expectedVersion);
        assert.ok(payload.definition?.extensions?.opengeoPrintLayouts,
          "Template save requires its exact prepared collection");
        const canonical = structuredClone(payload.definition), baseline = structuredClone(printProgress.baselineMap.definition);
        delete canonical.extensions.opengeoPrintLayouts;delete baseline.extensions.opengeoPrintLayouts;
        assert.deepEqual(canonical, baseline, "Template acceptance cannot change canonical map data or presentation");
        const prepared = payload.definition.extensions.opengeoPrintLayouts;
        assert.deepEqual(prepared.layouts, [printProgress.baselineMap.definition.extensions.opengeoPrintLayouts.layouts[0],
          printProgress.preparedLayout], "Template acceptance preserves the accepted layout and adds only its prepared new layout");
        assert.equal(prepared.templates.length, 1);assert.equal(prepared.templates[0].id, printProgress.templateId);
        assert.equal(prepared.templates[0].name, printProgress.title);
        assert.deepEqual(prepared.templates, [printProgress.preparedTemplate],
          "The one template save must contain the prepared source-free configuration only");
        checkpointPrint({patchAttempts: 1,
          preparedCollection: prepared});
      } else checkpointPrint({patchAttempts: 1});
    }
    printApiAttempts++;
    checkpointPrint({apiRequestAttempts: (printProgress.apiRequestAttempts ?? 0) + 1});
  }
  if(mapArtifactMode){
    assert.ok(mapArtifactPriorApiAttempts+mapArtifactApiAttempts<110,"Map Artifact: at most 110 cumulative API attempts (revised from 100; prior attempts retained)");
    assert.ok(mapArtifactPriorMilliseconds+Date.now()-mapArtifactStarted<90_000,"Map Artifact: at most 90 cumulative active seconds");
    mapArtifactApiAttempts++;
    const facts=JSON.parse(readFileSync(catalogStudyProgressPath));
    assert.equal(facts.mode,'catalog-study');assert.equal(facts.status,'pass');
    writeFileSync(catalogStudyProgressPath,JSON.stringify({...facts,mapArtifact:{...facts.mapArtifact,
      apiRequestAttempts:mapArtifactPriorApiAttempts+mapArtifactApiAttempts,
      activeMilliseconds:mapArtifactPriorMilliseconds+Date.now()-mapArtifactStarted}},null,2)+'\n');
  }
  if(catalogStudyMode){
    assert.ok(catalogStudyPriorApiAttempts+catalogStudyApiAttempts < 100,
      "Catalog study: at most 100 API attempts across retained attempts");
    catalogStudyApiAttempts++;
    const facts=JSON.parse(readFileSync(catalogStudyProgressPath));
    assert.equal(facts.mode,'catalog-study','Initialize the study checkpoint before API attempts');
    writeFileSync(catalogStudyProgressPath,JSON.stringify({...facts,
      apiRequestAttempts:catalogStudyPriorApiAttempts+catalogStudyApiAttempts},null,2)+'\n');
  }
  if (developmentSmoke && !printSmoke) {
    if (developmentProgress.styledSaved) assert.ok(method === "GET" || method === "HEAD"
      || method === "POST" && path.startsWith(`/projects/${developmentProgress.project}/datasets/${developmentProgress.datasetId}/versions/${developmentProgress.datasetVersionId}/objects/`)
        && path.endsWith("/download"), "Saved development map reopening only reads the retained Project and exact source");
    assert.ok(developmentApiAttempts < 100 && (developmentProgress.apiRequestAttempts ?? 0) < 185,
      "Development smoke: 100 API attempts per run, 185 across creation and restart/reopen");
    assert.ok(developmentPriorMilliseconds + Date.now() - developmentStarted < developmentActiveTimeLimit,
      "Development smoke: 180 seconds of combined active browser/controller time");
    developmentApiAttempts++;
    checkpointDevelopment({apiRequestAttempts: (developmentProgress.apiRequestAttempts ?? 0) + 1});
  }
  if(publicationSecurityOnly){
    const capability=securityFacts.builds.some(build=>
      path===`/projects/${securityFacts.projectId}/observable-build-jobs/${build.id}/preview-capabilities`);
    const membership=path===`/projects/${securityFacts.projectId}/memberships/${securityReviewer}`
      ||path===`/organizations/current/memberships/${securityReviewer}`;
    const invitation=securityInvitationId!==null&&path===`/organizations/current/invitations/${securityInvitationId}`;
    const acceptInvitation=securityInvitationId!==null&&path===`/auth/invitations/${securityInvitationId}/accept`;
    assert.ok(method==='GET'||(method==='POST'&&(capability||path==='/observable-preview/exchange'
      ||path==='/organizations/current/invitations'||acceptInvitation))
      ||(method==='DELETE'&&(membership||invitation)),
    'Security acceptance must not save source, create builds or publish.');
    if(cleanup)assert.ok((method==='DELETE'&&(membership||invitation))||(method==='GET'&&(
      path===`/projects/${securityFacts.projectId}/memberships`||path==='/organizations/current/memberships')),
    'Only fixture reconciliation may use the cleanup reserve.');
    assert.ok(publicationSecurityRequests<30,'Publication security total API ceiling.');
    assert.ok(securityPriorApiRequests+publicationSecurityRequests<securityCumulativeApiRequests,
      'Retain every prior API attempt within the explicitly scoped cumulative security ceiling.');
    assert.ok(cleanup?publicationSecurityCleanupRequests<4:publicationSecurityRegularRequests<26,
      'Publication security allows 26 normal calls plus four reserved cleanup calls.');
    if(method==='POST'&&path==='/organizations/current/invitations'){
      assert.equal(securityInvitationId,null,'Create at most one temporary reviewer invitation.');
      assert.deepEqual(JSON.parse(body),{email:'reviewer@local.invalid',display_name:'Local reviewer',organization_role:'guest',
        project_id:securityFacts.projectId,project_role:'viewer',expires_in_days:1});
    }
    if(cleanup)publicationSecurityCleanupRequests++;else publicationSecurityRegularRequests++;
    publicationSecurityRequests++;
  }
  if (publicationOnlyMode) assert.ok(requests.length < 500, "Publication request ceiling");
  if (rendererPersistenceMode) assert.ok(requests.length < 160,"Renderer persistence request ceiling");
  if (geolibreImportMode) assert.ok(requests.length < 120,"GeoLibre import request ceiling");
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const socket = apiSocket;
  return new Promise((done, reject) => {
    const request = httpRequest({socketPath: socket, path, method, headers}, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if(buildingReviewMode&&response.statusCode>=200&&response.statusCode<300&&path!=='/__local/upload'){
          try{
            const record=body.length?JSON.parse(body):null,progress=buildingReviewProgress,
              current=progress.records?.[progress.currentRecord];
            if(rasterAccountMode&&rasterDownloadRecord){
              assert.equal(typeof record.url,'string');const tickets=progress.outputDownloadTickets??=[];
              tickets.push({datasetId:rasterDownloadRecord.datasetId,datasetVersionId:rasterDownloadRecord.datasetVersionId,
                objectId:rasterDownloadRecord.archiveObjectId,urlSha256:createHash('sha256').update(record.url).digest('hex'),
                purpose:rasterReadPurpose==='audit'?'audit':'render',transportRead:false});
              checkpointBuildingReview({outputDownloadTickets:tickets});
            }
            if(stacItemsMode&&method==='POST'&&path===`/projects/${progress.projectId}/sources`)checkpointBuildingReview({record:{datasetId:record.dataset_id,source:record}});
            else if(method==='POST'&&path==='/projects')checkpointBuildingReview({projectId:record.id});
            else if(method==='POST'&&path===`/projects/${progress.projectId}/maps`)checkpointBuildingReview({mapId:record.id,map:record});
            else if(method==='POST'&&path.endsWith('/uploads/request')){
              assert.ok(current);Object.assign(current,{datasetId:record.dataset.id,uploadId:record.upload_id});checkpointBuildingReview();
            }else if(method==='POST'&&/^\/projects\/[^/]+\/uploads\/[^/]+\/complete$/.test(path)){
              const target=Object.values(progress.records).find(value=>path.endsWith(`/uploads/${value.uploadId}/complete`));
              assert.ok(target);Object.assign(target,{datasetId:record.dataset.id,datasetVersionId:record.dataset_version_id,
                versionNumber:record.version_number,uploadCompleted:true});checkpointBuildingReview();
            }else if(method==='POST'&&path.endsWith('/feature-collection')){
              assert.ok(current);current.collection=record['opengeo:collection'];checkpointBuildingReview();
            }else if(method==='POST'&&path.endsWith('/analysis-preview')){
              if(receptorScreeningMode){
                const receipt=record['opengeo:analysis'];assert.equal(receipt.operation,'clip');
                assert.equal(receipt.sourceDatasetId,progress.records.receptors.datasetId);assert.equal(receipt.source_generation,progress.records.receptors.collection.generation);
                assert.equal(receipt.targetDatasetId,progress.records[receptorNativeScope].datasetId);assert.equal(receipt.target_generation,progress.records[receptorNativeScope].collection.generation);
                const previews=progress.nativePreviews??={};previews[receptorNativeScope]=record;checkpointBuildingReview({nativePreviews:previews});
              }else checkpointBuildingReview({nativePreview:record});
            }
            else if(rasterAccountMode&&method==='PUT'){
              const target=Object.values(progress.records).find(value=>path===`/datasets/${value.datasetId}/metadata`);
              assert.ok(target);target.metadata=record;checkpointBuildingReview();
            }
            else if(realBuildingReviewMode&&method==='PUT'&&buildingInputKeys.some(key=>path===`/datasets/${progress.records?.[key]?.datasetId}/metadata`)){
              const target=buildingInputKeys.map(key=>progress.records[key]).find(value=>path===`/datasets/${value.datasetId}/metadata`);
              target.inputMetadata=record;target.inputMetadataCommitted=true;checkpointBuildingReview();
            }
            else if(method==='PUT'&&path===`/datasets/${progress.records?.output?.datasetId}/metadata`)checkpointBuildingReview({metadata:record});
            else if(method==='PATCH'&&path===`/projects/${progress.projectId}/maps/${progress.mapId}`)checkpointBuildingReview({map:record});
          }catch(error){return reject(error);}
        }
        if(publicationSecurityOnly&&method==='POST'&&path==='/organizations/current/invitations'
          &&response.statusCode>=200&&response.statusCode<300){
          try{
            const invitation=JSON.parse(body);assert.match(invitation.id,/^[0-9a-f-]{36}$/);
            securityInvitationId=invitation.id;
          }catch{return reject(new Error('Temporary reviewer invitation response is invalid.'));}
        }
        if (printSmoke && method === "PATCH" && response.statusCode >= 200 && response.statusCode < 300) {
          try { checkpointPrint({savedMap: JSON.parse(body), saveResponseReceived: true}); }
          catch (error) { return reject(error); }
        }
        const baselineCommitResponse=baselineStudyMode&&(method==='POST'&&(path==='/projects'
          ||/^\/projects\/[^/]+\/maps$/.test(path)||/^\/projects\/[^/]+\/uploads\/(?:request|[^/]+\/complete)$/.test(path))
          ||method==='PATCH'&&path===`/projects/${baselineProgress?.projectId}/maps/${baselineProgress?.mapId}`);
        if(baselineCommitResponse&&response.statusCode>=200&&response.statusCode<300){
          try{
            const record=body.length?JSON.parse(body):null;
            if(method==='POST'&&path==='/projects')checkpointBaseline({projectId:record.id});
            else if(method==='POST'&&/^\/projects\/[^/]+\/maps$/.test(path))checkpointBaseline({mapId:record.id,map:record});
            else if(method==='POST'&&(path.endsWith('/uploads/request')||path.endsWith('/complete'))){
              const key=baselineProgress.currentRecord;assert.ok(['fields','landcover'].includes(key));
              const current=baselineProgress.records[key]??={};
              if(path.endsWith('/uploads/request'))Object.assign(current,{datasetId:record.dataset.id,uploadId:record.upload_id});
              else Object.assign(current,{datasetId:record.dataset.id,datasetVersionId:record.dataset_version_id,versionNumber:record.version_number,uploadCompleted:true});
              checkpointBaseline({records:baselineProgress.records});
            }else if(method==='PATCH'&&path===`/projects/${baselineProgress.projectId}/maps/${baselineProgress.mapId}`)checkpointBaseline({map:record});
          }catch(error){return reject(error);}
        }
        if (developmentSmoke && !printSmoke && response.statusCode >= 200 && response.statusCode < 300 && (
          method === "POST" && (path === "/projects" || /^\/projects\/[^/]+\/maps$/.test(path)
            || path.endsWith("/uploads/request") || path.endsWith("/complete"))
          || method === "PATCH" && path === `/projects/${developmentProgress.project}/maps/${developmentProgress.map?.id}`)) {
          try {
            const record = JSON.parse(body);
            if (method === "POST" && path === "/projects") checkpointDevelopment({project: record.id});
            else if (method === "POST" && /^\/projects\/[^/]+\/maps$/.test(path)) checkpointDevelopment({map: record});
            else if (method === "POST" && path.endsWith("/uploads/request")) {
              checkpointDevelopment({uploadId: record.upload_id, datasetId: record.dataset.id});
            } else if (method === "POST" && path.endsWith("/complete")) {
              checkpointDevelopment({datasetId: record.dataset.id, datasetVersionId: record.dataset_version_id, uploadCompleted: true});
            } else if (method === "PATCH" && path === `/projects/${developmentProgress.project}/maps/${developmentProgress.map?.id}`) {
              checkpointDevelopment({map: record, styledSaved: true});
            }
          } catch (error) { return reject(error); }
        }
        requests.push({method, path, status: response.statusCode, authenticated: Boolean(headers.authorization),
          backend:socket === join(work, "api.sock") ? "original" : "restored",
          ...(headers["user-agent"] === "OpenGeo-Integrated-QGIS/1.0" ? {client:"qgis"}
            : headers["user-agent"] === "OpenGeo-Integrated-HTTP/1.0" ? {client:"independent-http"}
            : headers["user-agent"] === "OpenGeo-Integrated-GDAL/1.0" ? {client:"gdal"} : {})});
        if (buildingReviewMode || developmentSmoke || catalogStudyMode || mapArtifactMode || baselineStudyMode) writeFileSync(requestReceiptPath, JSON.stringify(buildingReviewMode?[...priorBuildingReviewRequests,...requests]:baselineStudyMode?[...priorBaselineRequests,...requests]:requests, null, 2) + "\n",buildingReviewMode?{mode:0o600}:undefined);
        done({status: response.statusCode, headers: response.headers, body});
      });
      response.on("error", reject);
    });
    request.setTimeout(publicationSecurityOnly?(cleanup?2_000:5_000):30_000, () => request.destroy(new Error("Local API timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function readApi(path) {
  const response = await apiRequest(path, {headers: {
    authorization: "Bearer synthetic-local-owner", "x-opengeo-organization": organization
  }});
  assert.equal(response.status, 200, `${path}: ${response.body}`);
  return JSON.parse(response.body);
}

async function openWorkspaceCollaborators(page) {
  const access = page.locator(".publication-collaborators");
  if (await access.getAttribute("open") === null) await access.locator(":scope > summary").click();
  const collaborators = access.locator(".project-site-collaborators");
  if (await collaborators.getAttribute("open") === null) await collaborators.locator(":scope > summary").click();
  return collaborators;
}

async function worker(timeout = 120_000) {
  assert.ok(!buildingInputPreviewMode, 'Retained input previews cannot run workers');
  if(buildingReviewMode){
    assert.ok(buildingReviewRemaining()>0);assert.ok(['inputs','output'].includes(buildingReviewProgress.workerBatch));
    if(receptorScreeningMode||rasterAccountMode){
      const keys=rasterAccountMode?(rasterValidationMode?['validation']:['comparison','patches']):buildingReviewProgress.workerBatch==='inputs'?buildingInputKeys:['output'],
        queue=JSON.parse(readFileSync(join(work,'queue.json'))),seen=new Set();
      assert.equal(queue.length,keys.length,'Only the admitted exact screening ingestion jobs may run');
      assert.equal(existsSync(join(work,'pmtiles-v2.json'))?JSON.parse(readFileSync(join(work,'pmtiles-v2.json'))).length:0,0);
      for(const message of queue){
        const entries=JSON.parse(message.body).Records;assert.equal(entries.length,1);
        const key=keys.find(key=>entries[0].s3?.object?.key.includes(`/datasets/${buildingReviewProgress.records[key].datasetId}/`));
        assert.ok(key&&!seen.has(key),'Reject unrelated or duplicate screening queue jobs');seen.add(key);
      }
    }
    const batches=buildingReviewProgress.workerBatches??=[];
    assert.ok(batches.length<(rasterAccountMode?1:2)&&!batches.includes(buildingReviewProgress.workerBatch),'Each admitted batch runs once across attempts');
    batches.push(buildingReviewProgress.workerBatch);checkpointBuildingReview({workerBatches:batches});
    timeout=Math.max(1,Math.min(timeout,buildingReviewRemaining()));
  }
  if(baselineStudyMode){assert.equal(baselineProgress.workerRuns??0,0,'One baseline worker batch');
    assert.ok(baselineRemaining()>0);timeout=Math.max(1,Math.min(timeout,baselineRemaining()));checkpointBaseline({workerRuns:1});}
  if(retainedAnalysisMode){assert.equal(ftwWorkerRuns,0,"Retained analysis runs the existing ingestion worker once");
    assert.ok(ftwRemaining()>0);ftwWorkerRuns++;timeout=Math.max(1,Math.min(timeout,ftwRemaining()));checkpointFtw();}
  const pmtilesQueue = join(work, "pmtiles-v2.json");
  const dedicated = existsSync(pmtilesQueue) && JSON.parse(readFileSync(pmtilesQueue)).length > 0;
  if (dedicated) {
    const sharedQueue = join(work, "queue.json");
    assert.equal(existsSync(sharedQueue) ? JSON.parse(readFileSync(sharedQueue)).length : 0, 0,
      "Finish the shared worker queue before executing the dedicated PMTiles lane");
  }
  const [executable, ...args] = JSON.parse(readFileSync(join(work,
    dedicated ? "pmtiles-worker-command.json" : "worker-command.json")));
  assert.equal(executable, "podman");
  const logName = `worker-${Date.now()}-${randomUUID()}.log`, logPath = join(work, logName);
  writeFileSync(logPath, "", {flag: "wx", mode: 0o600});
  if (developmentSmoke) checkpointDevelopment({workerLog: logName});
  if(buildingReviewMode){const logs=buildingReviewProgress.workerLogs??=[];logs.push(logName);checkpointBuildingReview({workerLogs:logs});}
  const output = await new Promise((done, reject) => {
    const process = spawn(executable, args, {timeout});
    const chunks = [];
    const retainOutput = chunk => {appendFileSync(logPath, chunk); chunks.push(chunk);};
    process.stdout.on("data", retainOutput);
    process.stderr.on("data", retainOutput);
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? done(Buffer.concat(chunks))
      : reject(new Error(`Worker exited ${code}: ${Buffer.concat(chunks)}`)));
  });
  console.log(output.toString().trim());
}

const bundle = builtStudio || publicationSecurityOnly ? null : await build({
  stdin: {contents: `
    import {OpenGeoApiClient} from './src/lib/apiClient.js';
    import {PlatformDirectory} from './src/components/PlatformDirectory.js';
    import {ProjectWorkspacePage} from './src/components/ProjectWorkspacePage.js';
    import {mapDatasetRouteTarget, siteResourceRouteTarget, featureRouteTarget} from './src/lib/applicationRoutes.js';
    ${pinnedFontMode ? integratedStudioFontTransport(fontAssets.ranges) : "const mapFontAttachments = null;"}
    const adapter = new OpenGeoApiClient({baseUrl:'/api',
      tokenProvider:()=> 'synthetic-local-' + (sessionStorage.getItem('local-actor') || 'owner'),
      ${publicationProfile ? `previewOrigins:${JSON.stringify({local_only:publicationProfile.previewOrigin})},` : ''}
      organizationProvider:()=> sessionStorage.getItem('local-organization') || (sessionStorage.getItem('local-actor') === 'reviewer' ? null : '${organization}')});
    adapter.kind='api'; adapter.selectOrganization=(id)=>sessionStorage.setItem('local-organization',id);
    const query=new URL(location.href).searchParams;
    const compositionId=query.get('composition');
    const publicationId=query.get('publication');
    const projectId=compositionId || publicationId ? null : query.get('project');
    document.querySelector('main').append(projectId || compositionId || publicationId ? ProjectWorkspacePage({adapter,projectId,compositionId,publicationId,mapFontAttachments,
      mapId:query.get('map'),managementTarget:query.get('manage'),
      selectedDatasetId:query.get('dataset'),mapDatasetTarget:mapDatasetRouteTarget(query),
      siteResourceTarget:siteResourceRouteTarget(query),featureTarget:featureRouteTarget(query)})
      : PlatformDirectory({adapter,view:query.get('view')}));
  `, resolveDir: join(root, "app"), sourcefile: "integrated-studio-entry.js"},
  bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent", metafile: pinnedFontMode,
  plugins: [{name:'framework-stdlib',setup(builder){
    builder.onResolve({filter:/^observablehq:/},({path})=>path==='observablehq:stdlib'
      ? {path:join(root,'app/node_modules/@observablehq/framework/dist/client/stdlib.js')} : {path,external:true});
    builder.onResolve({filter:/^npm:/},({path})=>path==='npm:d3-dsv'
      ? {path:join(root,'app/node_modules/d3-dsv/src/index.js')} : {path,external:true});
  }}],
  outdir: join(work, "bundle"), loader: {".css": "css"}
});
const javascript = bundle?.outputFiles.find((file) => file.path.endsWith(".js")).contents;
if (pinnedFontMode && !builtStudio) {
  assert.ok(Object.keys(bundle.metafile.inputs).some(path => resolve(root, path) === join(root, fontAssets.maplibre.sourcePath)),
    "The bundled Studio must use the checksum-recorded MapLibre source");
  fontProof.studioBundleSha256 = createHash("sha256").update(javascript).digest("hex");
}
const stylesheet = readFileSync(join(root, "app/src/style.css"));
const shell = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local integrated Studio acceptance</title><link rel="stylesheet" href="/style.css">
<style>:root{--theme-background:#fff;--theme-background-alt:#f5f5f5;--theme-foreground:#222;--theme-foreground-focus:#225cbb}body{margin:0;font-family:system-ui;background:var(--theme-background);color:var(--theme-foreground)}main{min-width:0}#local-boundary{padding:4px 12px;font-size:12px;background:#fff6d8;color:#332b0b}</style>
<aside id="local-boundary">Local acceptance · real API, PostGIS and GIS worker · synthetic sign-in and cloud transport</aside>
<main></main><script type="module" src="/studio.js"></script></html>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (developmentMode && (request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin))) return response.writeHead(403).end("Loopback development only");
    if((publicationSecurityOnly||buildingReviewMode)&&path.startsWith('/__local/')&&path!=='/__local/development')return response.writeHead(403).end('This scoped acceptance never starts unselected local work.');
    if (developmentMode && await localAnalysisBridge(request, response, path)) return;
    if (developmentMode && path === "/__local/development" && request.method === "GET") {
      response.setHeader("Content-Type","text/html; charset=utf-8").setHeader("Cache-Control","no-store").end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>OpenGeo community development</title><h1>OpenGeo community development</h1><p>Local development only. Sign-in is synthetic. Database, uploaded files and queued jobs persist after closing Chromium. External browser requests are blocked; choose Blank canvas.</p><p><a href="/" target="_blank">Open Studio</a></p><form method="post" action="/__local/process"><button>Process queued local jobs</button></form><p>After requesting a conversion, image, saved-source build or approved publication in Studio, process the queue here, then refresh that result in Studio. Keep this page available. Close every Chromium window to stop.</p>${publicationProfile ? `<h2>Local publication destination</h2><p>Connect one source owned by the local development account to the local publication hostname. This setting persists. Prepare and approve its release in Studio before processing the publication queue.</p><form method="post" action="/__local/publication-destination"><p><label>Project ID <input name="projectId" required maxlength="36"></label></p><p><label>Source project ID <input name="sourceProjectId" required maxlength="36"></label></p><button>Configure local publication destination</button></form>` : ""}</html>`);
    } else if (developmentMode && publicationProfile && path === "/__local/publication-destination" && request.method === "POST") {
      if (request.headers.origin !== origin) return response.writeHead(403).end("Same-origin action required");
      if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
        return response.writeHead(415).end("Use the local destination form");
      }
      if (developmentWorkerRunning) return response.writeHead(409).end("Local worker is already processing");
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 512) return response.writeHead(413).end("Local destination form is too large");
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const entries = [...form];
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      if (entries.length !== 2 || !["projectId", "sourceProjectId"].every(name => form.getAll(name).length === 1 && uuid.test(form.get(name)))) {
        return response.writeHead(400).end("Enter the existing Project and source project IDs");
      }
      if (developmentWorkerRunning) return response.writeHead(409).end("Local worker is already processing");
      developmentWorkerRunning = true;
      try {
        const apiContainer = JSON.parse(readFileSync(join(work,"local-api-container.json")));
        await localPublicationBridge(apiContainer)({operation:"configure-publication",
          projectId:form.get("projectId"), sourceProjectId:form.get("sourceProjectId")});
      } finally { developmentWorkerRunning = false; }
      response.writeHead(303,{location:"/__local/development"}).end();
    } else if (developmentMode && path === "/__local/process" && request.method === "POST") {
      if (request.headers.origin !== origin) return response.writeHead(403).end("Same-origin action required");
      if (developmentWorkerRunning) return response.writeHead(409).end("Local worker is already processing");
      developmentWorkerRunning = true;
      try {
        const queued = existsSync(join(work,"queue.json")) ? JSON.parse(readFileSync(join(work,"queue.json"),"utf8")) : [];
        if (queued.length) await worker();
        if (existsSync(join(work,"publication-profile.json"))) {
          const {compilerImageDigest} = JSON.parse(readFileSync(join(work,"publication-profile.json")));
          const apiContainer = JSON.parse(readFileSync(join(work,"local-api-container.json")));
          const bridge = localPublicationBridge(apiContainer);
          await processLocalBuildQueue({bridge, compilerImageDigest});
          await processLocalPublicationQueue({bridge});
        }
      } finally { developmentWorkerRunning = false; }
      response.writeHead(303,{location:"/__local/development"}).end();
    } else if (path.startsWith("/api/") || path.startsWith("/public/") || (serviceClientsMode && request.method === "GET" && path.startsWith("/projects/"))) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await apiRequest(path.startsWith("/api/") ? request.url.slice(4) : request.url, {
        method: request.method, headers: request.headers, body: Buffer.concat(chunks)
      });
      response.writeHead(result.status, result.headers).end(result.body);
    } else if (builtStudio && path === "/auth-config.json" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store")
        .end(JSON.stringify({...integratedStudioAuthConfig(origin),
          ...(publicationProfile ? {previewOrigins:{local_only:publicationProfile.previewOrigin}} : {})}));
    } else if (builtStudio) {
      // Playwright's block option injects a navigator.serviceWorker getter into
      // opaque-origin publication frames and itself raises SecurityError.
      // Withhold registration at the transport instead; retain frame isolation.
      if (path === "/service-worker.js") return response.writeHead(404).end();
      const file = request.method === "GET" && builtShell.files.get(path);
      if (!file) return response.writeHead(404).end();
      builtRequests.push({path, sha256:file.sha256, bytes:file.body.length});
      if (pinnedFontMode && path.startsWith("/_file/assets/render-fonts/")) {
        fontRequests.push({path, sha256:file.sha256, bytes:file.body.length});
      }
      response.setHeader("Content-Type", file.contentType).end(file.body);
    } else if (pinnedFontMode && path.startsWith(FONT_ROUTE)) {
      const asset = request.method === "GET" && fontAssets.files.get(request.url);
      if (!asset) return response.writeHead(404).end();
      fontRequests.push({path, sha256: createHash("sha256").update(asset.bytes).digest("hex"), bytes: asset.bytes.length});
      response.setHeader("Content-Type", asset.contentType).end(asset.bytes);
    } else if (path === "/studio.js") response.setHeader("Content-Type", "text/javascript").end(javascript);
    else if (path === "/style.css") response.setHeader("Content-Type", "text/css").end(stylesheet);
    else if (["/", "/workspaces"].includes(path)) response.setHeader("Content-Type", "text/html").end(shell);
    else response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Local harness transport failed");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
if (developmentMode) localAnalysisBridge = baselineStudyMode||buildingReviewMode?async()=>false:createLocalAnalysisBridge({runner: localAnalysisRunner, origin});
let browser, page, previewServer, publicServer, publicationBrowserTimer, developmentBrowserTimer,ftwBrowserTimer;
const previewOrigin = publicationProfile?.previewOrigin;
const publicOrigin = publicationProfile?.publicationOrigin;
const canonicalPublicOrigin = publicationProfile?.publicationCanonicalOrigin;
const errors = [];
let stage = "project-creation";
let pmtilesConversion = {status: "not-exercised", reason: "dedicated-converter-unconfigured"};
let previewDeliveryTime=null;
let previewExchange={sequence:0};
const previewExchangeObserver=publicationSecurityOnly
  ?(await import('./integrated-studio-publication.mjs')).observePublicationPreviewExchange:null;
const observePreviewExchange=()=>structuredClone(previewExchange);
const previewApiRequest=async(path,options)=>{
  const result=await apiRequest(path,options);
  if(publicationSecurityOnly&&path==='/observable-preview/exchange'){
    // Capture only bounded, non-secret metadata before the bootstrap redirects;
    // Playwright response.json() after navigation can lose its response body.
    previewExchange=previewExchangeObserver(previewExchange,path,options,result);
  }
  return result;
};
const expirePreviewCookies=expiresAt=>{
  assert.ok(publicationSecurityOnly&&previewDeliveryTime===null);
  const expiry=Date.parse(expiresAt),realNow=Date.now();
  assert.ok(Number.isFinite(expiry)&&expiry>realNow,'Only the actual unexpired signed grant may advance the local verifier clock.');
  previewDeliveryTime=expiry+1;
  return {mode:'controlled-local-delivery-clock',actualGrantExpiresAt:expiresAt,
    realElapsedAtAdvance:new Date(realNow).toISOString(),verifierNow:new Date(previewDeliveryTime).toISOString(),
    signedPolicyUnchanged:true,sqlClockUnchanged:true,productionExpiryAcceptance:false};
};
try {
  if (publicationProfile) previewServer = await startLocalPreviewServer({work, profile: publicationProfile, studioOrigin: origin, apiRequest:previewApiRequest,
    ...(publicationSecurityOnly?{now:()=>previewDeliveryTime??Date.now()}:{})});
  if (publicOrigin&&!publicationSecurityOnly) {
    const publicUrl=new URL(publicOrigin);
    assert.ok(publicUrl.origin===publicOrigin&&publicUrl.protocol==='http:'&&publicUrl.hostname==='127.0.0.1'&&publicUrl.port
      &&publicOrigin!==origin&&publicOrigin!==previewOrigin&&canonicalPublicOrigin==='https://publication.local.invalid');
    const bridge=localPublicationBridge(JSON.parse(readFileSync(join(work,'local-api-container.json'))));
    const publicRead=boundedLocalPublicationReader(bridge);
    publicServer=createServer(async(request,response)=>{
      response.setHeader('Cache-Control','no-store').setHeader('X-Content-Type-Options','nosniff');
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'self'; form-action 'none'");
      try {
        if(request.headers.host!==publicUrl.host||request.headers.authorization||!['GET','HEAD'].includes(request.method))return response.writeHead(403).end();
        let path=new URL(request.url,publicOrigin).pathname,reviewId;
        const retained=/^\/_editions\/([0-9a-f-]{36})(\/.*)$/.exec(path);
        if(retained){reviewId=retained[1];path=retained[2];}
        const record=await publicRead({operation:'public-read',path,...(reviewId?{reviewId}:{})});
        if(!record)return response.writeHead(404).end();
        if(record.redirect)return response.writeHead(302,{location:(reviewId?`/_editions/${reviewId}`:'')+record.redirect}).end();
        response.writeHead(200,{'Content-Type':record.content_type,'X-OpenGeo-Local-Release':record.release_prefix});
        return response.end(request.method==='HEAD'?undefined:Buffer.from(record.body,'base64'));
      }catch(error){return response.writeHead(error?.code==='local_publication_read_busy'?503:404).end();}
    });
    await new Promise((done,reject)=>{publicServer.once('error',reject);publicServer.listen(Number(publicUrl.port),'127.0.0.1',done);});
  }
  scopedJourney: {
  const executablePath = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(executablePath, "Cached system Chromium is required");
  browser = await chromium.launch({headless: buildingReviewMode || publicationOnlyMode || !developmentMode || developmentSmoke || baselineStudyMode, chromiumSandbox: Boolean(developmentMode && !developmentSmoke && !publicationOnlyMode&&!baselineStudyMode&&!buildingReviewMode), executablePath, args: [...(developmentMode && !developmentSmoke && !publicationOnlyMode&&!baselineStudyMode&&!buildingReviewMode ? [] : ["--no-sandbox"]),
    ...(buildingReviewMode || pinnedFontMode || developmentSmoke || mapArtifactMode || retainedAnalysisMode || baselineStudyMode ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking", "--disable-dev-shm-usage"] : [])]});
  if(retainedAnalysisMode){assert.ok(ftwRemaining()>0);ftwBrowserTimer=setTimeout(()=>void browser.close(),Math.max(1,ftwRemaining()-500));}
  if(baselineStudyMode){assert.ok(baselineRemaining()>0);ftwBrowserTimer=setTimeout(()=>void browser.close(),Math.max(1,baselineRemaining()-500));}
  if(buildingReviewMode){assert.ok(buildingReviewRemaining()>0);ftwBrowserTimer=setTimeout(()=>void browser.close(),Math.max(1,buildingReviewRemaining()-500));}
  if (developmentSmoke) developmentBrowserTimer = setTimeout(() => void browser.close(),
    Math.max(1, (printSmoke ? 150_000 - printPriorMilliseconds : developmentActiveTimeLimit - developmentPriorMilliseconds)
      - (Date.now() - developmentStarted)));
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
  if (publicationOnlyMode) {
    publicationBrowserTimer=setTimeout(()=>void browser.close(),mapArtifactMode?Math.max(1,90_000-mapArtifactPriorMilliseconds-(Date.now()-mapArtifactStarted)):catalogStudyMode?90_000:publicationSecurityOnly?75_000:60_000);
    let browserRequests=0;
    context.on('request',()=>assert.ok(++browserRequests<=(publicationSecurityOnly?120:500),'Publication browser request ceiling'));
  }
  if (builtStudio) await context.addInitScript(initializeIntegratedStudioSession, {organization,origin});
  if (managedCogMode||baselineStudyMode||buildingReviewMode) await context.addInitScript(installIntegratedNativeUploadCapture,{datasetOnly:baselineStudyMode||buildingReviewMode});
  if (pinnedFontMode) await context.addInitScript(() => {
    window.__opengeoIntegratedFontProbe = {localGlyphCalls: 0};
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      window.__opengeoIntegratedFontProbe.localGlyphCalls++;
      return fillText.apply(this, args);
    };
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if(stacItemsMode&&request.url().split('?')[0]===buildingReviewProfile.fixture.query.endpoint){
      assert.ok(!buildingReviewProfile.readOnlyProjectRemainder,'Reuse the retained registered Item without another search');
      const query=buildingReviewProfile.fixture.query,url=new URL(request.url()),params=url.searchParams;
      assert.equal(request.method(),'GET');assert.equal(request.headers().authorization,undefined);
      assert.deepEqual([...params.keys()].sort(),['bbox','collections','datetime','limit']);
      assert.equal(params.get('collections'),query.collections.join(','));assert.equal(params.get('bbox'),query.bbox.join(','));
      assert.equal(params.get('limit'),String(query.limit));const interval=params.get('datetime').split('/');
      assert.deepEqual(interval.map(value=>new Date(value).toISOString()),[query.start,query.end].map(value=>new Date(value).toISOString()));
      const count=(buildingReviewProgress.metadataFixtureReplays??0)+1;assert.ok(count<=buildingReviewProfile.maximumMetadataFixtureReplays&&buildingReviewRemaining()>0);
      checkpointBuildingReview({metadataFixtureReplays:count});
      await route.fulfill({status:200,contentType:'application/geo+json',headers:{'Access-Control-Allow-Origin':'*'},body:stacFixture.metadata});return;
    }
    if(stacItemsMode&&request.url()===stacFixture.assetUrl){
      assert.equal(request.method(),'GET');assert.equal(request.headers().authorization,undefined);
      const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers().range??'');assert.ok(range,'Only admitted retained byte ranges');
      const start=Number(range[1]),end=Number(range[2]);assert.ok(start<=end&&end<stacFixture.raster.length);
      const body=stacFixture.raster.subarray(start,end+1),count=(buildingReviewProgress.retainedRasterRanges??0)+1,
        bytes=(buildingReviewProgress.retainedRasterBytes??0)+body.length;
      assert.ok(count<=buildingReviewProfile.maximumRetainedRasterRanges&&bytes<=buildingReviewProfile.maximumRetainedRasterBytes&&buildingReviewRemaining()>0);
      const ranges=buildingReviewProgress.retainedRanges??[];ranges.push({start,endInclusive:end,bytes:body.length});
      checkpointBuildingReview({retainedRasterRanges:count,retainedRasterBytes:bytes,retainedRanges:ranges});
      await route.fulfill({status:206,contentType:'image/tiff; application=geotiff; profile=cloud-optimized',headers:{
        'Content-Range':`bytes ${start}-${end}/${buildingReviewProfile.stac.sizeBytes}`,'Content-Length':String(body.length),
        'Accept-Ranges':'bytes',ETag:stacFixture.rangeReceipt.headers.ETag,'Access-Control-Allow-Origin':'*'},body});return;
    }
    if (request.url() === uploadUrl) {
      assert.equal(request.method(), "POST");
      assert.equal(request.headers().authorization, undefined);
      let body=request.postDataBuffer(),headers=request.headers();
      if(managedCogMode||baselineStudyMode||buildingReviewMode){
        const capture=await request.frame().evaluate(()=>{
          const value=globalThis.__opengeoIntegratedNativeUpload;
          delete globalThis.__opengeoIntegratedNativeUpload;
          return value;
        });
        if(!capture&&baselineStudyMode){
          assert.ok(baselineProgress.publication,'Only the existing authored-file publication transport follows the two dataset uploads');
        }else{
        assert.equal(capture?.url,uploadUrl);assert.equal(capture.method,'POST');
        assert.equal(capture.contentType,headers['content-type']);
        assert.ok(Array.isArray(capture.bytes)&&capture.bytes.length>0&&capture.bytes.length<=1_048_576
          &&capture.bytes.every(value=>Number.isInteger(value)&&value>=0&&value<=255));
        const cdpBytes=body?.length??0;body=Buffer.from(capture.bytes);
        headers={...headers,'content-length':String(body.length)};
        const transport={
          method:'native-Request-clone-arrayBuffer',bytes:body.length,cdpBytes,
          sha256:createHash('sha256').update(body).digest('hex'),
          exactNativeBoundaryPreserved:true,formReconstructed:false};
        if(baselineStudyMode){const transports=baselineProgress.uploadTransports??=[];assert.ok(transports.length<2);transports.push(transport);checkpointBaseline({uploadTransports:transports});}
        else if(buildingReviewMode){const transports=buildingReviewProgress.uploadTransports??=[];assert.ok(transports.length<buildingUploadLimit);transports.push(transport);checkpointBuildingReview({uploadTransports:transports});}
        else writeFileSync(join(work,'managed-cog-upload-transport.json'),JSON.stringify(transport,null,2)+'\n');
        }
      }
      const result = await apiRequest("/__local/upload", {
        method: "POST", headers, body
      });
      await route.fulfill({status: result.status, body: result.body});
    } else if (request.url().startsWith(`${uploadUrl}/`)) {
      const result = localObjectDownload({work, url: request.url(), method: request.method(), headers: request.headers()});
      if(buildingInputPreviewMode&&result.status===200){
        const records=Object.values(buildingReviewProgress.records).filter(value=>value.checksumSha256);
        const digest=createHash('sha256').update(result.body).digest('hex');
        assert.ok(records.some(record=>record.checksumSha256===digest&&record.sizeBytes===result.body.length),'Only admitted original bytes may be read');
        const reads=(buildingReviewProgress.exactOriginalReadbacks??0)+1,bytes=(buildingReviewProgress.exactOriginalReadbackBytes??0)+result.body.length;
        assert.ok(reads<=buildingReviewProfile.maximumOriginalReadbacks&&bytes<=buildingReviewProfile.maximumOriginalReadbackBytes&&buildingReviewRemaining()>0);
        checkpointBuildingReview({exactOriginalReadbacks:reads,exactOriginalReadbackBytes:bytes});
      }
      if(rasterAccountMode&&result.status===200){
        const source=buildingReviewProfile.source,url=new URL(request.url()),key=decodeURIComponent(url.pathname),
          sourceRead=key.includes(`/projects/${source.projectId}/datasets/${source.datasetId}/`);
        if(sourceRead){assert.ok(request.headers().range,'The retained COG only supports deliberate bounded display ranges');
          assert.equal(result.body.length,810);assert.equal(createHash('sha256').update(result.body).digest('hex'),source.checksumSha256);}
        else{const progress=buildingReviewProgress,record=Object.values(progress.records).find(value=>key.includes(`/projects/${source.projectId}/datasets/${value.datasetId}/`)),
          urlSha256=createHash('sha256').update(request.url()).digest('hex'),
          ticket=progress.outputDownloadTickets?.find(value=>value.datasetId===record?.datasetId&&value.urlSha256===urlSha256&&!value.transportRead);
          assert.ok(record&&ticket,'Use a fresh exact-output ticket for each admitted audit or render read');
          assert.equal(ticket.datasetVersionId,record.datasetVersionId);assert.equal(ticket.objectId,record.archiveObjectId);
          assert.equal(createHash('sha256').update(result.body).digest('hex'),record.archiveChecksumSha256);ticket.transportRead=true;
          if(ticket.purpose==='audit'){
            assert.ok(record.archiveReadAttempted&&!record.archiveTransportRead,'Each exact full original audit is read once');record.archiveTransportRead=true;
            const bytes=(progress.archiveReadbackBytes??0)+result.body.length;assert.ok(bytes<=buildingReviewProfile.maximumArchiveReadbackBytes);checkpointBuildingReview({archiveReadbackBytes:bytes});
          }else{
            assert.ok(record.archiveVerified&&(record.renderTransportReads??0)<2&&(progress.renderTransportReads??0)<buildingReviewProfile.maximumOutputDisplayOriginalReads);
            const bytes=(progress.renderReadBytes??0)+result.body.length;assert.ok(bytes<=buildingReviewProfile.maximumOutputDisplayBytes);
            record.renderTransportReads=(record.renderTransportReads??0)+1;
            checkpointBuildingReview({renderTransportReads:(progress.renderTransportReads??0)+1,renderReadBytes:bytes});
          }}
      }
      if((managedCogMode||(baselineStudyMode||rasterAccountMode)&&request.headers().range)&&result.status===200){
        // Reuse the issued-ticket/immutable-object verifier above. Only this
        // selected 810-byte native pilot gains an offline HTTP range transport.
        assert.equal(result.body.length,810);
        const cogHash=rasterAccountMode?buildingReviewProfile.source.checksumSha256:baselineStudyMode?baselineProfile.inputs.landcover.sha256:managedCogProfile.sourceSha256;
        assert.equal(createHash('sha256').update(result.body).digest('hex'),cogHash);
        const ranges=rasterAccountMode?(buildingReviewProgress.objectRanges??=[]):baselineStudyMode?(baselineProgress.objectRanges??=[]):managedCogRanges;
        assert.ok((rasterAccountMode?buildingReviewRemaining():baselineStudyMode?baselineRemaining():ftwRemaining())>0);assert.ok(ranges.length<(rasterAccountMode?buildingReviewProfile.maximumCogRangeRequests:16),'Managed COG journey range request ceiling');
        const match=/^bytes=(\d+)-(\d+)$/.exec(request.headers().range??'');
        assert.ok(match,'Managed COG requires one bounded byte range without a full-file fallback');
        const start=Number(match[1]),requestedEnd=Number(match[2]),end=Math.min(requestedEnd,result.body.length-1);
        assert.ok(Number.isSafeInteger(start)&&Number.isSafeInteger(requestedEnd)&&start>=0&&requestedEnd>=start);
        const etag=`"${cogHash}"`;
        if(request.headers()['if-match'])assert.equal(request.headers()['if-match'],etag);
        if(start>=result.body.length){
          await route.fulfill({status:416,headers:{'Content-Range':`bytes */${result.body.length}`},body:''});
        }else{
          const body=result.body.subarray(start,end+1);
          ranges.push({start,endInclusive:end,requestedEndInclusive:requestedEnd,bytes:body.length,etag});
          if(rasterAccountMode){assert.ok(ranges.reduce((sum,range)=>sum+range.bytes,0)<=buildingReviewProfile.maximumCogRangeBytes);checkpointBuildingReview({objectRanges:ranges});}
          else if(baselineStudyMode){assert.ok(ranges.reduce((sum,range)=>sum+range.bytes,0)<=12960);checkpointBaseline({objectRanges:ranges});}else checkpointFtw();
          await route.fulfill({status:206,contentType:result.contentType,headers:{
            'Content-Range':`bytes ${start}-${end}/${result.body.length}`,'Content-Length':String(body.length),
            'Accept-Ranges':'bytes',ETag:etag,'Access-Control-Allow-Origin':origin,
            'Access-Control-Expose-Headers':'Content-Range, Content-Length, Accept-Ranges, ETag'},body});
        }
      }else await route.fulfill(result);
    } else if (canonicalPublicOrigin && new URL(request.url()).origin===canonicalPublicOrigin) {
      assert.ok(['GET','HEAD'].includes(request.method()));
      const target=new URL(request.url());
      const result=await fetch(publicOrigin+target.pathname+target.search,{method:request.method(),redirect:'manual'});
      await route.fulfill({status:result.status,headers:Object.fromEntries(result.headers),body:Buffer.from(await result.arrayBuffer())});
    } else if (mapArtifactMode && ['blob:','data:'].includes(new URL(request.url()).protocol)) await route.continue();
    else if (request.url().startsWith(`${origin}/`) || (previewOrigin && request.url().startsWith(`${previewOrigin}/`)) || (publicOrigin && request.url().startsWith(`${publicOrigin}/`))) await route.continue();
    else if (rendererPersistenceMode || geolibreImportMode) await route.fulfill({contentType:"application/json",body:JSON.stringify(
      new URL(request.url()).hostname.includes("mapbox") ? {} : {version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"#ffffff"}}]})});
    else {if(retainedAnalysisMode)ftwBlockedExternal.push(new URL(request.url()).origin);await route.abort();}
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  if (publicationOnlyMode) {
    stage = "native-publication";
    const {exerciseNativePublication} = await import('./integrated-studio-publication.mjs');
    const publication = await exerciseNativePublication({page, browser, context, origin, organization,
      apiRequest, work, publicationProfile,securityOnly:publicationSecurityOnly,
      catalogStudy:catalogStudyMode,mapArtifact:mapArtifactMode,
      ...(publicationSecurityOnly?{expirePreviewCookies,observePreviewExchange,securityPreviousRequests,securityReconciliation}:{})});
    assert.deepEqual(errors,[], 'Publication source UI and native preview page errors');
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",publication,
      requestCount:requests.length,...(publicationSecurityOnly?{apiRequestAttempts:publicationSecurityRequests,
        priorApiRequestAttempts:securityPriorApiRequests,
        cumulativeApiRequestAttempts:securityPriorApiRequests+publicationSecurityRequests,
        regularApiAttempts:publicationSecurityRegularRequests,cleanupApiAttempts:publicationSecurityCleanupRequests}:{}),
      ...(mapArtifactMode?{apiRequestAttempts:mapArtifactApiAttempts,priorApiRequestAttempts:mapArtifactPriorApiAttempts,
        cumulativeApiRequestAttempts:mapArtifactPriorApiAttempts+mapArtifactApiAttempts}:{}),
      ...(catalogStudyMode?{apiRequestAttempts:catalogStudyApiAttempts,priorApiRequestAttempts:catalogStudyPriorApiAttempts,
        cumulativeApiRequestAttempts:catalogStudyPriorApiAttempts+catalogStudyApiAttempts}:{}),
      applicationShell:builtShell?.evidence ?? {mode:publicationSecurityOnly?'retained private preview bootstrap; no application build':'existing source UI bundle'},
      notProven:["Compiled Studio delivery","Fresh installation","Production authentication and transport"]},null,2)+"\n");
    break scopedJourney;
  }
  if (developmentMode) {
    console.log(`Local development: ${origin}/__local/development (synthetic sign-in; external requests blocked)`);
    await page.goto(`${origin}/__local/development`);
    if(buildingReviewMode){
      stage=buildingReviewPrefix;
      const exercise=buildingInputPreviewMode?exerciseBuildingInputPreview:stacItemsMode?exerciseStacItems:rasterAccountMode?exerciseRasterCatalog:receptorScreeningMode?exerciseReceptorScreening:exerciseBuildingReview;
      const result=await exercise({page,context,origin,organization,work,readApi,apiRequest,worker,
        progress:buildingReviewProgress,profile:buildingReviewProfile,
        inputProfile:realBuildingReviewMode?buildingReviewProfile.inputProfile:undefined,checkpoint:checkpointBuildingReview});
      assert.deepEqual(errors,[]);checkpointBuildingReview({status:'pass'});
      writeFileSync(join(work,`${buildingReviewPrefix}-browser-result.json`),JSON.stringify({status:'pass',[buildingInputPreviewMode?'buildingInputPreview':stacItemsMode?'stacItems':rasterValidationMode?'rasterValidation':rasterCatalogMode?'rasterCatalog':receptorScreeningMode?'receptorScreening':'buildingReview']:result,
        apiRequestAttempts:buildingReviewProgress.apiRequestAttempts,applicationShell:builtShell.evidence},null,2)+'\n',{mode:0o600});
      break scopedJourney;
    }
    if(baselineStudyMode){
      stage='baseline-study';
      const baseline=await exerciseBaselineStudy({page,context,origin,organization,work,readApi,worker,
        baseline:baselineProgress,profile:baselineProfile,checkpoint:checkpointBaseline});
      const {exerciseBaselinePublication}=await import('./integrated-studio-publication.mjs');
      await exerciseBaselinePublication({page,origin,organization,apiRequest,readApi,work,
        publicationProfile:{...publicationProfile,...baselineProfile},baseline,checkpoint:checkpointBaseline});
      assert.deepEqual(errors,[]);checkpointBaseline({status:'pass'});
      writeFileSync(join(work,'baseline-browser-result.json'),JSON.stringify({status:'pass',baseline,applicationShell:builtShell.evidence,
        notProven:['Production identity/AWS transport','Public release authorization','Full baseline capability queue']},null,2)+'\n');
      break scopedJourney;
    }
    if (developmentSmoke) {
      if (printSmoke) {
        stage = printTemplateSmoke ? "development-print-template" : "development-print";
        const {exerciseDevelopmentPrint} = await import('./integrated-studio-print.mjs');
        const print = await exerciseDevelopmentPrint({page, context, origin, work, organization, readApi,
          seedProgress: developmentProgress, printProgress, checkpointPrint});
        assert.deepEqual(errors, []);
        // Advance only the canonical head. Preserve all earlier fixture costs and receipts.
        Object.assign(developmentProgress, {map: print.savedMap,
          [printTemplateSmoke ? "printTemplateContinuation" : "printContinuation"]:
            {checkpoint: printTemplateSmoke ? "print-template-smoke.json" : "print-smoke.json", layoutId: printProgress.layoutId}});
        writeFileSync(developmentCheckpoint, JSON.stringify(developmentProgress, null, 2) + "\n");
        checkpointPrint({status: "pass"});
        const result = {status: "pass", print, applicationShell: builtShell.evidence,
          requestCount: requests.length, apiRequestAttempts: printProgress.apiRequestAttempts,
          activeMilliseconds: printProgress.activeMilliseconds,
          notProven: ["Independent human installation", "Production identity/delivery", "Full platform parity"]};
        for (const name of printTemplateSmoke ? ["print-template-browser-result.json", "print-template-smoke-result.json"]
          : ["browser-result.json", "print-smoke-result.json"])
          writeFileSync(join(work, name), JSON.stringify(result, null, 2) + "\n");
        console.log("Print Studio: two-frame layout saved, freshly reopened, recaptured and inspected as SVG");
        break scopedJourney;
      }
      if (postgisFixture) {
        stage = "development-postgis";
        const {exerciseDevelopmentPostgis} = await import('./integrated-studio-postgis.mjs');
        const postgis = await exerciseDevelopmentPostgis({page, context, origin, organization, work,
          apiRequest, readApi, requests, errors});
        assert.deepEqual(errors, []);
        writeFileSync(join(work, "browser-result.json"), JSON.stringify({status: "pass", postgis,
          applicationShell: builtShell.evidence, requestCount: requests.length,
          notProven: ["Remote PostgreSQL TLS or secrets transport", "Production identity/delivery", "Full platform parity"]}, null, 2) + "\n");
        console.log("Development smoke: PostGIS discovery, Layer registration, Catalog preview and access checks pass");
        break scopedJourney;
      }
      stage = "development-core";
      const fixturePath = "app/src/data/sample-public-facilities.geojson";
      const fixtureBytes = readFileSync(join(root, fixturePath));
      const fixture = JSON.parse(fixtureBytes);
      const fixtureMetadata = JSON.parse(readFileSync(join(root, "app/src/data/public-demo-catalog.json")))
        .entries.find(record => record.id === "public-community-facilities");
      const fixtureRights = fixtureMetadata.sourceFiles.find(record => record.path === "/data/sample-public-facilities.geojson");
      assert.equal(fixtureRights.license, "CC0-1.0");
      assert.equal(fixtureBytes.length, 1472);
      assert.equal(fixture.type, "FeatureCollection");
      assert.equal(fixture.features.length, 5);
      assert.ok(fixture.features.every(feature => feature.geometry.type === "Point"));
      const expectedNames = fixture.features.map(feature => feature.properties.name).sort();
      const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
      assert.equal(fixtureSha256, "b384b0990bc62a8a5339e801098f995989bd6a770fdbf5fe7f58025a2351c96c");
      if (developmentProgress.fixture) assert.equal(developmentProgress.fixture.sha256, fixtureSha256);
      checkpointDevelopment({fixture: {path: fixturePath, sha256: fixtureSha256, bytes: fixtureBytes.length,
        featureNames: expectedNames, metadata: {title: fixtureMetadata.title, description: fixtureMetadata.summary,
          license: fixtureRights.license, attribution: fixtureRights.attribution}}});
      const wasSaved = developmentProgress.styledSaved === true;
      const datasetName = "Community development facilities";
      const mapPath = () => `/projects/${developmentProgress.project}/maps/${developmentProgress.map.id}`;
      async function assertRenderedMap() {
        await page.waitForFunction(({datasetId, names}) => {
          const shell = document.querySelector(".opengeo-workbench"), map = shell?.__opengeoMap;
          const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === datasetId);
          if (!map?.isStyleLoaded() || map.isMoving() || !layer || !map.getLayer(`${layer.layerId}-points`)) return false;
          const rendered = new Set(map.queryRenderedFeatures({layers: [`${layer.layerId}-points`]}).map(feature => feature.properties.name));
          return names.every(name => rendered.has(name)) && layer.style.circleColor === "#2563eb" && layer.opacity === 0.8
            && map.getPaintProperty(`${layer.layerId}-points`, "circle-color") === "#2563eb"
            && map.getPaintProperty(`${layer.layerId}-points`, "circle-opacity") === 0.8;
        }, {datasetId: developmentProgress.datasetId, names: expectedNames});
      }
      if (!developmentProgress.project) {
        assert.ok(!developmentProgress.creationAttempted, "Project creation response unresolved; retain checkpoint and reconcile before retrying");
        checkpointDevelopment({creationAttempted: true});
        await page.goto(`${origin}/workspaces`);
        await page.getByRole("link",{name:/New Project/}).click();
        await page.getByLabel("New project name",{exact:true}).fill("Community development persistence smoke");
        await page.getByLabel("First map name",{exact:true}).fill("Retained local map");
        const created=page.waitForResponse(r=>r.url().endsWith("/api/projects") && r.request().method()==="POST");
        const mapCreated=page.waitForResponse(r=>/\/api\/projects\/[^/]+\/maps$/.test(r.url()) && r.request().method()==="POST");
        await page.getByRole("button",{name:"Create project and map",exact:true}).click();
        const projectResponse=await created, mapResponse=await mapCreated;
        assert.equal(projectResponse.status(),201); assert.equal(mapResponse.status(),201);
        await page.locator(".opengeo-workbench").waitFor();
      }
      if (!developmentProgress.map) {
        const maps = await readApi(`/projects/${developmentProgress.project}/maps`);
        assert.equal(maps.length, 1, "Retained Project needs its committed map reconciled before continuation");
        checkpointDevelopment({map: maps[0]});
      }
      if (!developmentProgress.styledSaved) {
        if (!developmentProgress.uploadCompleted) {
          assert.ok(!developmentProgress.uploadAttempted, "Upload already attempted; reconcile its retained ticket before another transfer");
          await page.goto(`${origin}/workspaces?project=${developmentProgress.project}&manage=data`);
          await page.getByLabel("Dataset, image, or document file", {exact: true}).setInputFiles({
            name: "sample-public-facilities.geojson", mimeType: "application/geo+json", buffer: fixtureBytes});
          await page.getByLabel("Dataset, image, or document name", {exact: true}).fill(datasetName);
          await page.getByLabel("Dataset description", {exact: true}).fill(`${fixtureMetadata.summary} ${fixtureRights.license}; ${fixtureRights.attribution}.`);
          await page.getByLabel("Dataset classification", {exact: true}).selectOption("internal");
          const completed = page.waitForResponse(response => response.url().endsWith("/complete") && response.request().method() === "POST");
          checkpointDevelopment({uploadAttempted: true});
          await page.getByRole("button", {name: "Hash and upload", exact: true}).click();
          assert.equal((await completed).status(), 200);
        }
        const datasetPath = `/projects/${developmentProgress.project}/datasets/${developmentProgress.datasetId}`;
        let dataset = await readApi(datasetPath);
        const assertDatasetIdentity = () => {
          assert.equal(dataset.id, developmentProgress.datasetId);
          assert.equal(dataset.project_id, developmentProgress.project);
          assert.equal(typeof developmentProgress.datasetVersionId, "string");
          assert.equal(dataset.current_version_id, developmentProgress.datasetVersionId);
          assert.equal(dataset.source_type, "upload"); assert.equal(dataset.format, "geojson");
        };
        const ingestCompleted = () => dataset.status === "active" && dataset.current_version_state === "active"
          && dataset.processing_job_state === "completed" && dataset.processing_error_code === null && dataset.feature_count === 5;
        assertDatasetIdentity();
        if (!developmentProgress.workerCompleted && ingestCompleted()) {
          checkpointDevelopment({workerCompleted: true, workerReconciledFromDataset: true});
        }
        if (!developmentProgress.workerCompleted) {
          assert.ok(!developmentProgress.workerAttempted, "Worker already attempted; inspect retained result before another run");
          checkpointDevelopment({workerAttempted: true});
          await worker(30_000);
          dataset = await readApi(datasetPath);
          assertDatasetIdentity();
          assert.ok(ingestCompleted(), "The exact uploaded version must have a completed ingest and five features");
          checkpointDevelopment({workerCompleted: true});
        }
        assert.ok(ingestCompleted(), "The retained uploaded version must still have a completed ingest and five features");
        if (!developmentProgress.catalogRendered) {
          const beforePreview = await readApi(mapPath());
          await page.goto(`${origin}/layers?id=${developmentProgress.datasetId}`);
          await page.getByRole("heading", {name: datasetName, exact: true}).waitFor();
          await page.getByRole("button", {name: "Preview archived data", exact: true}).click();
          const blankPreview = page.getByRole("button", {name: "Use blank basemap", exact: true});
          if (await blankPreview.isVisible()) await blankPreview.click();
          await page.waitForFunction(names => {
            const map = document.querySelector(".layer-resource-archive-preview .map-frame")?.__opengeoMap;
            if (!map?.isStyleLoaded() || map.isMoving() || !map.getLayer("preview-points")) return false;
            const rendered = new Set(map.queryRenderedFeatures({layers: ["preview-points"]}).map(feature => feature.properties.name));
            return names.every(name => rendered.has(name));
          }, expectedNames);
          assert.deepEqual(await readApi(mapPath()), beforePreview, "Catalog inspection must not save or alter a Project");
          checkpointDevelopment({catalogRendered: true});
        }
        checkpointDevelopment({phase: "map-add"});
        await page.goto(`${origin}/workspaces?project=${developmentProgress.project}&manage=data`);
        const card = page.locator(`[data-dataset-id="${developmentProgress.datasetId}"]`);
        await card.getByText("Add to map…", {exact: true}).click();
        await card.getByRole("link", {name: "Add to Retained local map", exact: true}).click();
        await page.getByRole("button", {name: `Add ${datasetName} to map`, exact: true}).click();
        await page.getByRole("heading", {name: "Layer Properties", exact: true}).waitFor();
        // Choose the actual blank basemap before styling; no tile responses are substituted.
        checkpointDevelopment({phase: "basemap"});
        await page.locator('.gis-menubar [data-menu="view"] > button').click();
        await page.getByRole("menuitem", {name: "Change basemap", exact: true}).click();
        const basemapDialog = page.getByRole("dialog", {name: "Change basemap", exact: true});
        const blank = basemapDialog.locator('.gis-basemap-card[data-catalog-id="blank"]');
        const group = blank.locator("xpath=ancestor::details[1]");
        if (await group.getAttribute("open") === null) await group.locator("summary").click();
        await blank.click();
        await basemapDialog.getByRole("button", {name: "Done", exact: true}).click();
        checkpointDevelopment({phase: "style"});
        await styleLayer(page, `${datasetName} · saved v1`, "#2563eb", 0.8);
        await page.getByRole("button", {name: "Fit", exact: true}).click();
        checkpointDevelopment({phase: "render"});
        await assertRenderedMap();
        checkpointDevelopment({phase: "save"});
        const saved = page.waitForResponse(response => /\/maps\/[^/]+$/.test(response.url()) && response.request().method() === "PATCH");
        await page.getByRole("button", {name: "Save", exact: true}).click();
        assert.equal((await saved).status(), 200);
        checkpointDevelopment({map: await readApi(mapPath()), styledSaved: true});
      }
      assert.deepEqual(await readApi(mapPath()), developmentProgress.map);
      const [layer] = developmentProgress.map.definition.layers;
      assert.equal(developmentProgress.map.definition.layers.length, 1);
      assert.equal(layer.datasetId, developmentProgress.datasetId);
      assert.equal(layer.datasetVersionId, developmentProgress.datasetVersionId);
      assert.equal(layer.style.circleColor, "#2563eb"); assert.equal(layer.opacity, 0.8);
      checkpointDevelopment({phase: "reopen"});
      await page.goto(`${origin}/workspaces?composition=${developmentProgress.map.id}`);
      await assertRenderedMap();
      checkpointDevelopment({reopened: true, databaseRestartReopened: wasSaved || developmentProgress.databaseRestartReopened === true});
      assert.deepEqual(errors,[]);
      writeFileSync(join(work, "browser-result.json"), JSON.stringify({status: "pass", development: developmentProgress,
        applicationShell: builtShell.evidence, requestCount: requests.length,
        notProven: ["Fresh image installation", "Independent operator installation", "Production identity/delivery"]}, null, 2) + "\n");
      console.log(`Development smoke: Catalog, styled UI Save and exact rendered reopen pass${wasSaved ? " after database restart" : ""}`);
      break scopedJourney;
    }
    for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>browser.close());
    await new Promise(done => browser.once("disconnected",done));
    break scopedJourney;
  }
  console.log(`Studio: ${stage}`);
  if (builtStudio) {
    stage = "built-home-navigation";
    await page.goto(origin);
    await page.locator(".opengeo-start").waitFor();
    assert.equal(await page.locator("#observablehq-sidebar").count(), 0);
    const start = page.getByRole("dialog", {name:"OpenGeo Studio start", exact:true});
    await start.getByRole("link", {name:/^Open a project/}).click();
    await page.waitForURL(`${origin}/workspaces`);
    assert.equal(await page.locator(".observablehq--error").count(), 0);
  } else await page.goto(`${origin}/workspaces`);
  stage = "project-creation";
  await page.getByRole("link", {name: /New Project/}).click();
  await page.getByLabel("New project name", {exact: true}).fill("Watershed Studio pilot");
  await page.getByLabel("First map name", {exact: true}).fill("Watershed review map");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Create project and map", exact: true}).click();
  const projectResponse = await created;
  assert.equal(projectResponse.status(), 201);
  const project = await projectResponse.json();
  await page.waitForURL((url) => Boolean(url.searchParams.get("composition")));
  const createdCompositionId = new URL(page.url()).searchParams.get("composition");
  const createdComposition = await readApi(`/projects/${project.id}/maps/${createdCompositionId}`);
  assert.equal(createdComposition.id, createdCompositionId);
  if (geolibreImportMode) {
    stage="geolibre-import"; console.log(`Studio: ${stage}`);
    const {exerciseGeoLibreImport}=await import('./integrated-studio-renderers.mjs');
    const geolibre=await exerciseGeoLibreImport({page,project,composition:createdComposition,origin,organization,worker,readApi,apiRequest,work});
    assert.deepEqual(errors,[]);
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",geolibre,
      applicationShell:builtShell.evidence,requestCount:requests.length,externalProviderRequests:0,
      notProven:["Production identity or AWS transport","Upstream desktop UI","Full parity"]},null,2)+"\n");
    break scopedJourney;
  }
  if (rendererPersistenceMode) {
    stage="renderer-persistence"; console.log(`Studio: ${stage}`);
    const {exerciseRendererPersistence}=await import('./integrated-studio-renderers.mjs');
    const renderer=await exerciseRendererPersistence({page,project,composition:createdComposition,origin,organization,worker,readApi,apiRequest});
    assert.deepEqual(errors,[]);
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",renderer,
      applicationShell:builtShell.evidence,requestCount:requests.length,externalProviderRequests:0,
      notProven:["Production identity or AWS transport","Live Mapbox authorization","Full parity"]},null,2)+"\n");
    break scopedJourney;
  }
  if (process.env.OPENGEO_FIELD_COMPARISONS_ONLY === "1") {
    stage = "field-comparisons";
    const fields = await exerciseFieldComparisons({page, project, origin, worker, readApi, apiRequest, organization});
    assert.deepEqual(errors, []);
    assert.ok(requests.length <= (process.env.OPENGEO_ATTACHMENT_CAPTURE_ONLY === "1" ? 160 : (process.env.OPENGEO_ATTACHMENT_UPLOAD_ONLY === "1" || process.env.OPENGEO_ATTACHMENT_MEDIA_ONLY === "1") ? 140 : 110), "Field comparison request budget");
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",fields,
      applicationShell:builtShell.evidence,requestCount:requests.length},null,2)+"\n");
    break scopedJourney;
  }
  if (process.env.OPENGEO_PUBLICATION_ACCESS_ONLY === "1") {
    stage = "publication-access-only";
    const create = async (path, body) => {
      const response = await apiRequest(path, {method:"POST", headers:{authorization:"Bearer synthetic-local-owner",
        "x-opengeo-organization":organization,"content-type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,201,response.body.toString());
      return JSON.parse(response.body);
    };
    const resource = await create(`/projects/${project.id}/resources`, {kind:"document",slug:"access-page",metadata:{title:"Access page"}});
    const site = await create(`/projects/${project.id}/sites`, {slug:"access-publication",title:"Access publication",
      pages:[{slug:"home",navigation_label:"Home",resource_id:resource.id,resource_version:resource.version_number,is_home:true}]});
    await page.goto(`${origin}/workspaces?publication=${site.id}`);
    const collaborators = await openWorkspaceCollaborators(page);
    const invitationForm = collaborators.locator('form[data-purpose="project-invitation"]');
    await invitationForm.getByLabel("Collaborator email",{exact:true}).fill("reviewer@local.invalid");
    await invitationForm.getByLabel("Collaborator display name",{exact:true}).fill("Local reviewer");
    await invitationForm.getByLabel("Collaborator project role",{exact:true}).selectOption("editor");
    await invitationForm.getByRole("button",{name:"Create project invitation",exact:true}).click();
    await collaborators.getByText("reviewer@local.invalid was invited as editor. Access begins only after acceptance.",{exact:true}).waitFor();
    const reviewer = await context.newPage();
    reviewer.on("pageerror",error=>errors.push(error.message));
    await reviewer.addInitScript(initializeIntegratedStudioSession,{organization,actor:"reviewer"});
    await reviewer.goto(`${origin}/workspaces`);
    await reviewer.getByRole("button",{name:"Accept invitation",exact:true}).click();
    await reviewer.getByRole("link",{name:"Publications",exact:true}).click();
    await reviewer.locator(`a[href*="publication=${site.id}"]`).click();
    await reviewer.locator(`#site-${site.id}`).getByLabel("Site title",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Load current access",exact:true}).click();
    const member = page.locator('[data-member-id="20000000-0000-4000-8000-000000000002"]');
    await member.getByRole("button",{name:"Remove",exact:true}).click();
    await member.waitFor({state:"detached"});
    const denied = reviewer.waitForResponse(response=>response.url().endsWith(`/publications/${site.id}`)&&response.request().method()==="GET");
    await reviewer.reload();
    assert.equal((await denied).status(),404);
    await reviewer.getByRole("heading",{name:"Publication not found",exact:true}).waitFor();
    assert.equal(await reviewer.locator(`#site-${site.id}`).count(),0);
    await reviewer.close();
    assert.deepEqual(errors,[]);
    assert.ok(requests.length<=100,"Publication access request budget");
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",applicationShell:builtShell.evidence,
      requestCount:requests.length,publicationAccess:{invitedAndAccepted:true,canonicalPublicationOpened:true,
        removalThroughStudio:true,canonicalDenialStatus:404,denialHeadingVisible:true,staleEditorAbsent:true},
      notProven:["Publication rendering or anonymous delivery in this scoped run","Deployed identity"]},null,2)+"\n");
    break scopedJourney;
  }
  if (analysisOnlyMode) {
    stage = "scoped-analysis"; console.log(`Studio: ${stage}`);
    const analysis = await exerciseStudioAnalysis({page, project, composition: createdComposition, origin, organization, worker, readApi, apiRequest,
      ...(ftwMode?{ftwQueryPath:join(work,"ftw-query.json"),work}: {}),
      ...(managedCogMode?{managedCogFile:join(work,"managed-cog.tif"),managedCogProfile,work}: {})});
    assert.deepEqual(errors, []);
    assert.ok(requests.length <= (retainedAnalysisMode?120:process.env.OPENGEO_ANALYSIS_CONTROLS_ONLY === "1" ? 110 : 160), "Bounded analysis request budget");
    if(retainedAnalysisMode){assert.equal(ftwUploadTickets,1);assert.equal(ftwUploadCompletions,1);assert.equal(ftwWorkerRuns,1);
      assert.ok(!ftwBlockedExternal.some(value=>new URL(value).hostname.endsWith(managedCogMode?"esa-worldcover.s3.eu-central-1.amazonaws.com":"source.coop")),"Retained analysis cannot issue source provider requests");
      ftwStatus="pass";checkpointFtw();}
    writeFileSync(join(work, "browser-result.json"), JSON.stringify({status:"pass", analysis, applicationShell:builtShell.evidence,
      notProven:["Deployment", "Cognito or AWS transport", "Full parity"], requestCount:requests.length}, null, 2)+"\n");
    break scopedJourney;
  }
  let accessProof = null;
  if (builtStudio && !wcsOnlyMode) {
    stage = "persisted-viewer-access";
    console.log(`Studio: ${stage}`);
    accessProof = await exerciseStudioAccess({page, context, origin, organization, controlProject: project,
      initializeSession: initializeIntegratedStudioSession, readApi, apiRequest, work, errors});
  }
  stage = "service-connection";
  console.log(`Studio: ${stage}`);
  await page.locator(`a[href*="project=${project.id}"][href*="manage=services"]`).first().click();
  await page.getByLabel("Service identifier", {exact:true}).fill("watershed-pilot");
  await page.getByLabel("Service title", {exact:true}).fill("Watershed pilot service");
  const serviceCreated = page.waitForResponse(response => response.url().endsWith("/spatial-services") && response.request().method() === "POST");
  await page.getByRole("button", {name:"Create immutable service identifier",exact:true}).click();
  assert.equal((await serviceCreated).status(),201);
  await page.locator(".project-service-card .service-connection").waitFor();
  await page.reload();
  const connections = page.locator(".project-service-card .service-connection");
  assert.equal(await connections.locator('option[value="wcs"]').evaluate(option => option.disabled),true);
  await page.locator(".spatial-catalog-sections").getByText(/^Metadata · v1$/).click();
  await page.getByLabel("Published protocols",{exact:true}).selectOption(["ogc_api_features","wfs_2_0","wms_1_3","wmts_1_0","wcs_2_0"]);
  await page.getByRole("button",{name:"Save metadata revision",exact:true}).click();
  await page.locator(".spatial-catalog-sections").getByText(/^Metadata · v2$/).waitFor();
  assert.equal(await connections.locator('option[value="wcs"]').evaluate(option => option.disabled),false);
  await connections.locator("summary").click();
  const previewStart = requests.length;
  const discoveryPath = `/projects/${project.id}/services/watershed-pilot/ogc`;
  await connections.getByRole("button", {name:"Preview service document",exact:true}).click();
  await connections.locator("pre:not([hidden])").waitFor();
  assert.equal(JSON.parse(await connections.locator("pre").textContent()).title,"Watershed pilot service");
  assert.equal(await connections.getByLabel("Connection URL",{exact:true}).inputValue(),`${origin}/api${discoveryPath}`);
  await connections.getByLabel("Service protocol",{exact:true}).selectOption("wcs");
  await connections.getByRole("button", {name:"Preview service document",exact:true}).click();
  await connections.locator("pre:not([hidden])").waitFor();
  assert.match(await connections.locator("pre").textContent(),/Capabilities/);
  await page.setViewportSize({width:390,height:844});
  await connections.screenshot({path:join(work,"service-connection-mobile.png")});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),"Service connection fits a narrow screen");
  await page.setViewportSize({width:1440,height:1000});
  const previewRequests = requests.slice(previewStart);
  assert.ok(previewRequests.filter(request=>request.path.startsWith(`/projects/${project.id}/services/`)).every(request=>request.authenticated && request.method === "GET"));
  assert.equal(previewRequests.filter(request=>request.method !== "GET").length,0);
  const deniedDiscovery = await apiRequest(discoveryPath);
  assert.equal(deniedDiscovery.status,401);
  const serviceConnectionProof = {createdAndReopened:true,wcsExplicitlyEnabled:true,authenticatedDiscoveryAndWcsPreview:true,
    anonymousDenied:true,credentialFreeConnectionUrl:true,previewCreatedNoWrites:true,narrowScreenNoOverflow:true};
  await page.locator(`a[href*="project=${project.id}"][href*="manage=data"]`).first().click();
  await page.getByRole("heading", {name: "Project datasets", exact: true}).waitFor();

  if(wcsOnlyMode) {
    stage="scoped-wcs";console.log(`Studio: ${stage}`);
    const wcs=await exerciseStudioWcs({page,project,origin,organizationId:organization,work,worker,readApi,publishedObjects:1});
    assert.deepEqual(errors,[]);
    writeFileSync(join(work,"browser-result.json"),JSON.stringify({status:"pass",scope:"Scoped built-Studio WCS journey only",wcs,
      serviceConnectionProof,applicationShell:builtShell.evidence,notProven:["Full integrated journey","Deployment","Cognito or AWS transport"]},null,2)+"\n");
    break scopedJourney;
  }
  stage = "managed-upload";
  console.log(`Studio: ${stage}`);
  const source = Buffer.from(JSON.stringify({type: "FeatureCollection", features: [-72.5, -72.2].map((x, i) => ({
    type: "Feature", properties: {name: `Watershed ${i + 1}`, value: i + 1,
      ...(pinnedFontMode ? {label_name: FONT_LABELS[i]} : {})},
    geometry: {type: "Polygon", coordinates: [[[x,42],[x+0.1,42],[x+0.1,42.1],[x,42.1],[x,42]]]}
  }))}));
  await page.getByLabel("Dataset, image, or document file", {exact: true}).setInputFiles({name: "watersheds.geojson", mimeType: "application/geo+json", buffer: source});
  await page.getByLabel("Dataset, image, or document name", {exact: true}).fill("Watershed observations");
  await page.getByLabel("Dataset classification", {exact: true}).selectOption("public");
  const completed = page.waitForResponse((response) => response.url().endsWith("/complete") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Hash and upload", exact: true}).click();
  const completionResponse = await completed;
  assert.equal(completionResponse.status(), 200);
  const completion = await completionResponse.json();
  const datasetId = completion.dataset.id;
  await worker();
  await page.reload();
  const card = page.locator(`[data-dataset-id="${datasetId}"]`);
  await card.getByRole("button", {name: "Version history", exact: true}).click();
  await card.getByRole("heading", {name: "Logical version history", exact: true}).waitFor();
  const dataset = await readApi(`/projects/${project.id}/datasets/${datasetId}`);
  assert.equal(dataset.status, "active");
  assert.equal(dataset.feature_count, 2);

  stage = "second-managed-upload";
  console.log(`Studio: ${stage}`);
  const conservationSource = Buffer.from(JSON.stringify({type: "FeatureCollection", features: [{
    type: "Feature", properties: {name: "Conservation corridor", ...(pinnedFontMode ? {label_name: FONT_LABELS[2]} : {})}, geometry: {type: "Polygon", coordinates: [[
      [-72.48, 42.04], [-72.13, 42.04], [-72.13, 42.08], [-72.48, 42.08], [-72.48, 42.04]
    ]]}
  }]}));
  await page.getByLabel("Dataset, image, or document file", {exact: true}).setInputFiles({
    name: "conservation.geojson", mimeType: "application/geo+json", buffer: conservationSource
  });
  await page.getByLabel("Dataset, image, or document name", {exact: true}).fill("Conservation areas");
  await page.getByLabel("Dataset classification", {exact: true}).selectOption("public");
  const conservationCompleted = page.waitForResponse(response => response.url().endsWith("/complete") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Hash and upload", exact: true}).click();
  const conservationResponse = await conservationCompleted;
  assert.equal(conservationResponse.status(), 200);
  const conservationCompletion = await conservationResponse.json();
  const conservationId = conservationCompletion.dataset.id;
  await worker();
  await page.reload();
  const conservationCard = page.locator(`[data-dataset-id="${conservationId}"]`);
  const conservation = await readApi(`/projects/${project.id}/datasets/${conservationId}`);
  assert.equal(conservation.status, "active");
  assert.equal(conservation.feature_count, 1);
  assert.equal(conservation.classification, "public");

  stage = "managed-conversion-provenance";
  const managedConversion = await exerciseManagedConversion({page, project, worker, readApi, work});

  stage = "invalid-upload-diagnosis";
  console.log(`Studio: ${stage}`);
  const invalidSource = Buffer.from("OpenGeo invalid GeoJSON acceptance fixture\n");
  const invalidSha256 = createHash("sha256").update(invalidSource).digest("hex");
  await page.getByLabel("Dataset, image, or document file", {exact: true}).setInputFiles({
    name: "invalid.geojson", mimeType: "application/geo+json", buffer: invalidSource
  });
  await page.getByLabel("Dataset, image, or document name", {exact: true}).fill("Invalid format example");
  await page.getByLabel("Dataset classification", {exact: true}).selectOption("internal");
  const invalidCompleted = page.waitForResponse((response) => response.url().endsWith("/complete") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Hash and upload", exact: true}).click();
  const invalidResponse = await invalidCompleted;
  assert.equal(invalidResponse.status(), 200);
  const invalidCompletion = await invalidResponse.json();
  const invalidId = invalidCompletion.dataset.id;
  await worker();
  await page.reload();
  const invalidCard = page.locator(`[data-dataset-id="${invalidId}"]`);
  await invalidCard.getByRole("heading", {name: "Processing needs attention", exact: true}).waitFor();
  await invalidCard.getByText("Error code: dataset_magic_mismatch", {exact: true}).waitFor();
  await invalidCard.getByText("The file contents do not match the selected dataset format. Select the correct format or upload a different file.", {exact: true}).waitFor();
  assert.equal(await invalidCard.getByText("Add to map…", {exact: true}).count(), 0, "Failed data cannot be added to a map");
  await invalidCard.screenshot({path: join(work, "invalid-upload-diagnosis.png")});
  const invalid = await readApi(`/projects/${project.id}/datasets/${invalidId}`);
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.current_version_id, invalidCompletion.dataset_version_id);
  assert.equal(invalid.current_version_state, "failed");
  assert.equal(invalid.processing_job_state, "failed");
  assert.equal(invalid.processing_error_code, "dataset_magic_mismatch");
  assert.equal(invalid.quality_results.valid, false);
  const invalidVersions = await readApi(`/projects/${project.id}/datasets/${invalidId}/versions`);
  assert.equal(invalidVersions.length, 1);
  const invalidVersion = invalidVersions[0];
  assert.equal(invalidVersion.id, invalidCompletion.dataset_version_id);
  assert.equal(invalidVersion.state, "failed");
  assert.equal(invalidVersion.current, true);
  assert.equal(invalidVersion.objects.length, 1);
  assert.equal(invalidVersion.objects[0].role, "original");
  assert.equal(invalidVersion.objects[0].checksum_sha256, invalidSha256);

  await card.getByText("Add to map…", {exact: true}).click();
  await card.getByRole("link", {name: "Add to Watershed review map", exact: true}).click();
  stage = "map-save";
  console.log(`Studio: ${stage}`);
  // Continue using the ordinary exact-dataset handoff and workbench controls.
  await page.screenshot({path: join(work, "map-handoff.png")});
  await page.getByRole("button", {name: "Add Watershed observations to map", exact: true}).click();
  const failedAdd = page.getByRole("button", {name: "Add Invalid format example to map", exact: true});
  assert.equal(await failedAdd.isDisabled(), true, "The map's Add data chooser also blocks failed uploads");
  assert.equal(await failedAdd.textContent(), "Processing failed");
  await page.waitForFunction((id) => {
    const shell = document.querySelector(".opengeo-workbench");
    const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === id);
    return layer && shell.__opengeoData?.get(layer.layerId)?.features.length === 2;
  }, datasetId);
  await page.getByRole("heading", {name: "Layer Properties", exact: true}).waitFor();
  await page.getByRole("button", {name: "Add data", exact: true}).click();
  await page.locator('summary[aria-label="Editable feature collection for Watershed observations"]').waitFor();
  assert.equal(await page.getByRole("button", {name: "Add Watershed observations to map", exact: true}).count(), 0,
    "An existing exact version is not offered twice, but editable collection access remains available");
  await page.getByRole("button", {name: "Add Conservation areas to map", exact: true}).click();
  await page.waitForFunction((id) => {
    const shell = document.querySelector(".opengeo-workbench");
    const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === id);
    return layer && shell.__opengeoData?.get(layer.layerId)?.features.length === 1;
  }, conservationId);
  await page.getByRole("heading", {name: "Layer Properties", exact: true}).waitFor();
  // Select the real blank background deliberately, without substituting tile responses.
  await page.locator('.gis-menubar [data-menu="view"] > button').click();
  await page.getByRole("menuitem", {name: "Change basemap", exact: true}).click();
  const basemapDialog = page.getByRole("dialog", {name: "Change basemap", exact: true});
  const blank = basemapDialog.locator('.gis-basemap-card[data-catalog-id="blank"]');
  const blankGroup = blank.locator("xpath=ancestor::details[1]");
  if (await blankGroup.getAttribute("open") === null) await blankGroup.locator("summary").click();
  await blank.click();
  await page.waitForFunction(() => document.querySelector(".opengeo-workbench")?.dataset.basemapActivationState === "active");
  assert.equal(await blank.getAttribute("aria-pressed"), "true");
  await basemapDialog.getByRole("button", {name: "Done", exact: true}).click();
  await page.waitForFunction((datasetId) => {
    const shell = document.querySelector(".opengeo-workbench");
    const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === datasetId);
    return layer && shell.__opengeoData?.get(layer.layerId)?.features.length === 2;
  }, datasetId);
  await page.waitForFunction((datasetId) => {
    const shell = document.querySelector(".opengeo-workbench");
    const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === datasetId);
    return layer && shell.__opengeoData?.get(layer.layerId)?.features.length === 1;
  }, conservationId);
  const watershedLayerTitle = "Watershed observations · saved v1";
  const conservationLayerTitle = "Conservation areas · saved v1";
  async function setRange(control, value, minimum, step) {
    await control.press("Home");
    for (let count = 0; count < Math.round((value - minimum) / step); count++) await control.press("ArrowRight");
    assert.equal(Number(await control.inputValue()), value);
  }
  async function assertPinnedLabels(editor) {
    await editor.waitForFunction(({ids, stack, names}) => {
      const shell = document.querySelector(".opengeo-workbench");
      const map = shell?.__opengeoMap;
      if (!map?.isStyleLoaded() || map.isMoving()) return false;
      return ids.every(id => {
        const layer = shell.__opengeoLayers.find(layer => layer.datasetId === id);
        const labelId = `${layer?.layerId}-labels`;
        if (!layer || !map.getLayer(labelId) || map.getLayoutProperty(labelId, "text-font")?.[0] !== stack) return false;
        const visible = new Set(map.queryRenderedFeatures({layers:[labelId]}).map(feature => feature.properties.label_name));
        return (id === ids[0] ? names.slice(0,2) : names.slice(2)).every(name => visible.has(name));
      });
    }, {ids:[datasetId,conservationId], stack:fontAssets.fontStack, names:FONT_LABELS});
    const witnesses = await editor.evaluate(() => {
      const shell = document.querySelector(".opengeo-workbench"), map = shell.__opengeoMap;
      return shell.__opengeoLayers.map(layer => ({layerId:layer.layerId,datasetId:layer.datasetId,fontRef:layer.labels.fontRef,
        field:map.getLayoutProperty(`${layer.layerId}-labels`,"text-field"),
        fontStack:map.getLayoutProperty(`${layer.layerId}-labels`,"text-font"),
        names:[...new Set(map.queryRenderedFeatures({layers:[`${layer.layerId}-labels`]}).map(feature=>feature.properties.label_name))]}));
    });
    for (const witness of witnesses) {
      assert.deepEqual(witness.fontRef, fontAssets.fontRef);
      assert.deepEqual(witness.fontStack, [fontAssets.fontStack]);
      assert.deepEqual(witness.field, ["concat", "[", ["to-string", ["get", "label_name"]], "]"]);
    }
    return witnesses;
  }
  async function styleLayer(editor, title, color, opacity) {
    const row = editor.locator(".gis-layer-row").filter({has: editor.getByRole("button", {name: `Select layer ${title}`, exact: true})});
    await row.getByLabel(`Layer actions for ${title}`, {exact: true}).click();
    await row.getByRole("button", {name: "Style layer", exact: true}).click();
    const inspector = editor.locator(".gis-panel-right");
    await inspector.getByLabel("Renderer", {exact: true}).selectOption("single");
    await inspector.getByLabel("Primary color", {exact: true}).fill(color);
    await inspector.getByLabel("Show labels on map", {exact: true}).uncheck();
    const control = inspector.getByLabel("Opacity", {exact: true});
    await control.press("Home");
    for (let step = 0; step < Math.round(opacity / 0.05); step++) await control.press("ArrowRight");
    assert.equal(Number(await control.inputValue()), opacity);
    if (pinnedFontMode) {
      await inspector.getByLabel("Name field", {exact:true}).selectOption("label_name");
      await inspector.getByLabel("Prefix", {exact:true}).fill("[");
      await inspector.getByLabel("Suffix", {exact:true}).fill("]");
      await inspector.getByLabel("Suffix", {exact:true}).press("Tab");
      await inspector.getByLabel("Text color", {exact:true}).fill("#ffffff");
      await inspector.getByLabel("Halo color", {exact:true}).fill("#000000");
      await setRange(inspector.getByLabel("Text size", {exact:true}), FONT_LABEL_SIZE, 8, 1);
      await setRange(inspector.getByLabel("Halo width", {exact:true}), title === conservationLayerTitle ? 6 : 0, 0, 0.25);
      await inspector.getByLabel("Allow label overlap", {exact:true}).check();
      await inspector.getByLabel("Show labels on map", {exact:true}).check();
    }
  }
  await styleLayer(page, watershedLayerTitle, "#2563eb", 0.8);
  await styleLayer(page, conservationLayerTitle, "#e76f51", 0.9);
  if (pinnedFontMode) {
    assert.equal(fontRequests.length, 0, "Enabling unspecified legacy labels does not load or adopt a pinned font");
    const writes = requests.filter(request => !["GET","HEAD"].includes(request.method)).length;
    await page.getByRole("button", {name:"Use Open Sans v1 for this map’s enabled labels",exact:true}).click();
    await page.locator(".gis-map-font-status").getByText(/Open Sans v1 · verified glyphs/).waitFor();
    assert.equal(requests.filter(request => !["GET","HEAD"].includes(request.method)).length, writes,
      "Font adoption does not save the map or create a job");
    fontProof.legacyInspectionFontReads = 0;
    fontProof.adoptionCreatedNoApiWrites = true;
  }
  // Save watershed above conservation first. The next revision reverses this
  // using the visible ordering control, making the overlap an ordering witness.
  const watershedUp = page.getByRole("button", {name: `Move ${watershedLayerTitle} up`, exact: true});
  if (await watershedUp.isEnabled()) await watershedUp.click();
  await page.getByRole("button", {name: "Fit", exact: true}).click();
  await page.waitForFunction(() => {
    const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
    return map?.isStyleLoaded() && !map.isMoving();
  });
  // Output dimensions keep the saved zoom. Use ordinary zoom controls until
  // the complete two-dataset extent fits the requested 320 × 240 image.
  await page.getByRole("button", {name: "Show map controls", exact: true}).click();
  for (let attempt = 0; attempt < 8; attempt++) {
    const fits = await page.evaluate(() => {
      const map = document.querySelector(".opengeo-workbench").__opengeoMap;
      const center = map.getCenter();
      const world = 512 * 2 ** map.getZoom();
      const mercatorY = latitude => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      return [[-72.5, 42], [-72.1, 42.1]].every(([longitude, latitude]) =>
        Math.abs((longitude - center.lng) / 360 * world) < 140
        && Math.abs((mercatorY(latitude) - mercatorY(center.lat)) / (2 * Math.PI) * world) < 100);
    });
    if (fits) break;
    assert.ok(attempt < 7, "The explicit map view must contain both layers in the requested image");
    await page.getByRole("button", {name: "Zoom out", exact: true}).click();
    await page.waitForFunction(() => !document.querySelector(".opengeo-workbench").__opengeoMap.isMoving());
  }
  if (pinnedFontMode) {
    fontProof.adoptedLabelWitnesses = await assertPinnedLabels(page);
    await page.screenshot({path:join(work,"pinned-font-adopted.png")});
  }
  const saved = page.waitForResponse((response) => /\/maps\/[^/]+$/.test(response.url()) && response.request().method() === "PATCH");
  await page.getByRole("button", {name: "Save", exact: true}).click();
  assert.equal((await saved).status(), 200);
  await page.reload();
  await page.getByRole("button", {name: `Select layer ${watershedLayerTitle}`, exact: true}).waitFor();
  await page.waitForFunction((datasetId) => {
    const shell = document.querySelector(".opengeo-workbench");
    const map = shell?.__opengeoMap;
    const layer = shell?.__opengeoLayers?.find(layer => layer.datasetId === datasetId);
    if (!map?.isStyleLoaded() || !layer || !map.getLayer(`${layer.layerId}-fill`)) return false;
    const names = new Set(map.queryRenderedFeatures({layers: [`${layer.layerId}-fill`]}).map(feature => feature.properties.name));
    return names.has("Watershed 1") && names.has("Watershed 2");
  }, datasetId);
  if (pinnedFontMode) {
    fontProof.reopenedLabelWitnesses = await assertPinnedLabels(page);
    assert.equal(await page.evaluate(() => window.__opengeoIntegratedFontProbe.localGlyphCalls), 0,
      "Reopening pinned labels must not use local font fallback");
    fontProof.reopenedLocalGlyphCalls = 0;
    await page.screenshot({path:join(work,"pinned-font-reopened.png")});
  }
  await page.screenshot({path: join(work, "map-reopened.png")});
  const maps = await readApi(`/projects/${project.id}/maps`);
  assert.equal(maps.length, 1);
  assert.equal(maps[0].definition.layers.length, 2);
  assert.deepEqual(maps[0].definition.layers.map(layer => layer.datasetId), [datasetId, conservationId]);
  assert.deepEqual(maps[0].definition.layers.map(layer => layer.datasetVersionId),
    [completion.dataset_version_id, conservationCompletion.dataset_version_id]);
  for (const [layer, color, opacity] of [[maps[0].definition.layers[0], "#2563eb", 0.8],
    [maps[0].definition.layers[1], "#e76f51", 0.9]]) {
    assert.equal(layer.style.renderer, "single");
    assert.equal(layer.style.fill, color);
    assert.equal(layer.opacity, opacity);
    assert.equal(layer.labels.enabled, pinnedFontMode);
    if (pinnedFontMode) {
      assert.deepEqual(layer.labels.fontRef, fontAssets.fontRef);
      assert.equal(layer.labels.field, "label_name");
      assert.equal(layer.labels.prefix, "[");
      assert.equal(layer.labels.suffix, "]");
      assert.equal(layer.labels.size, FONT_LABEL_SIZE);
      assert.equal(layer.labels.color, "#ffffff");
      assert.equal(layer.labels.haloColor, "#000000");
      assert.equal(layer.labels.haloWidth, layer.datasetId === conservationId ? 6 : 0);
      assert.equal(layer.labels.allowOverlap, true);
    }
    assert.equal(layer.visible, true);
  }
  // Keep the watershed active for its existing PMTiles processing acceptance.
  await page.getByRole("button", {name: `Style ${watershedLayerTitle}`, exact: true}).click();

  stage = "pmtiles";
  console.log(`Studio: ${stage}`);
  const converterRuntime = existsSync(join(work, "pmtiles-runtime.json"));
  const converterCommand = existsSync(join(work, "pmtiles-worker-command.json"));
  if (converterRuntime || converterCommand) {
    assert.ok(converterRuntime && converterCommand, "Dedicated PMTiles acceptance requires both runtime and worker bindings");
    await page.getByRole("button", {name: "Processing", exact: true}).click();
    await page.getByText(/^Vector to PMTiles \(/).click();
    await page.getByLabel("Minimum zoom", {exact: true}).fill("4");
    await page.getByLabel("Maximum zoom", {exact: true}).fill("8");
    assert.equal(await page.getByLabel("Output tile layer", {exact: true}).inputValue(), "source");
    const [derivativeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/pmtiles-derivatives") && response.request().method() === "POST"),
      page.getByRole("button", {name: "Queue on-demand conversion", exact: true}).click()
    ]);
    assert.equal(derivativeResponse.status(), 202);
    const derivative = await derivativeResponse.json();
    await worker();
    const derivativeResult = await readApi(`/projects/${project.id}/datasets/${datasetId}/versions/${completion.dataset_version_id}/pmtiles-derivatives/${derivative.job_id}`);
    assert.equal(derivativeResult.state, "completed");
    await page.getByRole("button", {name: "Refresh jobs", exact: true}).click();
    const derivativeRow = page.locator(`[data-job-id="${derivative.job_id}"]`);
    await derivativeRow.getByText(`completed · ${derivative.job_id}`, {exact: true}).waitFor();
    await derivativeRow.screenshot({path: join(work, "pmtiles-completed.png")});
    pmtilesConversion = {status: "passed", jobId: derivative.job_id};
  } else {
    console.log("Studio: on-demand PMTiles not exercised; dedicated converter unconfigured");
  }

  stage = "metadata-and-png";
  console.log(`Studio: ${stage}`);
  await page.locator(`a[href*="project=${project.id}"][href*="manage=data"]`).first().click();
  await card.getByRole("button", {name: "Metadata & publishing", exact: true}).click();
  await page.getByLabel("Governed dataset license", {exact: true}).fill("CC-BY-4.0");
  await page.getByLabel("Governed dataset attribution", {exact: true}).fill("OpenGeo local pilot");
  await page.getByLabel("Governed dataset abstract", {exact: true}).fill("Two preserved watershed observations.");
  const createdResource = page.waitForResponse((response) => response.url().endsWith("/resources") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Create governed catalog record", exact: true}).click();
  const resourceResponse = await createdResource;
  assert.equal(resourceResponse.status(), 201);
  const resource = await resourceResponse.json();
  await page.getByRole("link", {name: "Open metadata, styles & publishing", exact: true}).click();
  await page.locator(`[data-resource-id="${resource.id}"]`).getByRole("button", {name: "Open resource", exact: true}).click();
  const detail = page.locator('.project-resource-detail[data-state="ready"]');
  await detail.getByLabel("Metadata format", {exact: true}).selectOption("ogc_records_1_0");
  await detail.getByRole("button", {name: "Prepare metadata export", exact: true}).click();
  const metadataDownload = page.waitForEvent("download");
  await detail.getByRole("button", {name: "Download metadata", exact: true}).click();
  const metadataBytes = readFileSync(await (await metadataDownload).path());
  assert.equal(JSON.parse(metadataBytes).id, resource.id);
  writeFileSync(join(work, "metadata-export.geojson"), metadataBytes);
  await detail.getByLabel("Style title", {exact: true}).fill("Watershed fill");
  await detail.getByLabel("Detached style definition", {exact: true}).fill(JSON.stringify({version:8,sources:{},layers:[
    {id:"features",type:"fill",paint:{"fill-color":"#2a9d8f","fill-opacity":0.85}}
  ]}));
  await detail.getByRole("button", {name: "Attach style", exact: true}).click();
  await detail.getByRole("button", {name: "Compile render profile", exact: true}).click();
  await detail.getByLabel("Render format", {exact: true}).selectOption("png");
  await detail.getByLabel("Render width", {exact: true}).fill("320");
  await detail.getByLabel("Render height", {exact: true}).fill("240");
  await detail.getByLabel("Render extent (west, south, east, north)", {exact: true}).fill(dataset.extent.join(","));
  const renderQueued = page.waitForResponse((response) => response.url().endsWith("/renders") && response.request().method() === "POST");
  await detail.getByRole("button", {name: "Request PNG render", exact: true}).click();
  const renderResponse = await renderQueued;
  assert.equal(renderResponse.status(), 202);
  const render = await renderResponse.json();
  await worker();
  await detail.getByRole("button", {name: "Refresh render status", exact: true}).click();
  await detail.getByRole("button", {name: "Authorize exact PNG download", exact: true}).waitFor();
  await detail.locator(".project-render-result").filter({has:page.getByRole("button",{name:"Authorize exact PNG download",exact:true})}).screenshot({path: join(work,"png-result.png")});
  const rendered = await readApi(`/projects/${project.id}/resources/${resource.id}/renders/${render.id}`);
  assert.equal(rendered.state, "completed");
  assert.equal(rendered.format, "png");

  async function publishResource() {
    await detail.getByRole("button", {name: "Submit for review", exact: true}).click();
    await detail.getByText(/Version \d+ · review ·/).waitFor();
    await detail.getByLabel("Publication visibility", {exact: true}).selectOption("public");
    await detail.getByRole("button", {name: "Publish", exact: true}).click();
    await detail.getByText(/Version \d+ · published · public/).waitFor();
  }
  await publishResource();
  const publishedDataset = await readApi(`/projects/${project.id}/resources/${resource.id}`);

  if (serviceClientsMode) {
    stage = "populated-service-clients";
    console.log(`Studio: ${stage}`);
    serviceClients = await exerciseServiceClients({page,project,datasetId,resourceId:resource.id,source,readApi,origin,organizationId:organization,root,work,worker});
    serviceClients.wcs = await exerciseStudioWcs({page,project,origin,organizationId:organization,work,worker,readApi});
  }

  stage = "second-dataset-publication";
  console.log(`Studio: ${stage}`);
  await page.locator(`a[href*="project=${project.id}"][href*="manage=data"]`).first().click();
  await conservationCard.getByRole("button", {name: "Metadata & publishing", exact: true}).click();
  await page.getByLabel("Governed dataset license", {exact: true}).fill("CC-BY-4.0");
  await page.getByLabel("Governed dataset attribution", {exact: true}).fill("OpenGeo conservation survey");
  await page.getByLabel("Governed dataset abstract", {exact: true}).fill("An independently uploaded conservation corridor overlapping both watersheds.");
  const conservationResourceCreated = page.waitForResponse(response => response.url().endsWith("/resources") && response.request().method() === "POST");
  await page.getByRole("button", {name: "Create governed catalog record", exact: true}).click();
  const conservationResourceResponse = await conservationResourceCreated;
  assert.equal(conservationResourceResponse.status(), 201);
  const conservationResource = await conservationResourceResponse.json();
  assert.equal(conservationResource.dataset_id, conservationId);
  await page.getByRole("link", {name: "Open metadata, styles & publishing", exact: true}).click();
  await page.locator(`[data-resource-id="${conservationResource.id}"]`).getByRole("button", {name: "Open resource", exact: true}).click();
  await publishResource();
  const publishedConservation = await readApi(`/projects/${project.id}/resources/${conservationResource.id}`);
  assert.equal(publishedConservation.state, "published");
  assert.equal(publishedConservation.visibility, "public");

  stage = "narrative-and-site";
  console.log(`Studio: ${stage}`);
  async function createResource(kind, title) {
    const disclosure = page.locator(".project-resource-native-create");
    if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
    const form = disclosure.locator("form");
    await form.getByLabel("Resource type", {exact: true}).selectOption(kind);
    if (kind === "map") await form.getByLabel("Bound project object", {exact:true}).selectOption(maps[0].id);
    await form.getByLabel("Resource title", {exact: true}).fill(title);
    await form.getByLabel("Persistent URL name", {exact: true}).fill(kind === "map" ? "watershed-map" : "watershed-story");
    await form.getByLabel("License", {exact: true}).fill("CC-BY-4.0");
    await form.getByLabel("Attribution", {exact: true}).fill("OpenGeo local pilot");
    if (kind === "map") {
      // Saving a Project map already creates its governed identity. Reopen that
      // record, curate its rights, then explicitly adopt the saved composition.
      const governedMaps = (await readApi(`/projects/${project.id}/resources?kind=map&limit=100`))
        .filter(resource => resource.map_id === maps[0].id);
      assert.equal(governedMaps.length, 1, "A map retains one governed identity");
      const resourcePath = `/projects/${project.id}/resources/${governedMaps[0].id}`;
      const creationCount = requests.filter(request => request.method === "POST"
        && request.path === `/projects/${project.id}/resources`).length;
      const opened = page.waitForResponse(response => response.url().endsWith(resourcePath)
        && response.request().method() === "GET");
      await form.getByRole("button", {name: "Create draft resource", exact: true}).click();
      const response = await opened;
      assert.equal(response.status(), 200);
      const original = await response.json();
      assert.equal(original.id, governedMaps[0].id);
      assert.equal(original.map_id, maps[0].id);
      assert.equal(original.version_number, 1);
      await detail.locator(".project-resource-detail-heading").getByRole("heading", {name:title,exact:true}).waitFor();
      assert.equal(requests.filter(request => request.method === "POST"
        && request.path === `/projects/${project.id}/resources`).length, creationCount,
        "Opening an existing map never creates a duplicate resource");
      const metadataForm = detail.locator(".project-resource-metadata-editor form");
      await metadataForm.getByLabel("License", {exact: true}).fill("CC-BY-4.0");
      await metadataForm.getByLabel("Attribution", {exact: true}).fill("OpenGeo local pilot");
      const curated = page.waitForResponse(response => response.url().endsWith(resourcePath)
        && response.request().method() === "PUT");
      await metadataForm.getByRole("button", {name: "Save new version", exact: true}).click();
      const curatedResponse = await curated;
      assert.equal(curatedResponse.status(), 200);
      const rights = await curatedResponse.json();
      assert.equal(rights.id, original.id);
      assert.equal(rights.version_number, original.version_number + 1);
      assert.equal(rights.license, "CC-BY-4.0");
      assert.equal(rights.attribution, "OpenGeo local pilot");
      assert.deepEqual(rights.map_snapshot, original.map_snapshot, "Rights curation retains the original map pin");
      const versionPanel = detail.locator(".project-resource-map-version");
      await versionPanel.getByText(`Resource v${rights.version_number} uses map v${original.map_snapshot.map_version}. Saved map: v${maps[0].version}.`, {exact: true}).waitFor();
      const selected = page.waitForResponse(response => response.url().endsWith(resourcePath)
        && response.request().method() === "PUT");
      await versionPanel.getByRole("button", {name: `Use saved map v${maps[0].version} in a new resource version`, exact: true}).click();
      const selectedResponse = await selected;
      assert.equal(selectedResponse.status(), 200);
      const resource = await selectedResponse.json();
      assert.equal(resource.id, original.id);
      assert.equal(resource.version_number, rights.version_number + 1);
      assert.equal(resource.license, rights.license);
      assert.equal(resource.attribution, rights.attribution);
      await versionPanel.getByText(`Resource v${resource.version_number} uses map v${maps[0].version}. Saved map: v${maps[0].version}.`, {exact: true}).waitFor();
      return resource;
    }
    const pending = page.waitForResponse((response) => response.url().endsWith("/resources") && response.request().method() === "POST");
    await form.getByRole("button", {name: "Create draft resource", exact: true}).click();
    const response = await pending;
    assert.equal(response.status(), 201);
    const resource = await response.json();
    if (kind === "map") assert.equal(resource.map_id,maps[0].id);
    await detail.locator(".project-resource-detail-heading").getByRole("heading", {name:title,exact:true}).waitFor();
    return resource;
  }
  const mapResource = await createResource("map", "Watershed review map");
  assert.equal(mapResource.map_snapshot.map_id, maps[0].id);
  assert.equal(mapResource.map_snapshot.map_version, maps[0].version);
  assert.match(mapResource.map_snapshot.definition_checksum_sha256, /^[a-f0-9]{64}$/);

  stage = "saved-map-resource-revision";
  console.log(`Studio: ${stage}`);
  const mapVersionPanel = detail.locator(".project-resource-map-version");
  assert.equal(await mapVersionPanel.getAttribute("data-state"), "current");
  const mapEditor = await context.newPage();
  mapEditor.on("pageerror", (error) => errors.push(error.message));
  await mapEditor.goto(`${origin}/workspaces?project=${project.id}&map=${maps[0].id}`);
  await mapEditor.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
  await mapEditor.getByRole("button", {name: `Move ${conservationLayerTitle} up`, exact: true}).click();
  const nextMapSave = mapEditor.waitForResponse((response) => /\/maps\/[^/]+$/.test(response.url()) && response.request().method() === "PATCH");
  await mapEditor.getByRole("button", {name: "Save", exact: true}).click();
  const nextMapResponse = await nextMapSave;
  assert.equal(nextMapResponse.status(), 200);
  const nextMap = await nextMapResponse.json();
  assert.ok(nextMap.version > maps[0].version);
  assert.deepEqual(nextMap.definition.layers.map(layer => layer.datasetId), [conservationId, datasetId]);
  await mapEditor.reload();
  await mapEditor.getByRole("button", {name: `Select layer ${conservationLayerTitle}`, exact: true}).waitFor();
  const reopenedOrderedMap = await readApi(`/projects/${project.id}/maps/${maps[0].id}`);
  assert.equal(reopenedOrderedMap.version, nextMap.version);
  assert.deepEqual(reopenedOrderedMap.definition.layers, nextMap.definition.layers);
  if (pinnedFontMode) {
    for (const layer of nextMap.definition.layers) assert.deepEqual(layer.labels.fontRef, fontAssets.fontRef,
      "The new saved revision must retain the exact explicitly adopted font");
  }
  await mapEditor.waitForFunction((ids) => {
    const shell = document.querySelector(".opengeo-workbench");
    const map = shell?.__opengeoMap;
    if (!map?.isStyleLoaded()) return false;
    return ids.every(id => {
      const layer = shell.__opengeoLayers.find(layer => layer.datasetId === id);
      return layer && map.getLayer(`${layer.layerId}-fill`)
        && map.queryRenderedFeatures({layers: [`${layer.layerId}-fill`]}).length > 0;
    });
  }, [datasetId, conservationId]);
  if (pinnedFontMode) {
    fontProof.orderedReopenedLabelWitnesses = await assertPinnedLabels(mapEditor);
    assert.equal(await mapEditor.evaluate(() => window.__opengeoIntegratedFontProbe.localGlyphCalls), 0);
    await mapEditor.screenshot({path:join(work,"pinned-font-ordered-map.png")});
  }
  await mapEditor.screenshot({path: join(work, "ordered-two-layer-map.png")});
  await mapEditor.close();

  // Reading a newer saved map neither changes the resource nor discards notes.
  const metadataNote = "A reviewed map revision with preserved field notes.";
  await detail.getByLabel("Abstract", {exact: true}).fill(metadataNote);
  await mapVersionPanel.getByRole("button", {name: "Refresh saved map version", exact: true}).click();
  await mapVersionPanel.getByText(`Resource v${mapResource.version_number} uses map v${maps[0].version}. Saved map: v${nextMap.version}.`, {exact: true}).waitFor();
  assert.equal(await detail.getByLabel("Abstract", {exact: true}).inputValue(), metadataNote);
  assert.equal(await mapVersionPanel.getByRole("button", {name: `Use saved map v${nextMap.version} in a new resource version`, exact: true}).isDisabled(), true);
  const metadataSave = page.waitForResponse((response) => response.url().endsWith(`/resources/${mapResource.id}`) && response.request().method() === "PUT");
  await detail.getByRole("button", {name: "Save new version", exact: true}).click();
  const metadataResponse = await metadataSave;
  assert.equal(metadataResponse.status(), 200);
  const metadataResource = await metadataResponse.json();
  assert.equal(metadataResource.version_number, mapResource.version_number + 1);
  assert.deepEqual(metadataResource.map_snapshot, mapResource.map_snapshot, "Metadata does not repin the map");
  await mapVersionPanel.getByText(new RegExp(`Resource v${metadataResource.version_number} uses map v${maps[0].version}`)).waitFor();
  await mapVersionPanel.getByRole("button", {name: "Refresh saved map version", exact: true}).click();
  await mapVersionPanel.getByText(`Resource v${metadataResource.version_number} uses map v${maps[0].version}. Saved map: v${nextMap.version}.`, {exact: true}).waitFor();
  const selection = page.waitForResponse((response) => response.url().endsWith(`/resources/${mapResource.id}`) && response.request().method() === "PUT");
  await mapVersionPanel.getByRole("button", {name: `Use saved map v${nextMap.version} in a new resource version`, exact: true}).click();
  const selectionResponse = await selection;
  assert.equal(selectionResponse.status(), 200);
  const selectedMapResource = await selectionResponse.json();
  assert.equal(selectedMapResource.version_number, metadataResource.version_number + 1);
  assert.equal(selectedMapResource.map_snapshot.map_version, nextMap.version);
  assert.equal(selectedMapResource.abstract, metadataNote);
  assert.equal(selectedMapResource.map_snapshot.map_id, maps[0].id);
  assert.notEqual(selectedMapResource.map_snapshot.map_version_id, mapResource.map_snapshot.map_version_id);
  assert.notEqual(selectedMapResource.map_snapshot.definition_checksum_sha256, mapResource.map_snapshot.definition_checksum_sha256);
  await mapVersionPanel.getByText(`Resource v${selectedMapResource.version_number} uses map v${nextMap.version}. Saved map: v${nextMap.version}.`, {exact: true}).waitFor();
  await mapVersionPanel.screenshot({path: join(work, "saved-map-resource-revision.png")});
  await publishResource();
  const publishedMap = await readApi(`/projects/${project.id}/resources/${mapResource.id}`);

  stage = "saved-map-composition-render";
  console.log(`Studio: ${stage}`);
  await detail.getByLabel("Render width", {exact: true}).fill("320");
  await detail.getByLabel("Render height", {exact: true}).fill("240");
  const mapRenderQueued = page.waitForResponse(response => response.url().endsWith(`/resources/${mapResource.id}/saved-map-renders`)
    && response.request().method() === "POST");
  await detail.getByRole("button", {name: "Create map image", exact: true}).click();
  const mapRenderResponse = await mapRenderQueued;
  assert.equal(mapRenderResponse.status(), 202, await mapRenderResponse.text());
  const mapRender = await mapRenderResponse.json();
  assert.equal(mapRender.resource_id, mapResource.id);
  assert.equal(mapRender.saved_map_snapshot.resource_version_number, publishedMap.version_number);
  assert.equal(mapRender.saved_map_snapshot.map_version, nextMap.version);
  assert.equal(mapRender.saved_map_snapshot.definition_checksum_sha256, selectedMapResource.map_snapshot.definition_checksum_sha256);
  if (pinnedFontMode) {
    const profiles = (await readApi(`/projects/${project.id}/resources/${mapResource.id}/render-profiles`))
      .filter(profile => profile.slug.startsWith(`saved-map-${mapRender.id}-`))
      .sort((a,b) => a.configuration.saved_map.position - b.configuration.saved_map.position);
    assert.equal(profiles.length, 2, "The real API must compile both exact occurrences through MapLibre");
    assert.deepEqual(profiles.map(profile => profile.configuration.saved_map.layer_id), nextMap.definition.layers.map(layer => layer.layerId).reverse());
    for (const profile of profiles) {
      const config = profile.configuration;
      const layer = nextMap.definition.layers.find(layer => layer.layerId === config.saved_map.layer_id);
      assert.equal(profile.resource_id, mapResource.id);
      assert.equal(profile.resource_version_id, mapRender.saved_map_snapshot.resource_version_id);
      assert.equal(config.renderer, "opengeo.maplibre-gl-js.v2");
      assert.deepEqual(config.runtime_ref, fontProof.runtimeReference);
      assert.equal(config.saved_map.schema, "opengeo.saved-map-gl-occurrence.1.0.0");
      assert.equal(config.saved_map.definition_checksum_sha256, mapRender.saved_map_snapshot.definition_checksum_sha256);
      assert.equal(config.saved_map.recipe_checksum_sha256, mapRender.saved_map_snapshot.recipe_checksum_sha256);
      assert.equal(config.saved_map.dataset_id, layer.datasetId);
      assert.equal(config.saved_map.dataset_version_id, layer.datasetVersionId);
      assert.deepEqual(config.font_ref, fontAssets.fontRef);
      const symbols = config.maplibre_style.layers.filter(entry => entry.type === "symbol");
      assert.equal(symbols.length, 1);
      assert.deepEqual(symbols[0].layout["text-font"], [fontAssets.fontStack]);
      assert.deepEqual(symbols[0].layout["text-field"], ["concat", "[", ["to-string", ["get", "label_name"]], "]"]);
      assert.equal(symbols[0].layout["text-allow-overlap"], true);
      assert.equal(symbols[0].paint["text-halo-width"], layer.labels.haloWidth);
      assert.equal(symbols[0].paint["text-color"], "#ffffff");
    }
    fontProof.compiledProfiles = profiles.map(profile => ({profileId:profile.id,configurationSha256:profile.checksum_sha256,
      layerId:profile.configuration.saved_map.layer_id,renderer:profile.configuration.renderer,
      runtimeReference:profile.configuration.runtime_ref,fontRef:profile.configuration.font_ref}));
    fontProof.savedMapSnapshot = mapRender.saved_map_snapshot;
    fontProof.renderJobId = mapRender.id;
  }
  await page.reload();
  await page.locator(`[data-resource-id="${mapResource.id}"]`).getByRole("button", {name: "Open resource", exact: true}).click();
  await detail.getByRole("button", {name: "Refresh map images", exact: true}).click();
  const existingMapImage = detail.getByLabel("Existing map image", {exact: true});
  await existingMapImage.locator(`option[value="${mapRender.id}"]`).waitFor({state: "attached"});
  assert.equal(await existingMapImage.inputValue(), "", "A history read must not choose or create an image");
  await existingMapImage.selectOption(mapRender.id);
  await worker();
  await detail.getByRole("button", {name: "Refresh render status", exact: true}).click();
  await detail.getByRole("button", {name: "Authorize exact PNG download", exact: true}).waitFor();
  const renderedMap = await readApi(`/projects/${project.id}/resources/${mapResource.id}/renders/${mapRender.id}`);
  assert.equal(renderedMap.state, "completed");
  assert.equal(renderedMap.format, "png");
  assert.equal(renderedMap.crs, "EPSG:3857");
  assert.deepEqual([renderedMap.width, renderedMap.height], [320, 240]);
  assert.deepEqual(renderedMap.saved_map_snapshot, mapRender.saved_map_snapshot);
  if (pinnedFontMode) fontProof.completedOutputSha256 = renderedMap.output_checksum_sha256;
  assert.notEqual(renderedMap.output_checksum_sha256, rendered.output_checksum_sha256, "A saved map composition must not be the earlier dataset PNG");
  for (const sourceDatasetId of [datasetId, conservationId]) {
    const sourceVersions = await readApi(`/projects/${project.id}/datasets/${sourceDatasetId}/versions`);
    assert.ok(sourceVersions.every(version => version.objects.every(object => object.id !== renderedMap.output_object_id)),
      "A multi-dataset map image must not be exposed through a source dataset's downloadable files");
    const datasetFileRequest = await apiRequest(
      `/projects/${project.id}/datasets/${sourceDatasetId}/versions/${sourceVersions[0].id}/objects/${renderedMap.output_object_id}/download`,
      {method: "POST", headers: {authorization: "Bearer synthetic-local-owner", "x-opengeo-organization": organization}});
    assert.equal(datasetFileRequest.status, 404, "Even the owner must use the map's authorization path for a composition image");
  }
  await detail.locator(".project-render-history-result").screenshot({path: join(work, "saved-map-png-result.png")});

  const story = await createResource("story", "Watershed field report");
  await detail.getByLabel("Markdown source",{exact:true}).fill("# Watershed field report\n\nTwo observations preserved and curated through Studio.");
  await detail.getByRole("button",{name:"Apply Markdown to draft",exact:true}).click();
  for (const [kind, record] of [["dataset",publishedDataset],["map",publishedMap]]) {
    await detail.getByLabel("Governed map or dataset",{exact:true}).selectOption({label:`${kind} · ${record.title} · v${record.version_number}`});
    await detail.getByRole("button",{name:"Add governed reference",exact:true}).click();
  }
  await detail.getByRole("button", {name:"Save new version",exact:true}).click();
  await detail.getByText(/Version 2 · draft/).waitFor();
  await publishResource();
  await page.locator(`a[href*="project=${project.id}"][href*="manage=publishing"]`).first().click();
  const siteCreator = page.locator('[data-site-destination="new"]');
  await siteCreator.getByLabel("Site title",{exact:true}).fill("Watershed publication");
  await siteCreator.getByLabel("Permanent site slug",{exact:true}).fill("watershed-pilot");
  await siteCreator.getByLabel("Include Watershed review map",{exact:true}).check();
  await siteCreator.getByLabel("Include Watershed field report",{exact:true}).check();
  await siteCreator.getByLabel("Watershed field report is the home page",{exact:true}).check();
  const siteCreated = page.waitForResponse((response)=>response.url().endsWith("/sites") && response.request().method()==="POST");
  await siteCreator.getByRole("button",{name:"Create draft site",exact:true}).click();
  const siteResponse = await siteCreated;
  assert.equal(siteResponse.status(),201);
  const site = await siteResponse.json();
  const siteCard = page.locator(`#site-${site.id}`);

  stage = "collaborator-edit";
  console.log(`Studio: ${stage}`);
  const collaborators = await openWorkspaceCollaborators(page);
  const invitationForm = collaborators.locator('form[data-purpose="project-invitation"]');
  await invitationForm.getByLabel("Collaborator email",{exact:true}).fill("reviewer@local.invalid");
  await invitationForm.getByLabel("Collaborator display name",{exact:true}).fill("Local reviewer");
  await invitationForm.getByLabel("Collaborator project role",{exact:true}).selectOption("editor");
  await invitationForm.getByRole("button",{name:"Create project invitation",exact:true}).click();
  await collaborators.getByText("reviewer@local.invalid was invited as editor. Access begins only after acceptance.",{exact:true}).waitFor();
  const reviewer = await context.newPage();
  reviewer.setDefaultTimeout(15_000);
  reviewer.on("pageerror",error=>errors.push(error.message));
  if (builtStudio) await reviewer.addInitScript(initializeIntegratedStudioSession, {organization, actor:"reviewer"});
  else await reviewer.addInitScript(()=>sessionStorage.setItem("local-actor","reviewer"));
  await reviewer.goto(`${origin}/workspaces`);
  await reviewer.getByRole("button",{name:"Accept invitation",exact:true}).click();
  await reviewer.getByRole("link", {name: "Publications", exact: true}).click();
  await reviewer.locator(`a[href*="publication=${site.id}"]`).click();
  await reviewer.waitForURL(url => url.searchParams.get("publication") === site.id);
  const reviewerCard = reviewer.locator(`#site-${site.id}`);
  // The Publication Pages workspace opens its draft editor by default.
  await reviewerCard.getByLabel("Site title",{exact:true}).fill("Watershed publication · reviewed");
  const edited = reviewer.waitForResponse(response=>response.url().endsWith(`/sites/${site.id}`)&&response.request().method()==="PUT");
  await reviewerCard.getByRole("button",{name:"Save draft revision",exact:true}).click();
  assert.equal((await edited).status(),200);
  await page.reload();
  await siteCard.getByRole("heading",{name:"Watershed publication · reviewed · watershed-pilot",exact:true}).waitFor();

  stage = "publication-export-revocation";
  console.log(`Studio: ${stage}`);
  await siteCard.getByRole("tab", {name: "Publish", exact: true}).click();
  await siteCard.getByRole("button", {name: "Configure public addresses…", exact: true}).click();
  // Address configuration opens Settings and its public-address disclosure.
  await siteCard.getByRole("combobox",{name:"Reach",exact:true}).selectOption("listed");
  const destinationSaved = page.waitForResponse(response=>response.url().endsWith(`/sites/${site.id}/publication-destination`) && response.request().method()==="PUT");
  const destinationCard = await siteCard.elementHandle();
  await siteCard.getByRole("button",{name:"Save destination",exact:true}).click();
  assert.equal((await destinationSaved).status(),200);
  await page.waitForFunction(element => !element.isConnected, destinationCard);
  await destinationCard.dispose();
  await siteCard.getByRole("tab", {name: "Publish", exact: true}).click();
  await siteCard.locator(".publication-listed").waitFor();
  const submitted = page.waitForResponse(response => response.url().endsWith(`/sites/${site.id}/review`) && response.request().method() === "POST");
  const reviewCard = await siteCard.elementHandle();
  await siteCard.getByRole("button",{name:"Submit revision for review",exact:true}).click();
  assert.equal((await submitted).status(), 200);
  await page.waitForFunction(element => !element.isConnected, reviewCard);
  await reviewCard.dispose();
  await siteCard.getByRole("tab", {name: "Publish", exact: true}).click();
  await siteCard.getByRole("button", {name: "Refresh completed map images", exact: true}).click();
  const mapImageChooser = siteCard.getByLabel("Map image for Watershed review map", {exact: true});
  await mapImageChooser.locator(`option[value="${mapRender.id}"]`).waitFor({state: "attached"});
  assert.match(await mapImageChooser.locator(`option[value="${mapRender.id}"]`).textContent(),
    new RegExp(`resource v${publishedMap.version_number} / map v${nextMap.version} · 320 × 240 PNG`));
  assert.equal(await mapImageChooser.inputValue(), "", "Reading available images must not silently select one");
  await mapImageChooser.selectOption(mapRender.id);
  await siteCard.getByText("Advanced image bindings", {exact: true}).click();
  await siteCard.getByLabel("Immutable PNG snapshots (optional)",{exact:true}).fill(`${resource.id} = ${render.id}`);
  await reviewer.reload();
  await reviewerCard.getByRole("tab", {name: "Publish", exact: true}).click();
  await reviewer.getByText("This revision is awaiting a project owner or reviewer. Your editorial work is preserved; publication requires separate approval.",{exact:true}).waitFor();
  assert.equal(await reviewer.getByRole("button",{name:"Publish reviewed edition",exact:true}).count(),0);
  const publishedEdition = page.waitForResponse(response => response.url().endsWith(`/sites/${site.id}/publish`) && response.request().method() === "POST");
  const publishingCard = await siteCard.elementHandle();
  await siteCard.getByRole("button",{name:"Publish reviewed edition",exact:true}).click();
  assert.equal((await publishedEdition).status(), 200);
  await page.waitForFunction(element => !element.isConnected, publishingCard);
  await publishingCard.dispose();
  await siteCard.getByRole("tab", {name: "Publish", exact: true}).click();
  const publicLink = siteCard.getByRole("link",{name:"Open listed site",exact:true});
  await publicLink.waitFor();
  const publicUrl = await publicLink.getAttribute("href");
  const zipLink = siteCard.getByRole("link",{name:"Download portable ZIP",exact:true});
  const zipUrl = await zipLink.getAttribute("href");
  const zipDownload = page.waitForEvent("download");
  await zipLink.click();
  const zipBytes = readFileSync(await (await zipDownload).path());
  const zip = unzipSync(zipBytes);
  assert.ok(Object.keys(zip).filter(name=>name.endsWith(".html")).length >= 2);
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.ok(Object.values(zip).some(bytes=>hash(bytes)===rendered.output_checksum_sha256),"ZIP contains the exact rendered PNG");
  const packagedPng = Object.keys(zip).find(name => name.endsWith(".png") && hash(zip[name]) === rendered.output_checksum_sha256);
  assert.ok(Buffer.from(zip["index.html"]).toString().includes(`src="${packagedPng}"`), "Portable home page displays the explicitly sealed dataset PNG");
  const packagedMapPng = `assets/maps/${mapResource.id}.png`;
  assert.ok(zip[packagedMapPng], "Portable edition contains the actual map-resource PNG");
  assert.equal(hash(zip[packagedMapPng]), renderedMap.output_checksum_sha256);
  assert.ok(Buffer.from(zip["index.html"]).toString().includes(`src="${packagedMapPng}"`), "Portable home page embeds the exact two-layer map image");
  const portableMapPages = Object.entries(zip).filter(([name, bytes]) => name.endsWith(".html") && name !== "index.html"
    && Buffer.from(bytes).toString().includes(`src="${packagedMapPng}"`));
  assert.ok(portableMapPages.length > 0, "The map's own portable page embeds the same two-layer image");
  writeFileSync(join(work,"publication.zip"),zipBytes);
  const anonymous = await context.newPage();
  await anonymous.goto(new URL(publicUrl,origin).href);
  await anonymous.getByRole("heading",{name:"Watershed field report",exact:true}).first().waitFor();
  const publishedImage = anonymous.locator(".content-image img");
  await publishedImage.waitFor();
  await publishedImage.evaluate(image => image.decode());
  assert.deepEqual(await publishedImage.evaluate(image => [image.naturalWidth, image.naturalHeight]), [320, 240]);
  const snapshotPath = new URL(await publishedImage.getAttribute("src"), origin).pathname;
  const publicSnapshot = await apiRequest(snapshotPath);
  assert.equal(publicSnapshot.status, 200);
  assert.equal(hash(publicSnapshot.body), rendered.output_checksum_sha256);
  const publishedMapImage = anonymous.locator(".map-embed img");
  await publishedMapImage.waitFor();
  await publishedMapImage.evaluate(image => image.decode());
  assert.deepEqual(await publishedMapImage.evaluate(image => [image.naturalWidth, image.naturalHeight]), [320, 240]);
  const displayedMapShape = await publishedMapImage.evaluate(image => {
    const bounds = image.getBoundingClientRect();
    return {ratio: bounds.width / bounds.height, objectFit: getComputedStyle(image).objectFit};
  });
  assert.ok(Math.abs(displayedMapShape.ratio - 320 / 240) < 0.01, "Publication layout must preserve the map's aspect ratio");
  assert.equal(displayedMapShape.objectFit, "contain", "A map must not be cropped to fill a decorative frame");
  const mapSnapshotPath = new URL(await publishedMapImage.getAttribute("src"), origin).pathname;
  const publicMapSnapshot = await apiRequest(mapSnapshotPath);
  assert.equal(publicMapSnapshot.status, 200);
  assert.equal(hash(publicMapSnapshot.body), renderedMap.output_checksum_sha256);
  // Sample interiors, not anti-aliased boundaries: blue-only watershed,
  // orange-only conservation, and their overlap prove both sources and order.
  const compositionPixels = await publishedMapImage.evaluate((image, {bbox, points}) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const drawing = canvas.getContext("2d");
    drawing.drawImage(image, 0, 0);
    return points.map(([longitude, latitude]) => {
      const radius = 6378137;
      const x = radius * longitude * Math.PI / 180;
      const y = radius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      const px = Math.floor((x - bbox[0]) / (bbox[2] - bbox[0]) * canvas.width);
      const py = Math.floor((bbox[3] - y) / (bbox[3] - bbox[1]) * canvas.height);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) throw new Error("Composition sample outside saved image view");
      return [...drawing.getImageData(px, py, 1, 1).data];
    });
  }, {bbox:renderedMap.bbox, points:pinnedFontMode ? FONT_COMPOSITION_PROBES : [[-72.45, 42.02], [-72.3, 42.06], [-72.45, 42.06]]});
  const blend = (foreground, background, opacity) => foreground.map((value, index) => Math.round(value * opacity + background[index] * (1 - opacity)));
  const blue = [37, 99, 235], orange = [231, 111, 81], background = [6, 21, 38];
  const blueOnly = blend(blue, background, 0.8 * 0.45);
  const orangeOnly = blend(orange, background, 0.9 * 0.45);
  const orangeOverBlue = blend(orange, blueOnly, 0.9 * 0.45);
  for (const [index, expected] of [blueOnly, orangeOnly, orangeOverBlue].entries()) {
    assert.equal(compositionPixels[index][3], 255);
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(compositionPixels[index][channel] - expected[channel]) <= 2,
        `Saved composition sample ${index}: ${compositionPixels[index]} must match ${expected}`);
    }
  }
  if (pinnedFontMode) {
    // The three source interiors still satisfy the exact color/order checks
    // above. White pixels are a separate label witness, never a replacement.
    const pixels = await publishedMapImage.evaluate(image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const drawing = canvas.getContext("2d"); drawing.drawImage(image,0,0);
      const data = drawing.getImageData(0,0,canvas.width,canvas.height).data;
      let white = 0, black = 0;
      for (let i=0;i<data.length;i+=4) {
        if (data[i+3]!==255) continue;
        if (data[i]>=245 && data[i+1]>=245 && data[i+2]>=245) white++;
        if (data[i]<=3 && data[i+1]<=3 && data[i+2]<=3) black++;
      }
      return {whiteLabelPixels:white,blackHaloPixels:black};
    });
    assert.ok(pixels.whiteLabelPixels >= 20, "The exact published map PNG must contain real white label glyphs");
    assert.ok(pixels.blackHaloPixels >= 20, "The exact published map PNG must retain its deliberately selected black halo");
    fontProof.publishedPixelWitness = pixels;
    fontProof.compositionProbeCoordinates = FONT_COMPOSITION_PROBES;
    fontProof.exactPublishedPngSha256 = hash(publicMapSnapshot.body);
    fontProof.exactPortablePngSha256 = hash(zip[packagedMapPng]);
    for (const [path, asset] of fontAssets.files) assert.ok(fontRequests.some(request =>
      builtStudio ? request.sha256 === hash(asset.bytes) : request.path === path),
    `The actual Studio must have read and verified ${path}`);
  }
  const stylesheetUrl = await anonymous.locator('link[rel="stylesheet"]').getAttribute("href");
  const stylesheetPath = new URL(stylesheetUrl, origin).pathname;
  assert.ok(requests.some(request => request.path === stylesheetPath && request.status === 200 && !request.authenticated), "Public stylesheet was delivered anonymously");
  await anonymous.screenshot({path:join(work,"published-site.png"),fullPage:true});
  await anonymous.getByRole("navigation").getByRole("link", {name: "Watershed review map", exact: true}).click();
  await anonymous.getByRole("heading", {name: "Watershed review map", exact: true}).first().waitFor();
  const mapPageUrl = anonymous.url();
  await anonymous.locator(".map-embed img").evaluate(image => image.decode());
  assert.equal(new URL(await anonymous.locator(".map-embed img").getAttribute("src"), origin).pathname, mapSnapshotPath,
    "The map's own public page uses the identical sealed PNG");
  await anonymous.screenshot({path: join(work, "published-map-page.png"), fullPage: true});
  for (const url of [publicUrl,mapPageUrl,zipUrl,snapshotPath,mapSnapshotPath]) {
    const path = new URL(url,origin).pathname.replace(/^\/api/,"");
    const delivered = requests.filter(request=>request.path===path && request.status===200);
    assert.ok(delivered.length>0,`Public browser delivery was observed: ${path}`);
    assert.ok(delivered.every(request=>!request.authenticated));
  }

  if (restoreCheckpoint) {
    stage = "restore-published-project";
    console.log(`Studio: ${stage}`);
    writeFileSync(join(work, "restore-request.json"), JSON.stringify({checkpoint:"published-edition",version:1}) + "\n", {flag:"wx"});
    const deadline = Date.now() + 180_000;
    while (!existsSync(join(work, "restore-ready.json"))) {
      assert.ok(Date.now() < deadline, "The host restore checkpoint did not finish");
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(JSON.parse(readFileSync(join(work, "restore-ready.json"))), {status:"ready",socketPath:"restored/api.sock"});
    apiSocket = join(work, "restored/api.sock");
    const recoveredMap = await readApi(`/projects/${project.id}/maps/${maps[0].id}`);
    assert.deepEqual(recoveredMap.definition, nextMap.definition);
    assert.equal(recoveredMap.version, nextMap.version);
    const recoveredZip = await apiRequest(new URL(zipUrl, origin).pathname.replace(/^\/api/, ""));
    assert.equal(recoveredZip.status, 200);
    assert.equal(hash(recoveredZip.body), hash(zipBytes));
    const recoveredImage = await apiRequest(mapSnapshotPath);
    assert.equal(recoveredImage.status, 200);
    assert.equal(hash(recoveredImage.body), renderedMap.output_checksum_sha256);
    await page.reload();
    await page.locator(`#site-${site.id}`).getByRole("tab", {name: "Publish", exact: true}).click();
    await page.locator(`#site-${site.id}`).getByRole("link", {name:"Open listed site", exact:true}).waitFor();
    await reviewer.reload();
    await reviewer.locator(`#site-${site.id}`).waitFor();
    assert.equal(await reviewer.getByRole("button", {name:"Publish reviewed edition", exact:true}).count(), 0);
    await anonymous.reload();
    await anonymous.locator(".map-embed img").evaluate(image => image.decode());
    await anonymous.screenshot({path:join(work,"restored-published-map.png"),fullPage:true});
    const checkpoint = JSON.parse(readFileSync(join(work, "restore-checkpoint-proof.json")));
    assert.notEqual(checkpoint.sourceDatabase, checkpoint.restoredDatabase);
    assert.equal(checkpoint.exactRestoreBeforeReads, true);
    restoration = {verified:true, savedMapVersion:recoveredMap.version,
      publishedPngSha256:hash(recoveredImage.body), portableZipSha256:hash(recoveredZip.body),
      publishingReloaded:true, reviewerCannotPublish:true, anonymousImageReloaded:true,
      sourceDatabase:checkpoint.sourceDatabase, restoredDatabase:checkpoint.restoredDatabase};
  }

  stage = "sealed-image-head-change";
  console.log(`Studio: ${stage}`);
  const changedHeadEditor = await context.newPage();
  changedHeadEditor.on("pageerror", error => errors.push(error.message));
  await changedHeadEditor.goto(`${origin}/workspaces?project=${project.id}&map=${maps[0].id}`);
  await changedHeadEditor.waitForFunction(() => document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
  await changedHeadEditor.getByRole("button", {name: `Move ${watershedLayerTitle} up`, exact: true}).click();
  const headSaved = changedHeadEditor.waitForResponse(response => response.url().endsWith(`/maps/${maps[0].id}`) && response.request().method() === "PATCH");
  await changedHeadEditor.getByRole("button", {name: "Save", exact: true}).click();
  const headResponse = await headSaved;
  assert.equal(headResponse.status(), 200);
  const changedHead = await headResponse.json();
  assert.ok(changedHead.version > nextMap.version);
  assert.deepEqual(changedHead.definition.layers.map(layer => layer.datasetId), [datasetId, conservationId]);
  await changedHeadEditor.close();
  const stillPinned = await readApi(`/projects/${project.id}/resources/${mapResource.id}`);
  assert.deepEqual(stillPinned.map_snapshot, publishedMap.map_snapshot);
  const stableSnapshot = await apiRequest(mapSnapshotPath);
  assert.equal(stableSnapshot.status, 200);
  assert.equal(hash(stableSnapshot.body), renderedMap.output_checksum_sha256, "Editing the mutable map head does not replace the published image");
  const stableZipResponse = await apiRequest(new URL(zipUrl, origin).pathname.replace(/^\/api/, ""));
  assert.equal(stableZipResponse.status, 200);
  assert.equal(hash(unzipSync(stableZipResponse.body)[packagedMapPng]), renderedMap.output_checksum_sha256);

  stage = "saved-map-source-revocation";
  console.log(`Studio: ${stage}`);
  const sourceEditor = await context.newPage();
  sourceEditor.on("pageerror", error => errors.push(error.message));
  await sourceEditor.goto(`${origin}/workspaces?project=${project.id}&manage=resources`);
  await sourceEditor.locator(`[data-resource-id="${conservationResource.id}"]`).getByRole("button", {name: "Open resource", exact: true}).click();
  const sourceDetail = sourceEditor.locator('.project-resource-detail[data-state="ready"]');
  await sourceDetail.getByLabel("Decision note", {exact: true}).fill("Withdraw conservation source publication after exact map delivery verification");
  await sourceDetail.getByRole("button", {name: "Archive", exact: true}).click();
  await sourceDetail.getByText(/Version \d+ · archived ·/).waitFor();
  for (const url of [publicUrl,mapPageUrl,zipUrl,mapSnapshotPath]) {
    const denied = await apiRequest(new URL(url, origin).pathname.replace(/^\/api/, ""));
    assert.equal(denied.status, 404, "Revoking either saved-map dataset's public resource must block the whole edition and exact image");
  }
  await sourceEditor.close();
  await anonymous.close();
  await siteCard.getByRole("button",{name:"Revoke public edition",exact:true}).click();
  await publicLink.waitFor({state:"detached"});
  for (const url of [publicUrl,mapPageUrl,zipUrl,snapshotPath,mapSnapshotPath]) {
    const response = await apiRequest(new URL(url,origin).pathname.replace(/^\/api/,""));
    assert.equal(response.status,404,"Revoked publication must not remain readable");
  }
  const currentAccess = await openWorkspaceCollaborators(page);
  await currentAccess.getByRole("button",{name:"Load current access",exact:true}).click();
  const member = currentAccess.locator('[data-member-id="20000000-0000-4000-8000-000000000002"]');
  await member.getByRole("button",{name:"Remove",exact:true}).click();
  await member.waitFor({state:"detached"});
  const deniedPublication = reviewer.waitForResponse(response => response.url().endsWith(`/publications/${site.id}`) && response.request().method() === "GET");
  await reviewer.reload();
  assert.equal((await deniedPublication).status(), 404, "Removed collaborator must receive the canonical Publication denial");
  await reviewer.getByRole("heading",{name:"Publication not found",exact:true}).waitFor();
  await reviewer.close();
  assert.deepEqual(errors, []);
  if (builtStudio) {
    for (const openPage of context.pages()) {
      assert.equal(await openPage.locator(".observablehq--error").count(), 0,
        "Observable cells must not hide an application entry failure");
    }
  }
  writeFileSync(join(work, "browser-result.json"), JSON.stringify({
    status: "pass", projectId: project.id, datasetId, mapId: maps[0].id,
    featureCount: 2, conservationDatasetId: conservationId, conservationFeatureCount: 1,
    exactVersionMapSavedAndReopened: true, governedPolygonsRendered: true,
    editableCollectionChoiceRetainedAfterSnapshot: true,
    mapResourceRevision: {resourceId: mapResource.id, original: mapResource.map_snapshot,
      selected: selectedMapResource.map_snapshot, metadataRetainedOriginalPin: true,
      unsavedNotesPreservedDuringRead: true, explicitRevisionSelected: true},
    siteId:site.id, storyId:story.id,
    pmtilesCompleted:pmtilesConversion.status === "passed", pmtilesConversion,
    metadataExported:true, pngRendered:true, portableZipSha256:hash(zipBytes),
    serviceConnection:serviceConnectionProof,
    ...(accessProof ? {viewerAccess: accessProof} : {}),
    ...(serviceClientsMode ? {serviceClients} : {}),
    anonymousPublicationAndRevocation:true, publishedDatasetImageVisible:true,
    savedMapComposition: {renderJobId: mapRender.id, resourceId: mapResource.id,
      datasetIds: [datasetId, conservationId], datasetVersionIds: [completion.dataset_version_id, conservationCompletion.dataset_version_id],
      savedMapVersion: nextMap.version, laterHeadVersion: changedHead.version,
      layerOrder: nextMap.definition.layers.map(layer => layer.datasetId),
      outputSha256: renderedMap.output_checksum_sha256, compositionPixels,
      exactPngOnHomeAndMapPageAndZip: true, unchangedAfterMapHeadEdit: true,
      compositionExcludedFromSourceDatasetFiles: true,
      queuedImageResumedAfterPageReload: true,
      displayedMapAspectRatioPreserved: true,
      secondSourcePublicRightsRevocationBlocksDelivery: true},
    publicStylesheetAndPageNavigation:true,
    syntheticReviewerInvitationEditAndProjectRevocation:true,
    invalidUpload: {datasetId: invalidId, errorCode: invalid.processing_error_code,
      inputSha256: invalidSha256, originalSha256: invalidVersion.objects[0].checksum_sha256,
      failedOriginalPreserved: true, noDerivatives: true, studioDiagnosisVisible: true},
    ...(pinnedFontMode ? {pinnedMapFonts:{...fontProof,assetRequests:fontRequests}} : {}),
    ...(builtStudio ? {applicationShell:{...builtShell.evidence, requests:builtRequests,
      homeToProjectsNavigation:true, normalSessionStorageAndAdapter:true,
      normalFileAttachments:true}} : {}),
    ...(restoreCheckpoint ? {restoration} : {}),
    scope: `${builtStudio ? "Observable-built Studio pages and normal browser adapter" : "Actual directory/project/data/map/resource/publishing controls"}; real API/SQL/worker; synthetic login and cloud transport`,
    managedConversion,
    notProven: ["deployed Studio", "Cognito", "S3/SQS/KMS", "two-person acceptance", "full pilot"]
  }, null, 2) + "\n");
  }
} catch (error) {
  if(buildingReviewMode)checkpointBuildingReview({status:'failed',error:error.stack,phase:buildingReviewProgress.phase??stage});
  if(baselineStudyMode)checkpointBaseline({status:'failed',error:error.stack,phase:baselineProgress.phase??stage});
  if(retainedAnalysisMode){ftwStatus="failed";checkpointFtw();}
  writeFileSync(join(work,buildingReviewMode?`${buildingReviewPrefix}-failure.json`:baselineStudyMode?"baseline-failure.json":"failure.json"),JSON.stringify({stage,error:error.stack,pageErrors:errors,
    ...(mapArtifactMode?{apiRequestAttempts:mapArtifactApiAttempts,priorApiRequestAttempts:mapArtifactPriorApiAttempts,
        cumulativeApiRequestAttempts:mapArtifactPriorApiAttempts+mapArtifactApiAttempts}:{}),
      ...(catalogStudyMode?{apiRequestAttempts:catalogStudyApiAttempts,priorApiRequestAttempts:catalogStudyPriorApiAttempts,
      cumulativeApiRequestAttempts:catalogStudyPriorApiAttempts+catalogStudyApiAttempts}:{})},null,2)+"\n");
  if (page) {
    const diagnosticPages = browser.contexts().flatMap(context => context.pages());
    for (const [index, diagnosticPage] of diagnosticPages.entries()) {
      const mapState = await diagnosticPage.evaluate(() => {
        const shell = document.querySelector(".opengeo-workbench");
        const map = shell?.__opengeoMap;
        if (!map) return null;
        return {center: map.getCenter(), zoom: map.getZoom(), styleLoaded: map.isStyleLoaded(),
          styleLayers: map.getStyle()?.layers.map(layer => ({id:layer.id,type:layer.type})),
          layers: shell.__opengeoLayers,
          data: [...(shell.__opengeoData ?? new Map()).entries()],
          rendered: map.queryRenderedFeatures().map(feature => ({layer: feature.layer.id, properties: feature.properties}))};
      }).catch(() => null);
      const prefix = buildingReviewMode?`${buildingReviewPrefix}-failure-page-${index}`:baselineStudyMode?`baseline-failure-page-${index}`:diagnosticPage === page ? "failure" : `failure-page-${index}`;
      writeFileSync(join(work, `${prefix}-map.json`), JSON.stringify(mapState, null, 2) + "\n");
      await diagnosticPage.screenshot({path: join(work, `${prefix}.png`), fullPage: true}).catch(() => {});
      writeFileSync(join(work, `${prefix}.html`), await diagnosticPage.content());
    }
    console.error(`Studio failed at ${stage}; page errors: ${JSON.stringify(errors)}`);
  }
  throw error;
} finally {
  clearTimeout(publicationBrowserTimer);
  clearTimeout(developmentBrowserTimer);
  clearTimeout(ftwBrowserTimer);checkpointFtw();
  if(baselineStudyMode)checkpointBaseline();
  if(buildingReviewMode)checkpointBuildingReview();
  if (printSmoke) checkpointPrint();
  else if (developmentSmoke) checkpointDevelopment();
  if(catalogStudyMode&&existsSync(catalogStudyProgressPath)){
    const facts=JSON.parse(readFileSync(catalogStudyProgressPath));
    if(facts.mode==='catalog-study')writeFileSync(catalogStudyProgressPath,JSON.stringify({...facts,
      apiRequestAttempts:catalogStudyPriorApiAttempts+catalogStudyApiAttempts},null,2)+'\n');
  }
  if(mapArtifactMode&&existsSync(catalogStudyProgressPath)){
    const facts=JSON.parse(readFileSync(catalogStudyProgressPath));
    writeFileSync(catalogStudyProgressPath,JSON.stringify({...facts,mapArtifact:{...facts.mapArtifact,
      apiRequestAttempts:mapArtifactPriorApiAttempts+mapArtifactApiAttempts,
      activeMilliseconds:mapArtifactPriorMilliseconds+Date.now()-mapArtifactStarted}},null,2)+'\n');
  }
  writeFileSync(requestReceiptPath, JSON.stringify(buildingReviewMode?[...priorBuildingReviewRequests,...requests]:baselineStudyMode?[...priorBaselineRequests,...requests]:printTemplateSmoke ? [...priorPrintTemplateRequests, ...requests] : requests, null, 2) + "\n",
    printTemplateSmoke||buildingReviewMode ? {mode: 0o600} : undefined);
  if (browser) await browser.close();
  if (previewServer) await new Promise((done) => previewServer.close(done));
  if (publicServer) await new Promise((done) => publicServer.close(done));
  await new Promise((done) => server.close(done));
}
