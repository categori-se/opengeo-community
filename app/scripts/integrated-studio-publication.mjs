import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {localPublicationBridge,processLocalBuildQueue} from '../../services/observable-coordinator/src/local-adapters.mjs';
import {PodmanRunner} from '../../services/observable-coordinator/src/podman-runner.mjs';

// One deliberately bounded real API/database/compiler/browser journey. Auth and
// object transport use the existing isolated runner's disclosed local adapters.
export async function exerciseNativePublication({page,browser,origin,organization,apiRequest,work,publicationProfile}) {
  const facts={revisions:[],builds:[],coordinatorAttempts:0,nativeCompilerInvocations:0,browserOutputReads:0};
  const checkpoint=()=>writeFileSync(join(work,'publication-progress.json'),JSON.stringify(facts,null,2)+'\n');
  const request=async(path,method='GET',data,expected=200)=>{
    const response=await apiRequest(path,{method,headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    assert.equal(response.status,expected,`${method} ${path}: ${response.body.toString().slice(0,1000)}`);
    return JSON.parse(response.body);
  };
  const project=await request('/projects','POST',{name:'Native publication acceptance'},201);facts.projectId=project.id;checkpoint();
  const home=await request(`/projects/${project.id}/resources`,'POST',{kind:'document',slug:'native-home',visibility:'restricted',
    metadata:{title:'Native publication',abstract:'Synthetic local acceptance source.',language:'en',keywords:[],profile:'opengeo.core.v1'},
    content:{blocks:[{id:'introduction',type:'markdown',markdown:'Private authored publication.'}]},provenance:{}},201);
  const site=await request(`/projects/${project.id}/sites`,'POST',{slug:'native-publication',title:'Native publication',theme:'minimal',
    pages:[{slug:'home',navigation_label:'Home',resource_id:home.id,resource_version:home.version_number,is_home:true}]},201);
  const source=await request(`/projects/${project.id}/sites/${site.id}/source-project`,'POST',{title:'Native publication source'},201);
  facts.siteId=site.id;facts.sourceProjectId=source.id;checkpoint();
  const bridge=localPublicationBridge(JSON.parse(readFileSync(join(work,'local-api-container.json'))));
  const nativeRunner=new PodmanRunner();
  const runner={run:async options=>{facts.nativeCompilerInvocations++;checkpoint();return nativeRunner.run(options);}};
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
  for(let number=1;number<=2;number++){
    const title=number===1?'First retained edition':'Second retained edition';
    const bytes=Buffer.from(`# ${title}\n\n## Community facilities\n\nFour of five fictional facilities have public_access=true. `+
      `Filter the boolean property strictly; these CC0-1.0 demonstration records make no claim about real facilities or geographic coverage.\n\n`+
      `| Facility | Category | Public access |\n| --- | --- | --- |\n${table}\n\n`+
      `## Retained input and method\n\nOriginal sample-public-facilities.geojson bytes are retained below. SHA-256: ${inputSha256}. `+
      `Method: count features whose properties.public_access equals true, then compare with all five features.\n\n`+
      `\`\`\`json\n${input.toString()}\`\`\`\n`);
    await page.goto(workspace);
    const card=page.locator('.observable-source-project:visible');await card.waitFor();
    await card.getByLabel('Source files',{exact:true}).and(card.locator('input[type="file"]'))
      .setInputFiles({name:'index.md',mimeType:'text/markdown',buffer:bytes});
    await card.getByLabel('Framework source editor',{exact:true}).waitFor({state:'attached'});
    await page.waitForFunction(value=>{
      const editor=document.querySelector('.observable-source-project textarea[aria-label="Framework source editor"]');
      return editor&&!editor.disabled&&editor.value===value;
    },bytes.toString());
    assert.equal(await card.getByLabel('Lockfile path (optional)',{exact:true}).inputValue(),'');
    const saved=page.waitForResponse(response=>response.url().endsWith(`/source-projects/${source.id}/revisions`)
      &&response.request().method()==='POST');
    await card.getByRole('button',{name:'Save draft',exact:true}).click();
    const savedResponse=await saved;assert.equal(savedResponse.status(),201);const revision=await savedResponse.json();
    facts.revisions.push({id:revision.id,number:revision.revision_number,manifest:revision.manifest_checksum_sha256});checkpoint();
    await card.getByLabel('Preview mode',{exact:true}).selectOption('saved');
    const queued=page.waitForResponse(response=>response.url().endsWith(`/revisions/${revision.id}/build-jobs`)
      &&response.request().method()==='POST');
    await card.getByRole('button',{name:'Build saved revision',exact:true}).click();
    const queuedResponse=await queued;assert.equal(queuedResponse.status(),201);const job=await queuedResponse.json();
    facts.builds.push({id:job.id,state:job.state});checkpoint();
    facts.coordinatorAttempts++;checkpoint();
    const outcomes=await processLocalBuildQueue({bridge,compilerImageDigest:publicationProfile.compilerImageDigest,maximumJobs:1,runner});
    facts.builds.at(-1).outcome=outcomes[0]?.status;checkpoint();
    assert.equal(outcomes[0]?.status,'succeeded',JSON.stringify(outcomes));
    const completed=await request(`/projects/${project.id}/observable-build-jobs/${job.id}`);
    assert.equal(completed.state,'succeeded');assert.equal(completed.source_revision_id,revision.id);
    facts.builds.at(-1).resultChecksum=completed.result_checksum_sha256;checkpoint();
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
  }
  const retained=await fetch(firstEntry,{headers:{cookie:firstCookie}});assert.equal(retained.status,200);
  assert.match(await retained.text(),/First retained edition/);facts.firstEditionStillReadable=true;
  const revisions=await request(`/projects/${project.id}/source-projects/${source.id}/revisions`);assert.equal(revisions.length,2);
  await page.locator('.framework-preview-workspace details > summary').filter({hasText:'Build history'}).click();
  const firstBuild=page.locator('.framework-build-history article').filter({hasText:facts.builds[0].id});
  const opened=page.waitForEvent('popup');
  await firstBuild.getByRole('button',{name:'Open private preview',exact:true}).click();
  const earlier=await opened;await earlier.getByRole('heading',{name:'First retained edition',exact:true}).waitFor();
  facts.earlierEditionReopenedThroughHistory=true;await earlier.close();
  const objects=Object.values(JSON.parse(readFileSync(join(work,'objects.json'))));
  const outputs=objects.filter(record=>facts.builds.some(build=>record.key.includes(`/builds/${build.id}/output/`)));
  facts.outputBytes=outputs.reduce((total,record)=>total+record.size_bytes,0);assert.ok(facts.outputBytes<=50_000_000);
  facts.outputFiles=outputs.length;facts.immutableRevisionsReopened=true;checkpoint();
  return facts;
}
