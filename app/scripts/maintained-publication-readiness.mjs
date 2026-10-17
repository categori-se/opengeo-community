import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {readJson, safeJoin, sha256, verifyManifestSeal} from "./release-utils.mjs";

// This editorial/directory increment keeps the already accepted login, API and
// grants. Reuse exact artifact-bound account acceptance for a host-shell change;
// the legacy first-cutover managed-login gate remains unchanged for v2 bundles.
export async function assertMaintainedPublicationReadiness(workspaceRoot, {fetchImplementation = fetch} = {}) {
  const work = resolve(workspaceRoot, ".local-archives/public-article-revision");
  const manifest = verifyManifestSeal(await readJson(resolve(work, "studio/dist/opengeo-studio-release.json")), "Reviewed Studio increment");
  const deployment = verifyManifestSeal(await readJson(resolve(work, "studio/dist/opengeo-studio-deployment-record.json")), "Studio increment deployment");
  const receipt = await readJson(resolve(work, "studio-directory-acceptance.json"));
  const saved = await readJson(resolve(work, "source-save-receipt.json"));
  const reader = await readJson(resolve(work, "public-pages-check.json"));
  const delta = await readJson(resolve(work, "studio/source-delta.json"));
  const bundle = verifyManifestSeal(await readJson(resolve(workspaceRoot,"dist/opengeo-public-bundle.json")),"Public collection");
  const shell = bundle.source.sharedAssets ? await readJson(resolve(work,"shell-integration/check.json")) : null;
  if (shell && (shell.status!=="passed" || shell.errors.length || shell.checks.readerLight?.length!==8 || shell.checks.readerDark?.length!==8 || shell.checks.publicationDirectory!=="passed" || shell.checks.mobileNavigationAndOutline!=="passed")) throw Error("Hosted publication interaction checks are incomplete");
  if (shell) {
    const notebook=bundle.source.builds.find(b=>b.mount==="accessible-cartographic-design").artifactTree.files.find(f=>f.path==="index.html");
    const projects=bundle.source.builds.find(b=>b.mount==="").artifactTree.files.find(f=>f.path==="projects/index.html");
    const noaa=bundle.source.builds.find(b=>b.mount==="noaa-coastal-imagery");
    if(bundle.source.revisions?.some(r=>r.name==="noaa"&&r.revisionNumber>=9) && (shell.inputs?.noaaTree!==noaa?.artifactTree.digest || shell.checks.noaaNavigation?.length!==4))throw Error("NOAA global-navigation acceptance is incomplete");
    if(bundle.source.revisions?.some(r=>r.name==="noaa"&&r.revisionNumber>=10) && shell.checks.noaaOrganization?.pages?.length!==8)throw Error("NOAA dataset and analytical publication placement acceptance is incomplete");
    const nepal=bundle.source.builds.find(b=>b.mount==="nepal-census-tables");
    if(nepal && (shell.inputs?.nepalHTML!==nepal.artifactTree.files.find(f=>f.path==="index.html")?.sha256 || !shell.checks.nepalLight || !shell.checks.nepalDark || shell.checks.nepalLayouts?.length!==6))throw Error("Native Nepal hosted reader acceptance is incomplete");
    if (shell.inputs?.notebookHTML!==notebook.sha256 || shell.inputs?.projectsHTML!==projects.sha256 || !bundle.source.sharedAssets.some(a=>a.sha256===shell.inputs.sharedCSS&&a.path.endsWith(".css")) || !bundle.source.sharedAssets.some(a=>a.sha256===shell.inputs.sharedScript&&a.path.endsWith(".js"))) throw Error("Hosted reader evidence changed");
  }
  if(bundle.source.builds.length===12){
    const requested=await readJson(resolve(work,"project-publications/native-publication.json"));
    const checks=await readJson(resolve(work,"project-publications/notebook-check.json"));
    if(requested.status!=="passed"||requested.sessionCleared!==true||requested.directoryUI?.status!=="passed"||requested.directoryUI.checked.length!==7||requested.authorUI?.status!=="passed"||requested.authorUI.cells!==22||checks.status!=="passed"||checks.articles.length!==7||checks.externalRequests!==0||shell.checks.requestedPublications?.length!==14||shell.checks.datasetIntroductions!=="passed")throw Error("Seven named publication acceptance is incomplete");
    for(const row of Object.values(requested.records))if(row.review?.deployment?.stage!=="deployed"||!row.previewAccepted?.compiledCellsIdentical)throw Error("A named native publication remains unfinished");
  }
  const changed = ["app/src/components/FrameworkDataAttachments.js", "app/src/components/CompositionDirectory.js", "app/src/components/PublicationWorkspaceDirectory.js", "app/src/components/PlatformDirectory.js", "app/src/lib/applicationRoutes.js", "app/src/lib/retainedTestRecords.js"];
  if (JSON.stringify(delta.changed) !== JSON.stringify(changed) || delta.pendingPatternGeographyIncluded !== false) throw Error("Studio release expanded beyond the reviewed directory increment");
  if (!Number.isFinite(Date.parse(receipt.finishedAt)) || deployment.alias !== "studio.opengeo.tools" || deployment.originPathOwner !== "OpenGeo-production-StudioWeb"
    || receipt.status !== "passed" || receipt.studioTree !== manifest.artifactTree.digest
    || receipt.releaseOriginPath !== deployment.releaseOriginPath || receipt.sessionsCleared !== true
    || (!shell && Date.now() - Date.parse(receipt.finishedAt) > 2 * 60 * 60 * 1000) || Date.parse(receipt.finishedAt) > Date.now() + 300000
    || !["normalAccount", "defaultTestFilters", "testRecordsRetained", "namedProjectLinks", "projectContext", "sourceRevisionReopen", "anonymousDenied", "authUnchanged", "edgeSecurity"].every(k => receipt.checks?.[k] === "passed")) throw Error("Current deployed Studio workflow acceptance is incomplete");
  if (saved.status !== "passed" || Object.keys(saved.readback).length !== 4 || reader.status !== "passed" || reader.errors.length) throw Error("Saved article or reader checks are incomplete");
  let currentManifest = manifest, currentDeployment = deployment, continuation;
  try {continuation = await readJson(resolve(work,"non-spatial/accepted-continuation.json"));}
  catch(error) {if(error.code !== "ENOENT") throw error;}
  if (continuation) {
    const next = verifyManifestSeal(await readJson(resolve(work,"non-spatial/studio/dist/opengeo-studio-release.json")),"Catalog Studio release");
    const deployed = verifyManifestSeal(await readJson(resolve(work,"non-spatial/studio/dist/opengeo-studio-deployment-record.json")),"Catalog Studio deployment");
    const accepted = await readJson(resolve(work,"non-spatial/live-acceptance.json"));
    const sourceDelta = await readJson(resolve(work,"non-spatial/source-delta.json"));
    const expectedChanges = ["app/src/components/CatalogTablePreview.js","app/src/components/DatasetVersionFiles.js","app/src/components/LayerResourcePage.js"];
    if (continuation.status !== "deployed and accepted" || continuation.baselineTree !== manifest.artifactTree.digest
      || sourceDelta.baselineTree !== manifest.artifactTree.digest || JSON.stringify(sourceDelta.changed) !== JSON.stringify(expectedChanges)
      || sourceDelta.pendingPatternGeographyIncluded !== false || sourceDelta.pendingPublicFileCompilerIncluded !== false || sourceDelta.noAPIChange !== true
      || next.authConfig.sha256 !== manifest.authConfig.sha256 || deployed.previousOriginPath !== deployment.releaseOriginPath
      || deployed.alias !== deployment.alias || deployed.originPathOwner !== deployment.originPathOwner
      || continuation.studioTree !== next.artifactTree.digest || accepted.studioTree !== next.artifactTree.digest
      || accepted.releaseOriginPath !== deployed.releaseOriginPath || accepted.status !== "passed" || accepted.sessionsCleared !== true
      || accepted.errors?.length || !Number.isFinite(Date.parse(accepted.finishedAt)) || Date.parse(accepted.finishedAt)>Date.now()+300000
      || !["normalAccount","anonymousDenied","authUnchanged","edgeSecurity","nonSpatialTables"].every(k=>accepted.checks?.[k]==="passed")
      || !["07169f09-bb66-492a-9607-4bed121031dc","7bbf47df-7167-4448-980c-76214b53c235"].every(k=>accepted.checks?.[k]?.status==="passed")) throw Error("Catalog Studio continuation acceptance is incomplete");
    currentManifest = next; currentDeployment = deployed;
  }
  let entryContinuation;
  try {entryContinuation = await readJson(resolve(work,"studio-entry/accepted-continuation.json"));}
  catch(error) {if(error.code !== "ENOENT") throw error;}
  if (entryContinuation) {
    const next = verifyManifestSeal(await readJson(resolve(work,"studio-entry/studio/dist/opengeo-studio-release.json")),"Public-entry Studio release");
    const deployed = verifyManifestSeal(await readJson(resolve(work,"studio-entry/studio/dist/opengeo-studio-deployment-record.json")),"Public-entry Studio deployment");
    const accepted = await readJson(resolve(work,"studio-entry/live-acceptance.json"));
    const sourceDelta = await readJson(resolve(work,"studio-entry/source-delta.json"));
    const expectedChanges = ["app/src/index.md","app/src/lib/authNavigation.js"];
    if (entryContinuation.status !== "deployed and accepted" || entryContinuation.baselineTree !== currentManifest.artifactTree.digest
      || sourceDelta.baselineTree !== currentManifest.artifactTree.digest || JSON.stringify(sourceDelta.changed) !== JSON.stringify(expectedChanges)
      || sourceDelta.pendingPatternGeographyIncluded !== false || sourceDelta.pendingPublicFileCompilerIncluded !== false || sourceDelta.noAPIChange !== true
      || next.authConfig.sha256 !== currentManifest.authConfig.sha256 || deployed.previousOriginPath !== currentDeployment.releaseOriginPath
      || deployed.alias !== currentDeployment.alias || deployed.originPathOwner !== currentDeployment.originPathOwner
      || entryContinuation.studioTree !== next.artifactTree.digest || accepted.studioTree !== next.artifactTree.digest
      || accepted.releaseOriginPath !== deployed.releaseOriginPath || accepted.status !== "passed" || accepted.sessionsCleared !== true
      || accepted.errors?.length || !Number.isFinite(Date.parse(accepted.finishedAt)) || Date.parse(accepted.finishedAt)>Date.now()+300000
      || !["normalAccount","anonymousDenied","authUnchanged","edgeSecurity","anonymousDemo","signedInStudio"].every(k=>accepted.checks?.[k]==="passed")) throw Error("Public-entry Studio continuation acceptance is incomplete");
    currentManifest = next; currentDeployment = deployed;
  }
  let catalogPreviewContinuation;
  try {catalogPreviewContinuation = await readJson(resolve(work,"studio-entry/catalog-preview-continuation.json"));}
  catch(error) {if(error.code !== "ENOENT") throw error;}
  if (catalogPreviewContinuation) {
    // Reuse the account/security journey only for this reviewed frontend delta.
    // Retained software delivery is not a new owner/provider rendering claim.
    const accepted = catalogPreviewContinuation, evidence = {};
    const required = ["release","deployment","predecessor","delivery","scope","preservation","owning","releaseChecks","execution"];
    if (JSON.stringify(Object.keys(accepted.evidence ?? {}).sort()) !== JSON.stringify([...required].sort())) throw Error("Catalog preview continuation evidence is incomplete");
    for (const name of required) {
      const pin = accepted.evidence[name];
      if (!pin.path?.startsWith(".local-archives/")) throw Error("Catalog preview continuation evidence must be retained locally");
      const bytes = await readFile(safeJoin(workspaceRoot, pin.path));
      if (sha256(bytes) !== pin.sha256) throw Error("Catalog preview continuation evidence changed");
      evidence[name] = JSON.parse(bytes);
    }
    const next = verifyManifestSeal(evidence.release,"Catalog preview Studio release");
    const deployed = verifyManifestSeal(evidence.deployment,"Catalog preview Studio deployment");
    const predecessor = verifyManifestSeal(evidence.predecessor,"Preserved Studio predecessor");
    const releaseDigest = (value, fileSHA) => sha256(JSON.stringify({artifactTree:value.artifactTree,aliases:value.aliases,manifestSha256:fileSHA}));
    const expectedScope = ["app/package.json","app/package-lock.json","app/observablehq.config.js","app/scripts/deploy-studio-site.mjs","app/scripts/static-release-aws.mjs","app/src/components/PlatformDirectory.js","app/src/components/CatalogResourceMapAction.js","app/src/lib/catalogLayerPreview.js","app/src/components/CatalogLayerPreview.js","app/src/components/LayerResourcePage.js","app/src/components/LayerCatalogResults.js","app/src/components/StaticItemCatalogRegistration.js","app/src/components/StaticItemSearch.js"];
    const {scope,preservation,delivery,owning,releaseChecks,execution} = evidence;
    if (accepted.status !== "deployed with unchanged account acceptance reused" || accepted.baselineTree !== currentManifest.artifactTree.digest
      || accepted.studioTree !== next.artifactTree.digest || accepted.releaseOriginPath !== deployed.releaseOriginPath
      || accepted.ownerRenderingRerun !== false || next.authConfig.sha256 !== currentManifest.authConfig.sha256 || predecessor.authConfig.sha256 !== currentManifest.authConfig.sha256
      || deployed.alias !== currentDeployment.alias || deployed.originPathOwner !== currentDeployment.originPathOwner
      || deployed.previousOriginPath !== accepted.previousOriginPath || predecessor.artifactTree.digest !== accepted.predecessorTree
      || !deployed.previousOriginPath.endsWith(releaseDigest(predecessor,accepted.evidence.predecessor.sha256).slice(0,12)) || deployed.releaseDigest !== releaseDigest(next,accepted.evidence.release.sha256)
      || scope.passed !== true || scope.authSHA !== next.authConfig.sha256 || scope.backend !== "unchanged"
      || !["API","SRP","providers","IAM","migrations"].every(k=>scope[k]===0)
      || JSON.stringify(scope.checks?.map(c=>c.path)) !== JSON.stringify(expectedScope)
      || scope.checks.some(c=>!Object.entries(c).some(([k,v])=>k!=="path"&&v===true))
      || preservation.allPreserved !== true || preservation.checks?.length !== 17 || preservation.checks.some(c=>c.preserved!==true)
      || owning.exitCode !== 0 || releaseChecks.length !== 3 || releaseChecks.some(c=>c.exitCode!==0)
      || execution.status !== "publisher-completed" || execution.exitCode !== 0 || execution.treeDigest !== next.artifactTree.digest
      || execution.releaseOriginPath !== deployed.releaseOriginPath || execution.invalidationId !== deployed.invalidationId
      || delivery.pass !== true || delivery.checks?.length !== 5 || delivery.checks.some(c=>c.status!==200||c.exact!==true||c.bytes!==c.expectedBytes)
      || !delivery.checks.some(c=>c.path==="opengeo-studio-release-manifest.json")) throw Error("Catalog preview Studio continuation acceptance is incomplete");
    for (const check of delivery.checks.filter(c=>c.path!=="opengeo-studio-release-manifest.json")) {
      if (next.artifactTree.files.find(f=>f.path===check.path)?.bytes !== check.expectedBytes) throw Error("Catalog preview delivery does not match the accepted release");
    }
    currentManifest = next; currentDeployment = deployed;
  }
  const index = currentManifest.artifactTree.files.find(f => f.path === "index.html");
  for (const [path, expected] of [["index.html", index.sha256], ["auth-config.json", currentManifest.authConfig.sha256]]) {
    const response = await fetchImplementation(`https://studio.opengeo.tools/${path}`, {cache: "no-store", signal: AbortSignal.timeout(20000)});
    if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== expected) throw Error("Live Studio changed after acceptance");
  }
  const oldAuth = await readFile(resolve(work, "studio/retained-auth-config.json"));
  if (sha256(oldAuth) !== manifest.authConfig.sha256) throw Error("Authentication configuration changed");
  return {workflow: "publication-directory-and-source", Studio: currentDeployment.releaseOriginPath, ...(continuation ? {CatalogContinuation: continuation.studioTree} : {}), ...(entryContinuation ? {PublicEntryContinuation: entryContinuation.studioTree} : {}), ...(catalogPreviewContinuation ? {CatalogPreviewContinuation: catalogPreviewContinuation.studioTree} : {}), sourceRevisionsSaved: 4, ...(shell ? {unchangedStudioAcceptanceReused: receipt.finishedAt, hostedReaderAcceptance: shell.finishedAt} : {})};
}
