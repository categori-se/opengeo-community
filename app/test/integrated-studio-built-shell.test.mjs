import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runInNewContext} from "node:vm";
import {integratedStudioShellMode, loadIntegratedStudioBuild, integratedStudioAuthConfig,
  initializeIntegratedStudioSession} from "../scripts/integrated-studio-built-shell.mjs";
import {parseAuthConfig} from "../src/lib/authConfig.js";
import {getAccessToken} from "../src/lib/auth.js";
import {canonicalStudioRoutes} from "../scripts/application-route-inventory.mjs";
import {snapshotTree, sealManifest, writeJson} from "../scripts/release-utils.mjs";
import {createHash} from "node:crypto";
import {validatePublicationSecurityResume,loadPublicationSecurityReconciliation} from "../scripts/integrated-studio-publication.mjs";

test("built shell and pinned labels are independent explicit modes", () => {
  assert.deepEqual(integratedStudioShellMode([]), {built:false, pinnedFonts:false, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--built-studio"]), {built:true, pinnedFonts:false, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--pinned-map-fonts", "--built-studio"]), {built:true, pinnedFonts:true, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--built-studio", "--restore-checkpoint"]), {built:true, pinnedFonts:false, restore:true});
  assert.equal(integratedStudioShellMode(["--built-studio", "--service-clients"]).serviceClients,true);
  assert.equal(integratedStudioShellMode(["--built-studio", "--wcs-only"]).wcsOnly,true);
  assert.equal(integratedStudioShellMode(["--built-studio", "--development"]).development,true);
  assert.throws(()=>integratedStudioShellMode(["--development"]));
  assert.throws(()=>integratedStudioShellMode(["--built-studio","--development","--service-clients"]));
  assert.throws(()=>integratedStudioShellMode(["--built-studio","--wcs-only","--service-clients"]));
  for (const args of [["--service-clients"], ["--restore-checkpoint"], ["--built-studio", "--built-studio"], ["--deploy"], ["anything"]]) {
    assert.throws(() => integratedStudioShellMode(args));
  }
});

test("local auth configuration uses the normal parser and cannot target a remote site", () => {
  const origin = "http://127.0.0.1:12345";
  const config = parseAuthConfig(integratedStudioAuthConfig(origin), {currentOrigin:origin});
  assert.equal(config.deployment.mode, "managed");
  assert.equal(config.redirectUri, `${origin}/login`);
  for (const unsafe of ["https://studio.opengeo.tools", "http://localhost:12345", `${origin}/path`, "http://user@127.0.0.1:12345"]) {
    assert.throws(() => integratedStudioAuthConfig(unsafe));
  }
});

test("synthetic session initialization preserves normal organization selection and sign out on reload", () => {
  const values = new Map();
  const sessionStorage = {getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, value), removeItem:key => values.delete(key)};
  const initialize = options => runInNewContext(`(${initializeIntegratedStudioSession})(${JSON.stringify(options)})`, {sessionStorage});
  initialize({organization:"owner-organization"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.owner");
  values.set("opengeo.organizationId", "deliberately-selected-organization");
  initialize({organization:"owner-organization"});
  assert.equal(values.get("opengeo.organizationId"), "deliberately-selected-organization");
  values.delete("opengeo.accessToken");
  initialize({organization:"owner-organization"});
  assert.equal(values.has("opengeo.accessToken"), false);
  initialize({organization:"owner-organization", actor:"reviewer"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.reviewer");
  assert.equal(values.has("opengeo.organizationId"), false);
  initialize({organization:"owner-organization"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.reviewer");
});

test("synthetic sign-in never reads storage in isolated publication frames", () => {
  const frame = {top:{}};
  let reads = 0;
  const sandbox = {window:frame};
  Object.defineProperty(sandbox, "sessionStorage", {get() { reads++; throw new Error("Opaque origin"); }});
  runInNewContext(`(${initializeIntegratedStudioSession})({organization:'owner'})`, sandbox);
  assert.equal(reads, 0);
});

test("built transport requires exact sealed bytes and canonical routes, without page fallbacks", async () => {
  const work = await mkdtemp(join(tmpdir(), "opengeo-built-shell-test-"));
  try {
    const root = join(work, "built-studio/app/dist");
    await mkdir(root, {recursive:true});
    for (const [route, filename] of canonicalStudioRoutes) {
      await writeFile(join(root, filename), `<!doctype html><title>${route}</title>`);
    }
    const tree = await snapshotTree(root);
    const routes = canonicalStudioRoutes.map(([path, htmlPath]) => ({path, htmlPath,
      sha256:tree.files.find(file => file.path === htmlPath).sha256}));
    const manifestPath = join(work, "built-studio/dist/opengeo-studio-build.json");
    await writeJson(manifestPath, sealManifest({schemaVersion:"opengeo.studio-build.1.0.0", artifactTree:tree, routes}));
    const build = await loadIntegratedStudioBuild(work);
    assert.equal(build.files.get("/workspaces"), build.files.get("/workspaces.html"));
    assert.equal(build.files.get("/"), build.files.get("/index.html"));
    assert.equal(build.files.get("/missing"), undefined);
    assert.equal(build.files.get("/../studio-build.log"), undefined);
    assert.equal(build.files.get("/auth-config.json"), undefined);
    assert.equal(build.files.get("/workspaces").body.toString(), "<!doctype html><title>/workspaces</title>");
    await writeFile(join(root, "workspaces.html"), "replacement");
    await assert.rejects(loadIntegratedStudioBuild(work), /sealed artifact tree/);
    await writeJson(manifestPath, sealManifest({schemaVersion:"opengeo.studio-build.1.0.0", artifactTree:tree, routes:routes.slice(1)}));
    await assert.rejects(loadIntegratedStudioBuild(work));
  } finally {
    await rm(work, {recursive:true, force:true});
  }
});

function retainedSecurityFixture() {
  const id=number=>`30000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
  const projectId=id(1),sourceProjectId=id(2),invitationId=id(7);
  const facts={projectId,sourceProjectId,nativeCompilerInvocations:2,coordinatorAttempts:2,browserOutputReads:2,
    revisions:[1,2].map(number=>({id:id(number+2),number,manifest:String(number).repeat(64)})),
    builds:[1,2].map(number=>({id:id(number+4),outcome:'succeeded',resultChecksum:String(number+2).repeat(64),
      entryPath:`/organizations/${id(9)}/projects/${projectId}/source-projects/${sourceProjectId}/builds/${id(number+4)}/output/index.html`})),
    publications:[1,2].map(number=>({reviewId:id(number+7),buildJobId:id(number+4),outcome:'deployed',
      anonymousRead:true,openedThroughPublishUi:true}))};
  facts.historyResume={reusedBuildIds:facts.builds.map(build=>build.id),reusedReviewIds:facts.publications.map(release=>release.reviewId)};
  for(const key of ['noCookieDenied','crossEditionCookieDenied','earlierEditionReopenedThroughHistory',
    'earlierPublicEditionRetained','currentPublicEditionStillActive','immutableRevisionsReopened'])facts[key]=true;
  const qualification='Actual API/SQL capability expiry uses real elapsed time. Cookie expiry advances only the existing local delivery verifier clock with the unchanged issued signature. No production identity/CDN or real 15-minute waiting claim.';
  const first={status:'failed',startedAt:'2026-10-17T15:20:47.408Z',...structuredClone(facts.historyResume),
    noReplay:{sourceSaves:0,buildRequests:0,publicationReviews:0,publisherCalls:0},
    limits:{apiRequests:30,browserSeconds:75,totalSecondsIncludingCleanup:90,sourceSaves:0,nativeBuilds:0,publisherCalls:0,AWS:0},
    qualification,cleanup:{invitationId:null,projectMembershipRemoved:false,organizationMembershipRemoved:false},
    capabilityExpiresAt:'2026-10-17T15:21:47.408Z',failedStep:'valid-bootstrap',errorName:'Error'};
  const project=`/projects/${projectId}`,source=`${project}/source-projects/${sourceProjectId}`;
  const capability=number=>`${project}/observable-build-jobs/${facts.builds[number].id}/preview-capabilities`;
  const rows=[['GET',project,200],['GET',`${project}/source-projects`,200],
    ...facts.builds.map(build=>['GET',`${project}/observable-build-jobs/${build.id}`,200]),
    ['GET',`${source}/publications`,200],['GET',`${source}/revisions`,200],['POST',capability(0),201],
    ['GET','/organizations/current/memberships',200],['GET',`${project}/memberships`,200],
    ['GET','/organizations/current/invitations?limit=100',200],['POST',capability(0),201],['POST','/observable-preview/exchange',200]];
  const requests=rows=>rows.map(([method,path,status])=>({method,path,status,authenticated:path!=='/observable-preview/exchange',backend:'original'}));
  const firstRequests=requests(rows);
  facts.previewSecurity={...structuredClone(first),status:'cleanup-unproved',startedAt:'2026-10-17T15:31:51.639Z',
    method:'server-observed-exchange-v1',attempt:2,priorAttempts:[{...structuredClone(first),requests:firstRequests}],
    limits:{...first.limits,priorApiRequests:12,cumulativeApiRequests:42},
    cleanup:{invitationId,projectMembershipRemoved:true,organizationMembershipRemoved:false,
      errorName:'AssertionError',errorOperation:'fixture-reconciliation-request'},
    capabilityExpiresAt:'2026-10-17T15:32:51.692Z',actualSignedPreviewOpened:true,capabilityReplayDenied:true,
    invitationAcceptanceAttempted:true,viewerInvitationAccepted:true,failedStep:'viewer-bootstrap',
    failedOperation:'browser-exchange-status',errorName:'TimeoutError'};
  const reviewer='20000000-0000-4000-8000-000000000002';
  const previousRequests=requests([...rows,['POST','/observable-preview/exchange',404],
    ['POST','/organizations/current/invitations',201],['POST',`/auth/invitations/${invitationId}/accept`,200],
    ['POST',capability(1),201],['POST',capability(1),201],['GET',`${project}/memberships`,200],
    ['GET','/organizations/current/memberships',200],['DELETE',`${project}/memberships/${reviewer}`,204],
    ['DELETE',`/organizations/current/memberships/${reviewer}`,409]]);
  const migrationSha256='8dd1de5eb8f8b3a5a5d5e3458a695852618bfe5734381cb0b1f19f37baa70262';
  const stopped={database:'exited',APIAbsent:true,workerAbsent:true,volumePreserved:true};
  const failedRun={status:'failure',returncode:1,priorAttempt:'publication-security-run-result.json',
    AWS:0,newCompilerRuns:0,newSourceSaves:0,newPublications:0,cleanup:stopped,endedAt:'2026-10-17T15:32:12.219Z',security:{}};
  for(const key of ['status','failedStep','failedOperation','actualSignedPreviewOpened','capabilityReplayDenied',
    'viewerInvitationAccepted','cleanup'])failedRun.security[key]=structuredClone(facts.previewSecurity[key]);
  for(const key of ['newGrantAfterRevocationDenied','unconsumedCapabilityAfterRevocationDenied',
    'issuedCookieRemainsValidAfterMembershipRevocation','realElapsedCapabilityExpiryDenied',
    'controlledClockSignedCookieExpiryDenied'])failedRun.security[key]=null;
  const cleanup={status:'pass',transaction:'committed',migration:'database/migrations/0176_observable_preview_membership_history.sql',
    migrationSha256,AWS:0,APIContainers:0,nativeBuilds:0,sourceSaves:0,publicationWrites:0,
    guestMembershipAbsent:true,targetProjectMembershipAbsent:true,acceptedInvitationUnchanged:true,
    allProjectMembershipsUnchanged:true,ownerAdminUnchanged:true,reviewedLocalSchemaMarkerUpdated:true,
    capabilityAuditRowsPreserved:2,cleanup:stopped,startedAt:'2026-10-17T15:36:50.305Z',endedAt:'2026-10-17T15:36:52.287Z'};
  const evidence={cleanup,failedRun,migrationSha256,schemaMigrationSha256:migrationSha256,
    cleanupReceiptSha256:'a'.repeat(64),failedRunReceiptSha256:'b'.repeat(64)};
  return {facts,previousRequests,evidence,first,firstRequests};
}

test('retained publication security resumes only its exact reconciled second failure',()=>{
  const {facts,previousRequests,evidence,first,firstRequests}=retainedSecurityFixture();
  const before=structuredClone({facts,previousRequests,evidence});
  assert.equal(validatePublicationSecurityResume({...facts,previewSecurity:first},firstRequests),undefined,
    'The original first-failure resume remains available.');
  assert.throws(()=>validatePublicationSecurityResume(facts,previousRequests),'A third attempt requires pinned cleanup evidence.');
  const resume=validatePublicationSecurityResume(facts,previousRequests,evidence);
  assert.deepEqual(resume,{attempt:3,priorApiRequests:33,cumulativeApiRequests:63,totalSecondsIncludingCleanup:110,
    previousInvitationId:facts.previewSecurity.cleanup.invitationId,
    cleanupReceiptSha256:'a'.repeat(64),failedRunReceiptSha256:'b'.repeat(64)});
  assert.deepEqual({facts,previousRequests,evidence},before,'Validation never rewrites failed receipts or immutable editions.');
  const changes=[
    state=>state.facts.previewSecurity.status='failed',
    state=>state.facts.previewSecurity.failedStep='real-capability-expiry',
    state=>state.facts.previewSecurity.failedOperation='preview-output-content',
    state=>state.facts.previewSecurity.attempt=3,
    state=>state.facts.previewSecurity.actualSignedPreviewOpened=false,
    state=>state.facts.previewSecurity.capabilityReplayDenied=false,
    state=>state.facts.previewSecurity.viewerInvitationAccepted=false,
    state=>state.facts.previewSecurity.priorAttempts[0].requests.pop(),
    state=>state.previousRequests[12].status=200,
    state=>state.previousRequests.push({...state.previousRequests[0]}),
    state=>state.previousRequests.reverse(),
    state=>state.facts.builds[0].resultChecksum='altered',
    state=>state.facts.publications[0].buildJobId=state.facts.builds[1].id,
    state=>state.evidence.failedRun.security.cleanup.invitationId='30000000-0000-4000-8000-000000000099',
    state=>state.evidence.failedRun.security.realElapsedCapabilityExpiryDenied=true,
    state=>state.evidence.cleanup.guestMembershipAbsent=false,
    state=>state.evidence.cleanup.capabilityAuditRowsPreserved=1,
    state=>state.evidence.cleanup.acceptedInvitationUnchanged=false,
    state=>state.evidence.cleanup.allProjectMembershipsUnchanged=false,
    state=>state.evidence.cleanup.ownerAdminUnchanged=false,
    state=>state.evidence.cleanup.migrationSha256='0'.repeat(64),
    state=>state.evidence.schemaMigrationSha256='0'.repeat(64),
    state=>state.evidence.cleanup.startedAt='2026-10-17T15:00:00Z'
  ];
  for(const change of changes){
    const state=structuredClone(before);change(state);
    assert.throws(()=>validatePublicationSecurityResume(state.facts,state.previousRequests,state.evidence),String(change));
  }
});

test('retained publication cleanup loading requires both original receipt bytes and migration marker',async()=>{
  const work=await mkdtemp(join(tmpdir(),'opengeo-publication-security-'));
  try{
    const {evidence}=retainedSecurityFixture();
    const cleanup=JSON.stringify(evidence.cleanup),failed=JSON.stringify(evidence.failedRun);
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(work,'publication-security-fixture-cleanup.json'),cleanup);
    await writeFile(join(work,'publication-security-corrected-run-result.json'),failed);
    await writeFile(join(work,'development-state.json'),JSON.stringify({schemaSources:{
      [evidence.cleanup.migration]:evidence.migrationSha256}}));
    const pin=`${sha(cleanup)}:${sha(failed)}`;
    assert.equal(loadPublicationSecurityReconciliation(work,pin).schemaMigrationSha256,evidence.migrationSha256);
    assert.throws(()=>loadPublicationSecurityReconciliation(work,'1'));
    await writeFile(join(work,'publication-security-fixture-cleanup.json'),cleanup+' ');
    assert.throws(()=>loadPublicationSecurityReconciliation(work,pin),/receipt bytes changed/);
  }finally{await rm(work,{recursive:true,force:true});}
});
