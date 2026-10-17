import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPublicationBridge,processLocalBuildQueue} from '../../services/observable-coordinator/src/local-adapters.mjs';
import {PodmanRunner} from '../../services/observable-coordinator/src/podman-runner.mjs';
import {parseExchange} from '../../services/observable-preview/authorize/preview-shell.js';

const SECURITY_QUALIFICATION='Actual API/SQL capability expiry uses real elapsed time. Cookie expiry advances only the existing local delivery verifier clock with the unchanged issued signature. No production identity/CDN or real 15-minute waiting claim.';

// One deliberately bounded real API/database/compiler/browser journey. Auth and
// object transport use the existing isolated runner's disclosed local adapters.
export async function exerciseNativePublication({page,browser,origin,organization,apiRequest,work,publicationProfile,
  securityOnly=false,expirePreviewCookies,observePreviewExchange,securityPreviousRequests=[]}) {
  const resuming=existsSync(join(work,'publication-progress.json'));
  const facts=resuming?JSON.parse(readFileSync(join(work,'publication-progress.json')))
    :{revisions:[],builds:[],publications:[],coordinatorAttempts:0,nativeCompilerInvocations:0,browserOutputReads:0};
  const historyOnly=resuming&&facts.revisions.length===2&&facts.builds.length===2&&facts.publications.length===2
    &&facts.nativeCompilerInvocations===2&&facts.coordinatorAttempts===2&&facts.browserOutputReads===2
    &&facts.builds.every(build=>build.outcome==='succeeded'&&build.resultChecksum)
    &&facts.publications.every(release=>release.outcome==='deployed'&&release.anonymousRead&&release.openedThroughPublishUi)
    &&facts.noCookieDenied&&facts.crossEditionCookieDenied&&!facts.historyResume;
  if(securityOnly)validatePublicationSecurityResume(facts,securityPreviousRequests);
  if(resuming&&!historyOnly&&!securityOnly)assert.ok(facts.revisions.length===1&&facts.builds.length===1&&facts.publications.length===0
    &&facts.nativeCompilerInvocations===1&&facts.coordinatorAttempts===1&&facts.browserOutputReads===0
    &&facts.builds[0].outcome==='succeeded'&&facts.builds[0].resultChecksum&&!facts.resume,
    'Only the exact retained first successful compile before preview may resume; committed saves/builds are never replayed.');
  const checkpoint=()=>writeFileSync(join(work,'publication-progress.json'),JSON.stringify(facts,null,2)+'\n');
  const request=async(path,method='GET',data,expected=200)=>{
    const response=await apiRequest(path,{method,headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    assert.equal(response.status,expected,`${method} ${path}: ${response.body.toString().slice(0,1000)}`);
    return JSON.parse(response.body);
  };
  let project,source;
  if(resuming){
    project=await request(`/projects/${facts.projectId}`);
    const sources=await request(`/projects/${project.id}/source-projects`);
    source=sources.find(item=>item.id===facts.sourceProjectId);
    assert.equal(source?.current_revision_id,facts.revisions.at(-1).id);
    assert.equal(source.current_revision_number,facts.revisions.length);
    for(const [index,build] of facts.builds.entries()){
      const retained=await request(`/projects/${project.id}/observable-build-jobs/${build.id}`);
      assert.equal(retained.state,'succeeded');assert.equal(retained.source_revision_id,facts.revisions[index].id);
      assert.equal(retained.result_checksum_sha256,build.resultChecksum);
      assert.equal(retained.request.compilerImageDigest,publicationProfile.compilerImageDigest);
    }
    if(historyOnly||securityOnly){
      const status=await request(`/projects/${project.id}/source-projects/${source.id}/publications`);
      if(securityOnly)assert.equal(status.reviews.length,2);
      for(const release of facts.publications){
        const retained=status.reviews.find(review=>review.id===release.reviewId);
        assert.equal(retained?.deployment?.stage,'deployed');assert.equal(retained.build_job_id,release.buildJobId);
        assert.equal(retained.result_checksum_sha256,facts.builds.find(build=>build.id===release.buildJobId).resultChecksum);
      }
      if(historyOnly)facts.historyResume={reusedBuildIds:facts.builds.map(build=>build.id),reusedReviewIds:facts.publications.map(release=>release.reviewId)};
    }else facts.resume={reusedRevisionId:facts.revisions[0].id,reusedBuildId:facts.builds[0].id,priorPublicTransport:facts.publicTransport};
    if(!securityOnly)checkpoint();
  }else{
  project=await request('/projects','POST',{name:'Native publication acceptance'},201);facts.projectId=project.id;checkpoint();
  const home=await request(`/projects/${project.id}/resources`,'POST',{kind:'document',slug:'native-home',visibility:'restricted',
    metadata:{title:'Native publication',abstract:'Synthetic local acceptance source.',language:'en',keywords:[],profile:'opengeo.core.v1'},
    content:{blocks:[{id:'introduction',type:'markdown',markdown:'Private authored publication.'}]},provenance:{}},201);
  const site=await request(`/projects/${project.id}/sites`,'POST',{slug:'native-publication',title:'Native publication',theme:'minimal',
    pages:[{slug:'home',navigation_label:'Home',resource_id:home.id,resource_version:home.version_number,is_home:true}]},201);
  source=await request(`/projects/${project.id}/sites/${site.id}/source-project`,'POST',{title:'Native publication source'},201);
  facts.siteId=site.id;facts.sourceProjectId=source.id;checkpoint();
  }
  if(securityOnly){
    const revisions=await request(`/projects/${project.id}/source-projects/${source.id}/revisions`);
    validateSecurityRevisionPins(facts,revisions);
    return exercisePublicationSecurity({page,organization,apiRequest,work,publicationProfile,
      project,source,facts,checkpoint,expirePreviewCookies,observePreviewExchange,securityPreviousRequests});
  }
  const bridge=localPublicationBridge(JSON.parse(readFileSync(join(work,'local-api-container.json'))));
  if(!resuming)facts.destination=await bridge({operation:'configure-publication',projectId:project.id,sourceProjectId:source.id});checkpoint();
  assert.equal(facts.destination.canonicalOrigin,publicationProfile.publicationCanonicalOrigin);
  facts.publicTransport={canonicalOrigin:publicationProfile.publicationCanonicalOrigin,
    actualOrigin:publicationProfile.publicationOrigin,method:'Local canonical-host browser interception to anonymous loopback HTTP; no DNS, TLS or CloudFront acceptance.'};checkpoint();
  if(!historyOnly)assert.equal((await fetch(publicationProfile.publicationOrigin+'/')).status,404);
  const nativeRunner=new PodmanRunner();
  const runner={run:async options=>{assert.ok(facts.nativeCompilerInvocations<2,'Native compiler allowance exhausted');
    facts.nativeCompilerInvocations++;checkpoint();return nativeRunner.run(options);}};
  const preview=publicationProfile.previewOrigin;
  const input=readFileSync(new URL('../src/data/sample-public-facilities.geojson',import.meta.url));
  const facilities=JSON.parse(input).features;
  const publicCount=facilities.filter(feature=>feature.properties.public_access===true).length;
  assert.equal(facilities.length,5);assert.equal(publicCount,4);
  const inputSha256=createHash('sha256').update(input).digest('hex');
  facts.referenceInput={path:'sample-public-facilities.geojson',license:'CC0-1.0',sha256:inputSha256,records:5,publicAccess:4};
  const table=facilities.map(({properties:p})=>`| ${p.name} | ${p.category} | ${p.public_access} |`).join('\n');
  const workspace=`${origin}/workspaces?project=${project.id}&manage=publishing`;
  let firstEntry,firstCookie;
  for(let number=1;number<=(historyOnly?0:2);number++){
    const title=number===1?'First retained edition':'Second retained edition';
    const bytes=Buffer.from(`# ${title}\n\n## Community facilities\n\nFour of five fictional facilities have public_access=true. `+
      `Filter the boolean property strictly; these CC0-1.0 demonstration records make no claim about real facilities or geographic coverage.\n\n`+
      `| Facility | Category | Public access |\n| --- | --- | --- |\n${table}\n\n`+
      `## Retained input and method\n\nOriginal sample-public-facilities.geojson bytes are retained below. SHA-256: ${inputSha256}. `+
      `Method: count features whose properties.public_access equals true, then compare with all five features.\n\n`+
      `\`\`\`json\n${input.toString()}\`\`\`\n`);
    await page.goto(workspace);
    const card=page.locator('.observable-source-project:visible');await card.waitFor();
    let revision,job;
    if(resuming&&number===1){
      revision={id:facts.revisions[0].id};job={id:facts.builds[0].id};
      await card.getByLabel('Preview mode',{exact:true}).selectOption('saved');
    }else{
    await card.getByLabel('Source files',{exact:true}).and(card.locator('input[type="file"]'))
      .setInputFiles({name:'index.md',mimeType:'text/markdown',buffer:bytes});
    await card.getByLabel('Framework source editor',{exact:true}).waitFor({state:'attached'});
    await page.waitForFunction(value=>{
      const editor=document.querySelector('.observable-source-project textarea[aria-label="Framework source editor"]');
      return editor&&!editor.disabled&&editor.value===value;
    },bytes.toString());
    assert.equal(await card.getByLabel('Lockfile path (optional)',{exact:true}).inputValue(),'');
    await card.getByText('Draft settings and data references',{exact:true}).click();
    await card.getByLabel('Source publication rights',{exact:true}).selectOption('approved');
    const saved=page.waitForResponse(response=>response.url().endsWith(`/source-projects/${source.id}/revisions`)
      &&response.request().method()==='POST');
    await card.getByRole('button',{name:'Save draft',exact:true}).click();
    const savedResponse=await saved;assert.equal(savedResponse.status(),201);revision=await savedResponse.json();
    facts.revisions.push({id:revision.id,number:revision.revision_number,manifest:revision.manifest_checksum_sha256});checkpoint();
    await card.getByLabel('Preview mode',{exact:true}).selectOption('saved');
    const queued=page.waitForResponse(response=>response.url().endsWith(`/revisions/${revision.id}/build-jobs`)
      &&response.request().method()==='POST');
    await card.getByRole('button',{name:'Build saved revision',exact:true}).click();
    const queuedResponse=await queued;assert.equal(queuedResponse.status(),201);job=await queuedResponse.json();
    facts.builds.push({id:job.id,state:job.state});checkpoint();
    facts.coordinatorAttempts++;checkpoint();
    const outcomes=await processLocalBuildQueue({bridge,compilerImageDigest:publicationProfile.compilerImageDigest,maximumJobs:1,runner});
    facts.builds.at(-1).outcome=outcomes[0]?.status;checkpoint();
    assert.equal(outcomes[0]?.status,'succeeded',JSON.stringify(outcomes));
    const completed=await request(`/projects/${project.id}/observable-build-jobs/${job.id}`);
    assert.equal(completed.state,'succeeded');assert.equal(completed.source_revision_id,revision.id);
    facts.builds.at(-1).resultChecksum=completed.result_checksum_sha256;checkpoint();
    }
    await card.getByRole('button',{name:'Check saved preview',exact:true}).click();
    await card.getByRole('button',{name:'Show preview',exact:true}).click();
    const frame=page.frameLocator('iframe[title="Saved publication preview"]');
    await frame.getByRole('heading',{name:title,exact:true}).waitFor();
    await frame.getByText('Community Health Center',{exact:true}).waitFor();
    const entry=await frame.locator('html').evaluate(()=>location.href);
    assert.equal(new URL(entry).origin,preview);
    facts.browserOutputReads++;facts.builds.at(-1).entryPath=new URL(entry).pathname;checkpoint();
    await page.screenshot({path:join(work,`publication-edition-${number}.png`)});
    const cookies=await page.context().cookies(entry);assert.equal(cookies.length,3);
    if(number===1){firstEntry=entry;firstCookie=cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');}
    else {
      const denied=await fetch(entry,{headers:{cookie:firstCookie}});assert.equal(denied.status,403);
      facts.crossEditionCookieDenied=true;
    }
    const denied=await fetch(entry);assert.equal(denied.status,403);facts.noCookieDenied=true;checkpoint();
    await card.getByRole('tab',{name:'Publish',exact:true}).click();
    const publish=card.locator('.framework-publications:visible');
    await publish.getByLabel('Successful build to publish',{exact:true}).selectOption(job.id);
    await publish.getByLabel('Publication destination',{exact:true}).selectOption(facts.destination.mountId);
    const reviewed=page.waitForResponse(response=>response.url().endsWith(`/source-projects/${source.id}/publications/reviews`)
      &&response.request().method()==='POST');
    await publish.getByRole('button',{name:'Prepare publication review',exact:true}).click();
    const reviewedResponse=await reviewed;assert.equal(reviewedResponse.status(),200);
    const status=await reviewedResponse.json();
    const review=status.reviews.find(item=>item.build_job_id===job.id);
    assert.ok(review);facts.publications.push({reviewId:review.id,buildJobId:job.id,publisherSteps:0});checkpoint();
    const release=publish.locator('.publication-release-history > details').filter({hasText:`review ${review.id}`});
    await release.locator('input[name="approve-publication-output"]').check();
    const approved=page.waitForResponse(response=>response.url().endsWith(`/publications/reviews/${review.id}/approve`)
      &&response.request().method()==='POST');
    await release.getByRole('button',{name:'Approve and publish',exact:true}).click();
    assert.equal((await approved).status(),202);
    const message=await bridge({operation:'receive',queue:'framework-publications'});
    assert.ok(message);assert.deepEqual(JSON.parse(message.body),{schema:'opengeo.framework-publication.command.1.0.0',review_id:review.id});
    let deployment;
    // Canonical publisher chunks are at most 64 files; the canonical plan is
    // at most 2048. Continue only this approved review, never create a build.
    for(let step=0;step<33;step++){
      deployment=await bridge({operation:'publish',reviewId:review.id});
      facts.publications.at(-1).publisherSteps++;facts.publications.at(-1).outcome=deployment;checkpoint();
      if(deployment!=='retry')break;
    }
    assert.equal(deployment,'deployed');
    await bridge({operation:'acknowledge',queue:'framework-publications',id:message.id});
    await publish.getByRole('button',{name:'Reload publication reviews',exact:true}).click();
    const deployed=publish.locator('.publication-release-history > details').filter({hasText:`review ${review.id}`});
    await deployed.locator('summary').first().click();
    const publicPopup=page.waitForEvent('popup');
    await deployed.getByRole('link',{name:'Open published project',exact:true}).click();
    const published=await publicPopup;await published.getByRole('heading',{name:title,exact:true}).waitFor();
    await published.getByText('Community Health Center',{exact:true}).waitFor();
    assert.equal(new URL(published.url()).origin,publicationProfile.publicationCanonicalOrigin);
    assert.equal(await published.evaluate(()=>sessionStorage.getItem('opengeo.accessToken')),null);
    await published.close();
    const anonymous=await fetch(publicationProfile.publicationOrigin+'/');assert.equal(anonymous.status,200);
    assert.equal(anonymous.headers.get('x-opengeo-local-release'),`releases/framework-${review.id}`);
    assert.match(await anonymous.text(),new RegExp(title));
    facts.publications.at(-1).anonymousRead=true;facts.publications.at(-1).openedThroughPublishUi=true;checkpoint();
  }
  if(!historyOnly){
    const retained=await fetch(firstEntry,{headers:{cookie:firstCookie}});assert.equal(retained.status,200);
    assert.match(await retained.text(),/First retained edition/);facts.firstEditionStillReadable=true;checkpoint();
  }
  const revisions=await request(`/projects/${project.id}/source-projects/${source.id}/revisions`);assert.equal(revisions.length,2);
  if(historyOnly){await page.goto(workspace);await page.locator('.observable-source-project:visible').waitFor();}
  await page.locator('.observable-source-project:visible').getByRole('tab',{name:'Preview',exact:true}).click();
  // Preview deliberately opens the live draft. Select its saved-build surface
  // before opening durable history; this is normal UI state, not a hidden click.
  await page.locator('.observable-source-project:visible').getByLabel('Preview mode',{exact:true}).selectOption('saved');
  await page.locator('.framework-preview-workspace details > summary').filter({hasText:'Build history'}).click();
  const firstBuild=page.locator('.framework-build-history article').filter({hasText:facts.builds[0].id});
  const opened=page.waitForEvent('popup');
  await firstBuild.getByRole('button',{name:'Open private preview',exact:true}).click();
  const earlier=await opened;await earlier.getByRole('heading',{name:'First retained edition',exact:true}).waitFor();
  facts.earlierEditionReopenedThroughHistory=true;facts.firstEditionStillReadable=true;checkpoint();await earlier.close();
  const retainedPublic=await fetch(`${publicationProfile.publicationOrigin}/_editions/${facts.publications[0].reviewId}/`);
  assert.equal(retainedPublic.status,200);assert.match(await retainedPublic.text(),/First retained edition/);
  facts.earlierPublicEditionRetained=true;
  const currentPublic=await fetch(publicationProfile.publicationOrigin+'/');assert.equal(currentPublic.status,200);
  assert.match(await currentPublic.text(),/Second retained edition/);facts.currentPublicEditionStillActive=true;
  const objects=Object.values(JSON.parse(readFileSync(join(work,'objects.json'))));
  const outputs=objects.filter(record=>facts.builds.some(build=>record.key.includes(`/builds/${build.id}/output/`)));
  facts.outputBytes=outputs.reduce((total,record)=>total+record.size_bytes,0);assert.ok(facts.outputBytes<=50_000_000);
  facts.outputFiles=outputs.length;facts.immutableRevisionsReopened=true;checkpoint();
  return facts;
}

// Completed-state acceptance never replays authoring, compilation or publication.
// Kept pure so a malformed or partially completed receipt can be rejected offline.
export function validatePublicationSecurityResume(facts,previousRequests=[]) {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.ok(facts&&facts.revisions?.length===2&&facts.builds?.length===2&&facts.publications?.length===2);
  assert.equal(facts.nativeCompilerInvocations,2);assert.equal(facts.coordinatorAttempts,2);
  assert.equal(facts.browserOutputReads,2);
  for(const key of ['projectId','sourceProjectId'])assert.match(facts[key],uuid);
  assert.equal(new Set(facts.revisions.map(item=>item.id)).size,2);
  assert.equal(new Set(facts.builds.map(item=>item.id)).size,2);
  assert.equal(new Set(facts.publications.map(item=>item.reviewId)).size,2);
  for(const [index,revision] of facts.revisions.entries()){
    assert.match(revision.id,uuid);
    assert.equal(revision.number,index+1);assert.match(revision.manifest,/^[0-9a-f]{64}$/);
    const build=facts.builds[index],release=facts.publications[index];
    assert.match(build.id,uuid);assert.match(release.reviewId,uuid);
    assert.equal(build.outcome,'succeeded');assert.match(build.resultChecksum,/^[0-9a-f]{64}$/);
    assert.match(build.entryPath,new RegExp(`/source-projects/${facts.sourceProjectId}/builds/${build.id}/output/`));
    assert.equal(release.buildJobId,build.id);assert.equal(release.outcome,'deployed');
    assert.equal(release.anonymousRead,true);assert.equal(release.openedThroughPublishUi,true);
  }
  assert.deepEqual(facts.historyResume?.reusedBuildIds,facts.builds.map(item=>item.id));
  assert.deepEqual(facts.historyResume?.reusedReviewIds,facts.publications.map(item=>item.reviewId));
  for(const key of ['noCookieDenied','crossEditionCookieDenied','earlierEditionReopenedThroughHistory',
    'earlierPublicEditionRetained','currentPublicEditionStillActive','immutableRevisionsReopened'])assert.equal(facts[key],true);
  if(facts.previewSecurity===undefined){assert.deepEqual(previousRequests,[]);return;}
  // Exactly one legacy bootstrap failure may change its response-observation
  // method. Its immutable editions, complete attempt and twelve API receipts
  // remain retained; no later failure, invitation or grant may replay here.
  const failed=facts.previewSecurity;
  assert.deepEqual(Object.keys(failed).sort(),['status','startedAt','reusedBuildIds','reusedReviewIds',
    'noReplay','limits','qualification','cleanup','capabilityExpiresAt','failedStep','errorName'].sort());
  assert.equal(failed.status,'failed');assert.equal(failed.failedStep,'valid-bootstrap');
  assert.equal(failed.errorName,'Error');
  assert.deepEqual(failed.reusedBuildIds,facts.builds.map(item=>item.id));
  assert.deepEqual(failed.reusedReviewIds,facts.publications.map(item=>item.reviewId));
  assert.deepEqual(failed.noReplay,{sourceSaves:0,buildRequests:0,publicationReviews:0,publisherCalls:0});
  assert.deepEqual(failed.cleanup,{invitationId:null,projectMembershipRemoved:false,organizationMembershipRemoved:false});
  assert.deepEqual(failed.limits,{apiRequests:30,browserSeconds:75,totalSecondsIncludingCleanup:90,
    sourceSaves:0,nativeBuilds:0,publisherCalls:0,AWS:0});
  assert.equal(failed.qualification,SECURITY_QUALIFICATION);
  const lifetime=Date.parse(failed.capabilityExpiresAt)-Date.parse(failed.startedAt);
  assert.ok(Number.isFinite(lifetime)&&lifetime>50_000&&lifetime<=61_000);
  const project=`/projects/${facts.projectId}`,source=`${project}/source-projects/${facts.sourceProjectId}`;
  const capability=`${project}/observable-build-jobs/${facts.builds[0].id}/preview-capabilities`;
  const expected=[['GET',project,200],['GET',`${project}/source-projects`,200],
    ...facts.builds.map(build=>['GET',`${project}/observable-build-jobs/${build.id}`,200]),
    ['GET',`${source}/publications`,200],['GET',`${source}/revisions`,200],['POST',capability,201],
    ['GET','/organizations/current/memberships',200],['GET',`${project}/memberships`,200],
    ['GET','/organizations/current/invitations?limit=100',200],['POST',capability,201],
    ['POST','/observable-preview/exchange',200]];
  assert.deepEqual(previousRequests,expected.map(([method,path,status])=>({method,path,status,
    authenticated:path!=='/observable-preview/exchange',backend:'original'})),
    'Resume only the retained twelve-call bootstrap failure before any invitation or access change.');
}

// This observes the API result before the isolated helper sends it to Chromium.
// It retains no capability or cookie; browser delivery still needs its own proof.
export function observePublicationPreviewExchange(previous,path,options,result) {
  assert.ok(Number.isInteger(previous.sequence)&&previous.sequence>=0&&previous.sequence<10);
  assert.equal(path,'/observable-preview/exchange');assert.equal(options.method,'POST');
  const payload=JSON.parse(options.body);
  assert.deepEqual(Object.keys(payload),['capability']);
  assert.ok(typeof payload.capability==='string'&&/^[A-Za-z0-9_-]{128,512}$/.test(payload.capability),
    'Observe only the validated local preview capability payload.');
  assert.ok([200,401,403,404].includes(result.status),'An unavailable exchange must not masquerade as an authorization denial.');
  const observed={sequence:previous.sequence+1,method:options.method,path,status:result.status,
    capabilitySha256:createHash('sha256').update(payload.capability).digest('hex')};
  if(result.status===200){
    assert.ok(result.body.length<=4096);
    const parsed=parseExchange(JSON.parse(result.body));
    observed.grant=Object.freeze({entry_path:parsed.entryPath,expires_at:parsed.expiresAt,publication_authorized:false});
  }
  return Object.freeze(observed);
}

function validateSecurityRevisionPins(facts,revisions) {
  assert.equal(revisions.length,2);
  for(const revision of facts.revisions){
    const retained=revisions.find(item=>item.id===revision.id);
    assert.equal(retained?.source_project_id,facts.sourceProjectId);
    assert.equal(retained?.revision_number,revision.number);
    assert.equal(retained?.manifest_checksum_sha256,revision.manifest);
  }
}

async function exercisePublicationSecurity({page,organization,apiRequest,publicationProfile,
  project,source,facts,checkpoint,expirePreviewCookies,observePreviewExchange,securityPreviousRequests}) {
  assert.equal(typeof expirePreviewCookies,'function');
  assert.equal(typeof observePreviewExchange,'function');
  const reviewerId='20000000-0000-4000-8000-000000000002';
  const preview=publicationProfile.previewOrigin,context=page.context();
  const before={revisions:structuredClone(facts.revisions),builds:structuredClone(facts.builds),
    publications:structuredClone(facts.publications)};
  const previousAttempt=facts.previewSecurity;
  const result=facts.previewSecurity={status:'running',startedAt:new Date().toISOString(),
    method:'server-observed-exchange-v1',attempt:previousAttempt?2:1,
    ...(previousAttempt?{priorAttempts:[{...structuredClone(previousAttempt),requests:structuredClone(securityPreviousRequests)}]}:{}),
    reusedBuildIds:facts.builds.map(item=>item.id),reusedReviewIds:facts.publications.map(item=>item.reviewId),
    noReplay:{sourceSaves:0,buildRequests:0,publicationReviews:0,publisherCalls:0},
    limits:{apiRequests:30,priorApiRequests:securityPreviousRequests.length,cumulativeApiRequests:42,
      browserSeconds:75,totalSecondsIncludingCleanup:90,
      sourceSaves:0,nativeBuilds:0,publisherCalls:0,AWS:0},
    qualification:SECURITY_QUALIFICATION,
    cleanup:{invitationId:null,projectMembershipRemoved:false,organizationMembershipRemoved:false}};
  checkpoint();
  let step='membership-preflight',operation='preflight',invitation,acceptAttempted=false;
  let cleanupAttempted=false,cleanupCompleted=false;
  const request=async(path,{method='GET',body,actor='owner',expected=200,cleanup=false}={})=>{
    operation=cleanup?'fixture-reconciliation-request':'security-api-request';
    const response=await apiRequest(path,{method,cleanup,headers:{authorization:`Bearer synthetic-local-${actor}`,
      'x-opengeo-organization':organization,'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,expected,`Security acceptance ${method} ${path} returned ${response.status}; expected ${expected}.`);
    return response.body.length?JSON.parse(response.body):null;
  };
  const issue=async(build,actor='owner')=>{
    const capability=await request(`/projects/${project.id}/observable-build-jobs/${build.id}/preview-capabilities`,
      {method:'POST',body:{runtime_profile:'local_only'},actor,expected:201});
    const url=new URL(capability.authorize_url);
    assert.equal(url.origin,preview);assert.equal(url.pathname,'/authorize/');
    assert.match(url.hash,/^#cap=[A-Za-z0-9_-]{128,512}$/);
    const lifetime=Date.parse(capability.expires_at)-Date.now();
    assert.ok(lifetime>50_000&&lifetime<=60_500,'The real capability lifetime must remain 60 seconds.');
    return capability;
  };
  const authorize=async(capability,{allowed=false,build,title}={})=>{
    operation='clear-preview-cookies';
    await context.clearCookies();
    // A denied helper clears its fragment but remains at /authorize/. A new
    // fragment on that same document does not execute its module again.
    operation='bootstrap-fresh-document';
    await page.goto('about:blank',{waitUntil:'commit'});
    const prior=observePreviewExchange();
    const exchanged=page.waitForResponse(response=>response.url()===`${preview}/observable-preview/exchange`
      &&response.request().method()==='POST');
    operation='bootstrap-navigation';
    await page.goto(capability.authorize_url,{waitUntil:'commit'});
    operation='browser-exchange-status';
    const response=await exchanged;
    assert.equal(response.status(),allowed?200:403,'Preview bootstrap must enforce the capability outcome.');
    operation='server-exchange-metadata';
    const observed=observePreviewExchange();
    assert.equal(observed.sequence,prior.sequence+1,'Observe exactly this browser exchange.');
    assert.equal(observed.method,'POST');assert.equal(observed.path,'/observable-preview/exchange');
    const expectedHash=createHash('sha256').update(new URL(capability.authorize_url).hash.slice(5)).digest('hex');
    assert.ok(observed.capabilitySha256===expectedHash,'Server exchange must match this capability.');
    assert.ok(JSON.parse(response.request().postData()).capability===new URL(capability.authorize_url).hash.slice(5),
      'Browser exchange must send this capability.');
    assert.equal(observed.status===200,allowed,'Server exchange must enforce the same outcome.');
    if(!allowed){
      operation='denied-bootstrap-content';
      await page.getByText('This private preview link is invalid, expired, or already used.',{exact:true}).waitFor();
      assert.equal(new URL(page.url()).hash,'');
      assert.deepEqual(await context.cookies(),[],'A denied capability must not receive cookies.');
      return null;
    }
    const grant=observed.grant;assert.equal(grant.publication_authorized,false);
    assert.equal(grant.entry_path,build.entryPath);
    operation='preview-output-content';
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
    assert.equal(page.url(),`${preview}${build.entryPath}`);
    operation='issued-preview-cookies';
    const cookies=await context.cookies(page.url());
    assert.deepEqual(cookies.map(cookie=>cookie.name).sort(),
      ['CloudFront-Key-Pair-Id','CloudFront-Policy','CloudFront-Signature']);
    const prefix=build.entryPath.slice(0,build.entryPath.indexOf('/output/')+8);
    assert.ok(cookies.every(cookie=>cookie.httpOnly&&cookie.sameSite==='Strict'&&cookie.path===prefix));
    const lifetime=Date.parse(grant.expires_at)-Date.now();
    assert.ok(lifetime>880_000&&lifetime<=900_500,'Issued signed-cookie lifetime must remain 15 minutes.');
    return {grant,cookies};
  };
  const reconcileFixture=async()=>{
    if(cleanupAttempted){
      assert.ok(cleanupCompleted,'Do not repeat ambiguous fixture cleanup; reconcile its retained receipt.');
      return;
    }
    if(!invitation)return;
    cleanupAttempted=true;
    if(acceptAttempted){
      // An accept response may fail after the transaction commits. Reconcile
      // actual memberships even if no successful response was observed.
      const projectMembers=await request(`/projects/${project.id}/memberships`,{cleanup:true});
      const organizationMembers=await request('/organizations/current/memberships',{cleanup:true});
      const projectMember=projectMembers.find(member=>member.user_id===reviewerId);
      const organizationMember=organizationMembers.find(member=>member.user_id===reviewerId);
      assert.ok(!projectMember||projectMember.role==='viewer');
      assert.ok(!organizationMember||organizationMember.role==='guest');
      if(projectMember){
        await request(`/projects/${project.id}/memberships/${reviewerId}`,{method:'DELETE',expected:204,cleanup:true});
      }
      result.cleanup.projectMembershipRemoved=true;
      if(organizationMember){
        await request(`/organizations/current/memberships/${reviewerId}`,{method:'DELETE',expected:204,cleanup:true});
      }
      result.cleanup.organizationMembershipRemoved=true;
      result.cleanup.membershipsReconciled=true;checkpoint();
      if(projectMember||organizationMember){cleanupCompleted=true;return;}
    }
    const revoked=await request(`/organizations/current/invitations/${invitation.id}`,{method:'DELETE',cleanup:true});
    assert.equal(revoked.status,'revoked');result.cleanup.pendingInvitationRevoked=true;
    cleanupCompleted=true;checkpoint();
  };
  try{
    step='capability-issue';
    const expiring=await issue(facts.builds[0]);
    result.capabilityExpiresAt=expiring.expires_at;checkpoint();
    step='membership-preflight';
    const members=await request('/organizations/current/memberships');
    assert.ok(!members.some(member=>member.user_id===reviewerId),'Never change a pre-existing reviewer membership.');
    const projectMembers=await request(`/projects/${project.id}/memberships`);
    assert.ok(!projectMembers.some(member=>member.user_id===reviewerId),'Never change a pre-existing reviewer project grant.');
    const invitations=await request('/organizations/current/invitations?limit=100');
    assert.ok(!invitations.some(item=>item.email==='reviewer@local.invalid'&&item.status==='pending'),
      'Never supersede a pre-existing reviewer invitation.');
    const replay=await issue(facts.builds[0]);
    step='valid-bootstrap';
    await authorize(replay,{allowed:true,build:facts.builds[0],title:'First retained edition'});
    result.actualSignedPreviewOpened=true;checkpoint();
    step='capability-replay';await authorize(replay);
    result.capabilityReplayDenied=true;checkpoint();
    step='viewer-invitation';
    invitation=await request('/organizations/current/invitations',{method:'POST',expected:201,body:{
      email:'reviewer@local.invalid',display_name:'Local reviewer',organization_role:'guest',
      project_id:project.id,project_role:'viewer',expires_in_days:1}});
    result.cleanup.invitationId=invitation.id;checkpoint();
    acceptAttempted=true;result.invitationAcceptanceAttempted=true;checkpoint();
    const acceptance=await request(`/auth/invitations/${invitation.id}/accept`,{method:'POST',actor:'reviewer'});
    assert.equal(acceptance.organization_id,organization);assert.equal(acceptance.project_id,project.id);
    assert.equal(acceptance.organization_role,'guest');assert.equal(acceptance.project_role,'viewer');
    result.viewerInvitationAccepted=true;checkpoint();
    const viewerPreview=await issue(facts.builds[1],'reviewer');
    const revoked=await issue(facts.builds[1],'reviewer');
    step='viewer-bootstrap';
    const issued=await authorize(viewerPreview,{allowed:true,build:facts.builds[1],title:'Second retained edition'});
    result.issuedCookieExpiresAt=issued.grant.expires_at;checkpoint();
    step='effective-access-revocation';
    await request(`/projects/${project.id}/memberships/${reviewerId}`,{method:'DELETE',expected:204});
    result.cleanup.projectMembershipRemoved=true;checkpoint();
    await request(`/projects/${project.id}/observable-build-jobs/${facts.builds[1].id}/preview-capabilities`,
      {method:'POST',body:{runtime_profile:'local_only'},actor:'reviewer',expected:403});
    result.newGrantAfterRevocationDenied=true;checkpoint();
    await authorize(revoked);result.unconsumedCapabilityAfterRevocationDenied=true;checkpoint();
    await context.addCookies(issued.cookies);
    const retained=await page.goto(`${preview}${facts.builds[1].entryPath}`,{waitUntil:'domcontentloaded'});
    assert.equal(retained.status(),200);await page.getByRole('heading',{name:'Second retained edition',exact:true}).waitFor();
    result.issuedCookieRemainsValidAfterMembershipRevocation=true;checkpoint();
    await reconcileFixture();
    step='real-capability-expiry';
    const remaining=Date.parse(expiring.expires_at)-Date.now()+150;
    assert.ok(remaining<=60_500);
    if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
    assert.ok(Date.now()>Date.parse(expiring.expires_at));
    await authorize(expiring);result.realElapsedCapabilityExpiryDenied=true;checkpoint();
    step='controlled-clock-cookie-expiry';
    await context.addCookies(issued.cookies);
    const sent=page.waitForRequest(request=>request.url()===`${preview}${facts.builds[1].entryPath}`);
    result.deliveryClock=expirePreviewCookies(issued.grant.expires_at);
    const expired=await page.goto(`${preview}${facts.builds[1].entryPath}`,{waitUntil:'domcontentloaded'});
    const headers=await (await sent).allHeaders();
    assert.ok(issued.cookies.every(cookie=>headers.cookie?.includes(`${cookie.name}=${cookie.value}`)),
      'Expiry must reject the unchanged issued cookies, not a browser request without cookies.');
    assert.equal(expired.status(),403);
    result.controlledClockSignedCookieExpiryDenied=true;checkpoint();
    step='retained-state-readback';
    validateSecurityRevisionPins(facts,await request(`/projects/${project.id}/source-projects/${source.id}/revisions`));
    const status=await request(`/projects/${project.id}/source-projects/${source.id}/publications`);
    assert.equal(status.reviews.length,2);
    for(const release of facts.publications){
      const retained=status.reviews.find(item=>item.id===release.reviewId);
      assert.equal(retained?.deployment?.stage,'deployed');assert.equal(retained.build_job_id,release.buildJobId);
      assert.equal(retained.result_checksum_sha256,facts.builds.find(item=>item.id===release.buildJobId).resultChecksum);
    }
    for(const key of ['revisions','builds','publications'])assert.deepEqual(facts[key],before[key]);
    result.status='pass';result.finishedAt=new Date().toISOString();checkpoint();
    return facts;
  }catch(error){
    result.status='failed';result.failedStep=step;result.failedOperation=operation;result.errorName=error.name;checkpoint();
    throw new Error(`Publication security acceptance failed during ${step}; inspect its private progress receipt.`);
  }finally{
    try{
      await reconcileFixture();
    }catch(error){
      result.status='cleanup-unproved';result.cleanup.errorName=error.name;result.cleanup.errorOperation=operation;checkpoint();
      throw new Error('Publication security fixture cleanup is unproved; reconcile the recorded invitation before another run.');
    }
  }
}
