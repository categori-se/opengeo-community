import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=resolve(new URL('../..',import.meta.url).pathname);
const output='/home/aaron/framework/opengeo.tools/dist';
const studio='https://studio.opengeo.tools', preview='https://preview.studio.opengeo.tools';
async function policy(path,name) {
  const source=await readFile(resolve(root,path),'utf8');
  const body=source.slice(source.indexOf(`export const ${name} = [`)).split('].join')[0];
  assert(body.startsWith(`export const ${name} = [`));
  return [...body.matchAll(/"([^"]+)"/g)].map(m=>m[1]).join('; ');
}
const studioPolicy=await policy('infrastructure/lib/studio-web-stack.ts','STUDIO_CONTENT_SECURITY_POLICY');
const buildPolicy=await policy('infrastructure/lib/observable-preview-edge.ts','OBSERVABLE_PREVIEW_BUILD_CSP');
const shellPolicy=await policy('infrastructure/lib/observable-preview-edge.ts','OBSERVABLE_PREVIEW_SHELL_CSP');
const bundled=await build({entryPoints:[resolve(root,'app/src/components/FrameworkProjectPreview.js')],bundle:true,format:'esm',write:false});
const checkInputs = process.env.OPENGEO_CHECK_PUBLICATION_INPUTS === '1';
const inputCheckCss = checkInputs ? await readFile(resolve(root, 'app/src/style.css'), 'utf8') : null;
const id='10000000-0000-4000-8000-000000000001';
const prefix=`/organizations/${id}/projects/${id}/source-projects/${id}/builds/${id}/output/`;
let creates=0,exchanges=0;
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
try {
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===studio) {
      if(url.pathname==='/component.js') return route.fulfill({contentType:'text/javascript',body:bundled.outputFiles[0].text});
      if(checkInputs && url.pathname==='/style.css') return route.fulfill({contentType:'text/css',body:inputCheckCss});
      const policy=url.pathname==='/blocked' ? studioPolicy.replace(/frame-src[^;]*/,"frame-src 'none'") : studioPolicy;
      return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':policy},body:`<!doctype html><title>Studio editor</title>${checkInputs ? '<link rel="stylesheet" href="/style.css">' : ''}<main class="project-publishing-workspace"></main>`});
    }
    if(url.origin===preview) {
      if(url.pathname==='/observable-preview/exchange') {
        exchanges++; assert.equal(route.request().method(),'POST');
        return route.fulfill({contentType:'application/json',body:JSON.stringify({entry_path:prefix+'index.html',expires_at:'2099-01-01T00:00:00Z',publication_authorized:false})});
      }
      if(url.pathname.startsWith('/authorize/')) {
        const name=url.pathname.slice('/authorize/'.length)||'index.html';
        if(!['index.html','preview-shell.js','style.css'].includes(name)) return route.abort();
        return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',
          headers:{'Content-Security-Policy':shellPolicy},body:await readFile(resolve(root,'services/observable-preview/authorize',name))});
      }
      if(url.pathname.startsWith(prefix)) {
        const path=resolve(output,decodeURIComponent(url.pathname.slice(prefix.length)));
        assert(path.startsWith(output+'/'));
        const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'}[extname(path)]||'application/octet-stream';
        try {return route.fulfill({contentType:type,headers:{'Content-Security-Policy':buildPolicy},body:await readFile(path)});}
        catch {return route.fulfill({status:404,body:'Not found'});}
      }
    }
    return route.abort(); // No AWS, GitHub, source-provider or font requests.
  });
  if (checkInputs) {
    const widths = [390, 1280], receipts = [];
    for (const width of widths) {
      const page = await context.newPage(); await page.setViewportSize({width, height: 900}); await page.goto(studio);
      await page.evaluate(async id => {
        const {FrameworkProjectPreview} = await import('/component.js');
        const compiler = 'sha256:' + 'b'.repeat(64), sourceChecksum = 'a'.repeat(64);
        const job = {id, sourceProjectId: id, sourceRevisionId: id, sourceRevisionNumber: 2, purpose: 'preview', state: 'succeeded',
          request: {compilerImageDigest: compiler, sourceManifestChecksumSha256: sourceChecksum}};
        let saved = null;
        window.inputCheck = {metadataReads: 0, approvals: 0, builds: 0};
        const adapter = {listObservableBuildJobs: async () => [job], getObservableBuildJob: async () => job,
          createObservablePreviewCapability: async () => {throw Error('No preview requested in this input check');},
          createObservableBuildJob: async () => {window.inputCheck.builds++; throw Error('No build requested in this input check');},
          getPublicationInputDistributions: async () => {
            window.inputCheck.metadataReads++;
            return {sourceRevisionId: id, sourceManifestChecksumSha256: sourceChecksum, compilerImageDigest: compiler,
              artifactInputId: null, artifactInputsChecksumSha256: null, outputProfile: 'default-32m', artifacts: [], approvals: saved ? [saved] : [],
              archiveFiles: [{path: 'data/original-landcover.tif', attachmentId: id, datasetId: id, datasetVersionId: id,
                resourceId: id, resourceVersionId: id, title: 'Original land-cover GeoTIFF', sizeBytes: 64_912_721,
                checksumSha256: 'c'.repeat(64), license: 'CC-BY-4.0', attribution: 'Provider · original country land-cover record', canPublish: true}]};
          }, createPublicationInputDistribution: async (_project, _source, _revision, request) => {
            window.inputCheck.approvals++;
            saved = {id: request.approvalId, checksum: 'd'.repeat(64), revoked: false,
              manifest: {sourceProjectId: id, sourceRevisionId: id, sourceManifestChecksumSha256: sourceChecksum,
                compilerImageDigest: compiler, outputProfile: request.outputProfile, artifactInputsChecksumSha256: null}};
            throw Error('Response lost after retaining this exact approval');
          }};
        document.querySelector('main').append(FrameworkProjectPreview({adapter, projectId: id,
          sourceProject: {id, currentRevisionId: id, currentRevisionNumber: 2, buildPolicy: {compilerImageDigest: compiler}}, canManage: true}));
      }, id);
      await page.getByRole('button', {name: 'Show preview', exact: true}).waitFor();
      assert.deepEqual(await page.evaluate(() => window.inputCheck), {metadataReads: 0, approvals: 0, builds: 0});
      await page.locator('.publication-input-distribution > summary').click();
      await page.getByLabel('Saved output size limit').selectOption('archive-96m');
      await page.getByRole('button', {name: 'Check saved preview', exact: true}).click();
      assert(await page.getByRole('button', {name: 'Build saved revision', exact: true}).isDisabled());
      await page.locator('input[name="allow-up-to-96-mib-output"]').check();
      assert(!(await page.getByRole('button', {name: 'Build saved revision', exact: true}).isDisabled()));
      await page.getByRole('button', {name: 'Review linked files', exact: true}).click();
      await page.getByText(/Linked files: 61\.9 MiB/).first().waitFor();
      await page.locator('input[name^="share-file-"]').check();
      await page.getByRole('button', {name: 'Approve these files for public sharing', exact: true}).click();
      await page.getByRole('button', {name: 'Check saved sharing approvals', exact: true}).click();
      await page.getByText('Your saved sharing approval was recovered. No second approval request was made.').waitFor();
      assert.deepEqual(await page.evaluate(() => window.inputCheck), {metadataReads: 2, approvals: 1, builds: 0});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Input review must not overflow the viewport');
      if (process.env.OPENGEO_PUBLICATION_INPUT_CHECK_OUTPUT) {
        await mkdir(process.env.OPENGEO_PUBLICATION_INPUT_CHECK_OUTPUT, {recursive: true});
        await page.screenshot({path: resolve(process.env.OPENGEO_PUBLICATION_INPUT_CHECK_OUTPUT, `input-review-${width}.png`), fullPage: true});
      }
      receipts.push({width, metadataReads: 2, approvalWrites: 1, automaticBuilds: 0, originalDataBytes: 64_912_721});
      await page.close();
    }
    console.log(JSON.stringify({publicationInputReview: true, viewports: receipts, externalRequests: 0, awsRequests: 0,
      datasetBytesRead: 0, approvalRecovery: true, denseSourceCss: true}));
  } else {
  const mount=page=>page.evaluate(async ({id,preview})=>{
    const {FrameworkProjectPreview}=await import('/component.js');
    const job={id,sourceProjectId:id,sourceRevisionId:id,sourceRevisionNumber:2,purpose:'preview',state:'succeeded'};
    const adapter={listObservableBuildJobs:async()=>[job],getObservableBuildJob:async()=>job,
      createObservableBuildJob:async()=>{window.buildRequests=(window.buildRequests??0)+1;throw Error('Unexpected build');},
      createObservablePreviewCapability:async()=>({authorizeUrl:preview+'/authorize/#cap='+'a'.repeat(128),expiresAt:'2099-01-01T00:00:00Z',publicationAuthorized:false})};
    document.querySelector('main').append(FrameworkProjectPreview({adapter,projectId:id,
      sourceProject:{id,currentRevisionId:id,currentRevisionNumber:2},canManage:true}));
  },{id,preview});
  const page=await context.newPage(); await page.goto(studio); await mount(page);
  await page.getByRole('button',{name:'Show preview',exact:true}).click();
  const frame=page.frameLocator('iframe');
  await frame.getByRole('heading',{name:'Field-ready workflows for spatial analysis, mapping, and infrastructure screening.'}).waitFor({timeout:20000});
  await frame.locator('.site-card').first().waitFor();
  assert(await frame.locator('.site-card').count()>5);
  assert.equal(await frame.locator('.observablehq--error').count(),0);
  const child=page.frames().find(f=>f.url().startsWith(preview+prefix));
  assert(await child.evaluate(()=>{
    const hero=getComputedStyle(document.querySelector('.home-hero'));
    const card=getComputedStyle(document.querySelector('.site-card'));
    return hero.backgroundImage.includes('linear-gradient') && hero.borderTopWidth==='1px' &&
      card.display==='block' && parseFloat(card.paddingTop)>0;
  }), 'Built project styles must apply, not merely be linked');
  assert(await child.evaluate(()=>{try{parent.document;return false;}catch{return true;}}));
  assert.equal(page.url(),studio+'/');
  creates+=await page.evaluate(()=>window.buildRequests??0);
  const blocked=await context.newPage();await blocked.goto(studio+'/blocked');await mount(blocked);
  await blocked.getByRole('button',{name:'Show preview',exact:true}).click();
  await blocked.getByText(/Studio currently blocks embedded previews/).waitFor();
  const popupEvent=context.waitForEvent('page');
  await blocked.getByRole('button',{name:'Open in new window',exact:true}).click();
  const popup=await popupEvent;await popup.waitForURL(preview+prefix+'index.html');
  assert.equal(await popup.evaluate(()=>opener),null);
  assert.equal(blocked.url(),studio+'/blocked');
  assert.equal(creates,0);assert.equal(exchanges,2);
  console.log(JSON.stringify({savedFrameworkOutput:true,projectStyles:true,reactiveCards:await frame.locator('.site-card').count(),
    crossOriginIsolation:true,existingPolicyFallback:true,editorPreserved:true,buildRequests:creates,awsRequests:0}));
  }
} finally {await browser.close();}
