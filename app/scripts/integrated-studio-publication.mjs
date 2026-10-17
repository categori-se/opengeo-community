import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPublicationBridge,processLocalBuildQueue} from '../../services/observable-coordinator/src/local-adapters.mjs';
import {PodmanRunner} from '../../services/observable-coordinator/src/podman-runner.mjs';

// One deliberately bounded real API/database/compiler/browser journey. Auth and
// object transport use the existing isolated runner's disclosed local adapters.
export async function exerciseNativePublication({page,browser,origin,organization,apiRequest,work,publicationProfile}) {
  const resuming=existsSync(join(work,'publication-progress.json'));
  const facts=resuming?JSON.parse(readFileSync(join(work,'publication-progress.json')))
    :{revisions:[],builds:[],publications:[],coordinatorAttempts:0,nativeCompilerInvocations:0,browserOutputReads:0};
  const historyOnly=resuming&&facts.revisions.length===2&&facts.builds.length===2&&facts.publications.length===2
    &&facts.nativeCompilerInvocations===2&&facts.coordinatorAttempts===2&&facts.browserOutputReads===2
    &&facts.builds.every(build=>build.outcome==='succeeded'&&build.resultChecksum)
    &&facts.publications.every(release=>release.outcome==='deployed'&&release.anonymousRead&&release.openedThroughPublishUi)
    &&facts.noCookieDenied&&facts.crossEditionCookieDenied&&!facts.historyResume;
  if(resuming&&!historyOnly)assert.ok(facts.revisions.length===1&&facts.builds.length===1&&facts.publications.length===0
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
    if(historyOnly){
      const status=await request(`/projects/${project.id}/source-projects/${source.id}/publications`);
      for(const release of facts.publications){
        const retained=status.reviews.find(review=>review.id===release.reviewId);
        assert.equal(retained?.deployment?.stage,'deployed');assert.equal(retained.build_job_id,release.buildJobId);
        assert.equal(retained.result_checksum_sha256,facts.builds.find(build=>build.id===release.buildJobId).resultChecksum);
      }
      facts.historyResume={reusedBuildIds:facts.builds.map(build=>build.id),reusedReviewIds:facts.publications.map(release=>release.reviewId)};
    }else facts.resume={reusedRevisionId:facts.revisions[0].id,reusedBuildId:facts.builds[0].id,priorPublicTransport:facts.publicTransport};
    checkpoint();
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
