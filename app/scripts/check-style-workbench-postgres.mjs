// Called by the bounded PostgreSQL runner. Uses existing Studio build, no rebuild.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifyStyleCanvas} from "./style-render-acceptance.mjs";
import {createServer, request} from "node:http";
import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";
import {unzipSync, strFromU8} from "fflate";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
assert.ok(Number.isInteger(config.apiPort) && config.apiPort > 0 && config.apiPort < 65536);
assert.ok(!config.projectSnapshotPaint || config.projectSnapshotOnly, 'Painting belongs to the selected snapshot journey');
assert.ok(!config.projectSnapshotPaintOnly || config.projectSnapshotPaint, 'Minimal painting implies painting');
assert.ok(!config.offlineExportOnly || config.projectSnapshotPaint, 'Offline export requires the normal painted map');
const dist = resolve(process.env.OPEN_GEO_BROWSER_DIST ?? "dist");
const component = (await readdir(resolve(dist, "_import/components"))).find(name => /^ProjectWorkspacePage\.[a-f0-9]+\.js$/.test(name));
const directory = (await readdir(resolve(dist, "_import/components"))).find(name => /^PlatformDirectory\.[a-f0-9]+\.js$/.test(name));
const client = (await readdir(resolve(dist, "_import/lib"))).find(name => /^apiClient\.[a-f0-9]+\.js$/.test(name));
const css = (await readdir(resolve(dist, "_file"))).find(name => /^style\.[a-f0-9]+\.css$/.test(name));
assert.ok(component && client && css);
const workbenchFile = (await readdir(resolve(dist, "_import/components"))).find(name => /^WorkbenchView\.[a-f0-9]+\.js$/.test(name));
const workbenchUrl = `/_import/components/${workbenchFile}`;
const workbenchSource = await readFile(resolve(dist, "_import/components", workbenchFile), "utf8");
const layoutOnlyJourney = config.compositionGuestOnly || config.projectSnapshotOnly;
const styleImport = layoutOnlyJourney ? null : workbenchSource.match(/from "([^"\n]*layerStyleReference[^"\n]*)"/)[1];
const maplibreImport = layoutOnlyJourney ? null : workbenchSource.match(/import maplibregl from "([^"\n]*)"/)[1];
const requests = [];
let apiRequestsStarted = 0;
const snapshotCreateAttempts = [];
let loseSnapshotCreateResponse = Boolean(config.projectSnapshotOnly), snapshotCreateResponseLost = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    if ((config.offlineExportOnly || config.publicationHistoryOnly || config.accountMetadataOnly) && apiRequestsStarted >= 60) {
      requests.push({method:req.method,path:url.pathname,status:429});
      res.writeHead(429,{"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:'local_request_limit',message:'Offline export acceptance request ceiling reached'}}));
      return;
    }
    apiRequestsStarted++;
    const snapshotCreate = config.projectSnapshotOnly && req.method === "POST"
      && /^\/api\/projects\/[a-f0-9-]+\/maps$/.test(url.pathname);
    const attempt = snapshotCreate ? {path:url.pathname, actor:req.headers.authorization, body:""} : null;
    if (attempt) {
      snapshotCreateAttempts.push(attempt);
      req.on("data", chunk => {attempt.body += chunk;});
    }
    const upstream = request({hostname: "127.0.0.1", port: config.apiPort,
      path: req.url.slice(4), method: req.method, headers: req.headers}, response => {
      requests.push({method: req.method, path: url.pathname, status: response.statusCode,
        ...(config.offlineExportOnly || config.publicationHistoryOnly || config.accountMetadataOnly ? {query:url.search} : {})});
      if (snapshotCreate && loseSnapshotCreateResponse && response.statusCode === 201) {
        loseSnapshotCreateResponse = false;
        snapshotCreateResponseLost = true;
        response.resume();
        response.on("end", () => {
          res.writeHead(502, {"content-type":"application/json"});
          res.end(JSON.stringify({error:{code:"fixture_response_lost",message:"Interrupted response"}}));
        });
        return;
      }
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream); return;
  }
  if (url.pathname === "/workspaces") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/_file/${css}"></head><body><main></main><script type="module">
      import {PlatformDirectory} from '/_import/components/${directory}';
      import {ProjectWorkspacePage} from '/_import/components/${component}';
      import {OpenGeoApiClient} from '/_import/lib/${client}';
      globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = ${JSON.stringify(!config.projectSnapshotPaint)};
      const adapter = new OpenGeoApiClient({tokenProvider:()=>${JSON.stringify(config.compositionGuestOnly ? "local-style-guest" : "local-style-editor")}, organizationProvider:()=>${JSON.stringify(config.organizationId)}});
      adapter.kind = "api"; adapter.selectOrganization = () => {}; globalThis.__acceptanceAdapter = adapter;
      const params = new URLSearchParams(location.search);
      document.querySelector('main').append(params.size ? ProjectWorkspacePage({adapter,projectId:params.get('project'),compositionId:params.get('composition'),publicationId:params.get('publication'),mapId:params.get('map'),managementTarget:params.get('view'),startPanel:'style'}) : PlatformDirectory({adapter}));
    </script></body></html>`); return;
  }
  const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(dist + "/")) { res.writeHead(403).end(); return; }
  try {
    res.setHeader("Content-Type", ({".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".woff2":"font/woff2"})[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
async function verifySnapshotPainting(page, requests, reopened, source) {
  assert.equal(reopened.definition.basemaps[0].basemapId, 'blank');
  const datasetId = reopened.definition.layers[0].datasetId;
  // Read collection metadata through the same authorized client; the normal
  // Workbench loads the actual source features through its existing GET path.
  await page.evaluate(({projectId,datasetId}) => globalThis.__acceptanceAdapter.getFeatureCollection(projectId,datasetId),
    {projectId:source.projectId,datasetId});
  await page.waitForFunction(() => {
    const map = document.querySelector('.opengeo-workbench')?.__opengeoMap;
    if (!map?.loaded?.() || !map.isStyleLoaded() || !map.getSource('roads-source')) return false;
    const layers = map.getStyle().layers.filter(layer => layer.source === 'roads-source' && layer.type === 'line');
    return layers.length > 0 && map.queryRenderedFeatures({layers:layers.map(layer => layer.id)}).length > 0;
  });
  const painting = await page.locator('.opengeo-workbench').evaluate(async shell => {
    const map = shell.__opengeoMap;
    const sourceData = await map.getSource('roads-source').getData();
    const layers = map.getStyle().layers.filter(layer => layer.source === 'roads-source' && layer.type === 'line');
    const colors = layers.map(layer => map.getPaintProperty(layer.id,'line-color'));
    const renderedFeatures = map.queryRenderedFeatures({layers:layers.map(layer => layer.id)}).length;
    const canvas = map.getCanvas(), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) throw Error('Normal Workbench WebGL context is unavailable');
    const preserved = gl.getContextAttributes().preserveDrawingBuffer;
    const paintedPixels = await new Promise((resolve,reject) => {
      const timeout = setTimeout(() => {map.off('render',read);reject(Error('Normal Workbench did not render'));},5000);
      const read = () => {
        clearTimeout(timeout);
        const pixels = new Uint8Array(4*canvas.width*canvas.height);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let count = 0;
        for (let i=0;i<pixels.length;i+=4) {
          if (Math.abs(pixels[i]-18)<=3 && Math.abs(pixels[i+1]-52)<=3
            && Math.abs(pixels[i+2]-86)<=3 && pixels[i+3]>0) count++;
        }
        resolve(count);
      };
      map.once('render',read);map.triggerRepaint();
    });
    return {normalWorkbenchMap:true, styleLoaded:map.isStyleLoaded(), mapLoaded:map.loaded(),
      renderer:shell.dataset.renderer, sourceGeometry:sourceData.features[0]?.geometry,
      sourceFeatureCount:sourceData.features.length, pinnedVersion:shell.__opengeoLayers[0].styleReference.versionNumber,
      lineColors:colors, renderedFeatures, preserveDrawingBuffer:preserved, paintedPixels,
      canvas:{width:canvas.width,height:canvas.height}, expectedColor:'#123456',
      geometry:'One synthetic managed LineString from local runtime-role PostgreSQL',
      chromiumArguments:['--use-angle=swiftshader','--enable-unsafe-swiftshader'],
      bounds:'Headless Chromium software GPU; no physical GPU, production data or provider portrayal acceptance'};
  });
  assert.equal(painting.renderer, 'maplibre');
  assert.equal(painting.styleLoaded, true);
  assert.equal(painting.mapLoaded, true);
  assert.equal(painting.preserveDrawingBuffer, true);
  assert.equal(painting.sourceFeatureCount, 1);
  assert.deepEqual(painting.sourceGeometry, {type:'LineString',coordinates:[[-10,0],[10,0]]});
  assert.equal(painting.pinnedVersion, 1);
  assert.ok(painting.lineColors.includes('#123456'));
  assert.ok(painting.renderedFeatures > 0);
  assert.ok(painting.paintedPixels > 30, 'Pinned Style color must paint the reopened normal Workbench framebuffer');
  const featureRoot = `/api/projects/${source.projectId}/datasets/${datasetId}`;
  assert.ok(requests.some(item => item.method === 'GET' && item.path === `${featureRoot}/feature-collection` && item.status === 200));
  assert.ok(requests.some(item => item.method === 'GET' && item.path === `${featureRoot}/features` && item.status === 200));
  painting.authorizedCollectionMetadataGet200 = true;
  painting.normalWorkbenchFeatureGet200 = true;
  return painting;
}
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, browserServer, page;
let metadataStep = "browser";
try {
  const launchOptions = {headless:true, executablePath:["/usr/bin/chromium-browser","/usr/bin/chromium"].find(existsSync),
    ...(config.projectSnapshotPaint ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})};
  if (config.accountMetadataOnly) {
    browserServer = await chromium.launchServer({...launchOptions,host:'127.0.0.1'});
    const pid=browserServer.process().pid;
    const stat=(await readFile(`/proc/${pid}/stat`,'utf8')).split(')').at(-1).trim().split(/\s+/);
    await writeFile(config.ownedBrowserFile,JSON.stringify({pid,startTicks:stat[19]}),{flag:'wx'});
    browser=await chromium.connect(browserServer.wsEndpoint());
  } else browser=await chromium.launch(launchOptions);
  const context = await browser.newContext();
  const blocked = [], errors = [];
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  if (config.artifact) {
    const fixture = config.artifact;
    const entry = `${origin}/workspaces?project=${fixture.projectId}&view=resources`;
    const open = async () => {
      await page.goto(entry);
      const card = page.locator('.project-resource-card').filter({has: page.getByRole('heading',{name:fixture.title,exact:true})});
      await card.getByRole('button',{name:'Open resource',exact:true}).click();
      await page.getByRole('heading',{name:'Project Artifact editions',exact:true}).waitFor();
    };
    await open();
    const panel = page.locator('.project-artifact-versions');
    if (fixture.completedReuse) {
      await page.getByLabel('Render width',{exact:true}).fill('256');
      await page.getByLabel('Render height',{exact:true}).fill('256');
      await page.getByRole('button',{name:'Create map image',exact:true}).click();
      await page.locator('.project-render-result').filter({hasText:'State completed'}).waitFor();
      assert.match(await page.locator('.project-render-result').filter({hasText:'State completed'}).textContent(), new RegExp(fixture.jobs[0]));
    }

    assert.equal(requests.filter(r => /artifact(?:-edition|\/current|\?)/.test(r.path)).length,0);
    await panel.getByRole('button',{name:'Load Artifact state',exact:true}).click();
    await panel.getByText('No Artifact is registered. Choose a completed image to retain its first edition.',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Find completed images',exact:true}).click();
    await panel.getByLabel('Image to register as Artifact edition',{exact:true}).selectOption(fixture.jobs[0]);
    await panel.getByRole('button',{name:'Register image edition',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 1 · current not selected · inspected v1'}).waitFor();
    await panel.getByRole('button',{name:'Use inspected edition as current',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 2 · current v1'}).waitFor();
    const first = await page.evaluate(async f => (await globalThis.__acceptanceAdapter.readArtifactEdition(f.projectId,f.resourceId,1)).manifest,fixture);
    await panel.getByLabel('Image to register as Artifact edition',{exact:true}).selectOption(fixture.jobs[1]);
    await panel.getByRole('button',{name:'Register image edition',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 3 · current v1 · inspected v2'}).waitFor();
    await open();
    await panel.getByRole('button',{name:'Load Artifact state',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 3 · current v1'}).waitFor();
    await panel.getByLabel('Artifact version',{exact:true}).fill('1');
    await panel.getByRole('button',{name:'Inspect Artifact version',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'inspected v1'}).waitFor();
    await page.evaluate(f => globalThis.__acceptanceAdapter.selectArtifactCurrent(f.projectId,f.resourceId,2,3),fixture);
    await panel.getByRole('button',{name:'Use inspected edition as current',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'artifact_revision_conflict'}).waitFor();
    await panel.getByRole('button',{name:'Load Artifact state',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 4 · current v2'}).waitFor();
    await panel.getByLabel('Artifact version',{exact:true}).fill('1');
    await panel.getByRole('button',{name:'Inspect Artifact version',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'inspected v1'}).waitFor();
    await panel.getByRole('button',{name:'Use inspected edition as current',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'revision 5 · current v1'}).waitFor();
    assert.deepEqual(await page.evaluate(async f => (await globalThis.__acceptanceAdapter.readArtifactEdition(f.projectId,f.resourceId,1)).manifest,fixture),first);
    assert.deepEqual(errors,[]);
    assert.deepEqual(blocked,[]);
    assert.deepEqual(requests.filter(r => r.status >= 500),[]);
    process.stdout.write(JSON.stringify({builtResourcePanel:true, realHttpAndPostgres:true,
      completedRenderReusedWithoutDispatch:Boolean(fixture.completedReuse),
      registerWithoutAdvancingCurrent:true, reopenEditions:true, optimisticCurrentConflict:true,
      pinnedManifestStable:true, requests:requests.length, providerRequests:blocked.length,
      tokenVerification:'local fixture', syntheticOutputMetadata:true, renderingVerified:false}));
  } else if (config.accountMetadataOnly) {
    metadataStep = "directory";
    const fixture=config.metadataFixture;
    await page.goto(`${origin}/workspaces`);
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    metadataStep = "open-account-download";
    await page.locator('.platform-account-menu').getByText('Account settings',{exact:true}).click();
    await page.getByRole('button',{name:'Download work…',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Download saved work',exact:true});
    const checkbox=dialog.getByLabel('Include Catalog records and Collections',{exact:true});
    assert.equal(await checkbox.isChecked(),false);
    const metadataReads=()=>requests.filter(r=>r.query?.includes('owner_user_id=') || /\/metadata$|\/source$|repository-object-source|\/collections(?:\/|$)/.test(r.path)).length;
    metadataStep = "review-default";
    const before=metadataReads();
    await dialog.getByRole('button',{name:'Check saved work',exact:true}).click();
    await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Download ZIP');return b&&!b.disabled;});
    assert.equal(metadataReads(),before,'Default off adds no Catalog/Collection/source reads');
    metadataStep = "review-metadata";
    await checkbox.check();
    await dialog.getByRole('button',{name:'Check saved work',exact:true}).click();
    await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Download ZIP');return b&&!b.disabled;});
    metadataStep = "download";
    const ready=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download ZIP',exact:true}).click();
    const download=await ready, bytes=new Uint8Array(await readFile(await download.path()));
    assert.ok(bytes.length<262144,'Tiny metadata fixture ZIP bound');
    metadataStep = "verify-archive";
    const zip=unzipSync(bytes), inventory=JSON.parse(strFromU8(zip['opengeo-account-download.json']));
    assert.equal(inventory.includeOwnedMetadata,true);assert.equal(inventory.scope.ownerUserId,config.editorId);
    const catalog=inventory.exported.filter(i=>i.kind==='catalog-record'), collections=inventory.exported.filter(i=>i.kind==='collection');
    assert.equal(catalog.length,2);assert.equal(collections.length,1);
    for(const item of [...catalog,...collections]) {
      assert.equal(createHash('sha256').update(zip[item.path]).digest('hex'),item.checksumSha256);
      assert.equal(zip[item.path].length,item.sizeBytes);
    }
    const records=catalog.map(i=>JSON.parse(strFromU8(zip[i.path])));
    for(const record of records) {assert.equal(record.record.ownerUserId,config.editorId);assert.deepEqual(record.knowledge.document,fixture.knowledge);assert.equal(record.knowledge.version,1);}
    const remote=records.find(r=>r.record.id===fixture.wmsId).registeredSource.descriptor;
    assert.equal(remote.versionNumber,7);assert.equal(remote.sourceUrl,'https://example.invalid/wms');assert.deepEqual(remote.configuration.layers,['synthetic']);
    const repository=records.find(r=>r.record.id===fixture.repositoryId).registeredSource.descriptor;
    assert.equal(repository.providerVersionId,fixture.providerVersionId);assert.equal(repository.connectionTargetRevision,3);
    const collection=JSON.parse(strFromU8(zip[collections[0].path]));
    assert.equal(collection.owner.principal_id,config.editorId);assert.equal(collection.reference.resource_id,fixture.collectionId);
    assert.equal(collection.entries.length,2);assert.equal(collection.entries[1].reference,null);
    assert.ok(!JSON.stringify(collection).includes('Unavailable private member'));
    assert.ok(!requests.some(r=>r.method!=='GET'||/preview|download-ticket|\/files|\/objects/.test(r.path)));
    assert.equal(blocked.length,0);assert.ok(requests.every(r=>r.status<500));assert.ok(requests.length<=60);
    process.stdout.write(JSON.stringify({status:'passed',accountMetadataOnly:true,compiledNormalAccountUi:true,defaultOffZeroExtraCalls:true,
      actualZipChecksums:true,catalogRecords:2,savedCollections:1,independentSourceRevision:7,providerPinsPreserved:true,
      orderedReferencesAndUnavailablePlaceholder:true,providerRequests:0,sourceBytes:0,httpRequests:requests.length,zipBytes:bytes.length,
      zipSha256:createHash('sha256').update(bytes).digest('hex')}));
  } else if (config.publicationHistoryOnly) {
    const fixture = config.sourceFixture;
    await page.goto(`${origin}/workspaces`);
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    const current = fixture.revisions[1], older = fixture.revisions[0];
    const pages = await page.evaluate(async f => {
      const adapter=globalThis.__acceptanceAdapter;
      return [await adapter.listObservableSourceRevisionsPage(f.projectId,f.id,{limit:1}),
        await adapter.listObservableSourceRevisionsPage(f.projectId,f.id,{limit:1,beforeRevision:2})];
    },fixture);
    assert.deepEqual(pages.map(records=>records.map(record=>record.id)),[[current.revision_id],[older.revision_id]]);
    assert.equal(pages[0][0].parentRevisionId,older.revision_id);
    assert.equal(pages[1][0].parentRevisionId,null);
    for(const actor of ['guest','foreign']) {
      const projectId=actor==='foreign'?fixture.foreignProjectId:fixture.projectId;
      const token=actor==='guest'?'local-style-guest':'local-style-editor';
      for(const suffix of ['revisions/page?limit=1',`revisions/${current.revision_id}/files/index.md`]) {
        const denied=await page.evaluate(async ({projectId,sourceId,suffix,token,account})=>{
          const response=await fetch(`/api/projects/${projectId}/source-projects/${sourceId}/${suffix}`,{
            headers:{authorization:`Bearer ${token}`,'x-opengeo-organization':account}});
          return {status:response.status,body:await response.text()};
        },{projectId,sourceId:fixture.id,suffix,token,account:config.organizationId});
        assert.ok([403,404].includes(denied.status),denied.body);
        assert.ok(!denied.body.includes(fixture.id)&&!denied.body.includes(current.revision_id));
      }
    }
    await page.locator('.platform-account-menu').getByText('Account settings',{exact:true}).click();
    await page.getByRole('button',{name:'Download work…',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Download saved work',exact:true});
    const history=dialog.getByLabel('Include saved versions',{exact:true});
    assert.equal(await history.isChecked(),false);await history.check();
    await dialog.getByRole('button',{name:'Check saved work',exact:true}).click();
    await dialog.getByRole('status').filter({hasText:'2 saved publication versions'}).waitFor();
    const downloadReady=page.waitForEvent('download');
    await dialog.getByRole('button',{name:'Download ZIP',exact:true}).click();
    const download=await downloadReady;
    const outerBytes=new Uint8Array(await readFile(await download.path()));
    const artifactDirectory=resolve(process.env.OPEN_GEO_PUBLICATION_HISTORY_ARTIFACTS ?? '../.local-archives/studio-sharing/noaa-owner-workflow/account-saved-content/publication-history-native-continuation');
    await mkdir(artifactDirectory,{recursive:true});
    await writeFile(resolve(artifactDirectory,'downloaded-account-history.zip'),outerBytes);
    const outer=unzipSync(outerBytes);
    const inventory=JSON.parse(strFromU8(outer['opengeo-account-download.json']));
    assert.equal(inventory.includeSavedPublicationVersions,true);assert.equal(inventory.includeSavedMapVersions,true);
    assert.equal(inventory.complete,false);assert.equal(inventory.grantsIncluded,false);assert.equal(inventory.rightsGranted,false);
    assert.equal(inventory.scope.accountId,config.organizationId);assert.equal(inventory.scope.ownerUserId,config.editorId);
    assert.equal(inventory.exclusions.publicationSavedHistory,false);assert.equal(inventory.exclusions.projectSavedHistory,false);
    assert.equal(inventory.exclusions.savedHistory,false);assert.equal(inventory.exclusions.linkedBytes,true);
    assert.deepEqual(inventory.unresolved,[]);assert.equal(inventory.estimate.savedPublicationVersions,2);
    const publications=inventory.exported.filter(item=>item.kind==='publication-source');
    assert.equal(publications.length,2);
    assert.deepEqual(publications.map(item=>item.revisionId),[current.revision_id,older.revision_id]);
    const checked=[];
    for(const item of publications) {
      const expected=fixture.revisions.find(revision=>revision.revision_id===item.revisionId);
      assert.equal(item.id,fixture.id);assert.equal(item.projectId,fixture.projectId);
      assert.equal(item.revisionNumber,expected.revision_number);
      assert.equal(item.path,expected.revision_number===2?`publications/${fixture.id}/saved-source.zip`:
        `publications/${fixture.id}/versions/v1.saved-source.zip`);
      assert.equal(outer[item.path].byteLength,item.sizeBytes);
      await writeFile(resolve(artifactDirectory,`downloaded-source-v${item.revisionNumber}.zip`),outer[item.path]);
      const nested=unzipSync(outer[item.path]);
      const manifest=JSON.parse(strFromU8(nested['opengeo-source-project.json']));
      assert.equal(manifest.content,'working-draft');
      assert.equal(manifest.metadata.savedRevisionId,item.revisionId);
      assert.equal(manifest.metadata.savedRevisionNumber,item.revisionNumber);
      assert.equal(manifest.metadata.sourceProjectId,fixture.id);assert.equal(manifest.metadata.projectId,fixture.projectId);
      assert.equal(manifest.metadata.siteId,fixture.siteId);assert.equal(manifest.metadata.routeNamespace,fixture.routeNamespace);
      assert.equal(manifest.metadata.title,expected.title);assert.equal(manifest.metadata.entryPath,expected.entry_path);
      assert.equal(manifest.metadata.lockfilePath,null);assert.equal(manifest.metadata.rightsStatus,expected.rights_status);
      assert.equal(manifest.metadata.changeSummary,expected.change_summary);assert.deepEqual(manifest.metadata.buildPolicy,fixture.buildPolicy);
      assert.equal(manifest.baseRevision.purpose,'original-context-only');
      const revision=manifest.baseRevision.revision;
      assert.equal(revision.id,item.revisionId);assert.equal(revision.sourceProjectId,fixture.id);
      assert.equal(revision.parentRevisionId,expected.parent_revision_id);assert.equal(revision.createdBy,config.editorId);
      assert.equal(Date.parse(revision.createdAt),Date.parse(expected.created_at));
      assert.equal(revision.manifestChecksumSha256,expected.manifest_checksum_sha256);
      assert.deepEqual(revision.manifest,expected.manifest);assert.deepEqual(manifest.dataAttachments,[]);
      for(const file of expected.files) {
        const bytes=nested[`source/${file.relative_path}`];
        assert.deepEqual(Buffer.from(bytes),Buffer.from(fixture.bytesByRevision[item.revisionId][file.relative_path],'base64'));
        const pin=revision.files.find(value=>value.relativePath===file.relative_path);
        assert.equal(pin.sourceObjectId,file.source_object_id);assert.equal(pin.s3VersionId,file.s3_version_id);
        assert.equal(pin.bucket,file.bucket);assert.equal(pin.objectKey,file.object_key);
        assert.equal(pin.etag,file.etag);assert.equal(pin.contentType,file.content_type);
        assert.equal(pin.checksumSha256,file.checksum_sha256);assert.equal(pin.sizeBytes,file.size_bytes);
        const archived=manifest.files.find(value=>value.path===file.relative_path);
        assert.equal(archived.checksumSha256,file.checksum_sha256);assert.equal(archived.sizeBytes,bytes.byteLength);
      }
      checked.push({id:item.id,revisionId:item.revisionId,revisionNumber:item.revisionNumber,parentRevisionId:revision.parentRevisionId,path:item.path,bytes:item.sizeBytes});
    }
    assert.ok(requests.some(item=>item.path.endsWith('/revisions/page')&&item.query==='?limit=25&before_revision=2'&&item.status===200));
    assert.deepEqual(requests.filter(item=>item.path.endsWith('/revisions')),[]);
    assert.deepEqual(requests.filter(item=>item.method!=='GET'),[]);
    assert.ok(apiRequestsStarted<=60);assert.ok(requests.length<=60);
    assert.deepEqual(requests.filter(item=>item.status>=500),[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    process.stdout.write(JSON.stringify({status:'passed',publicationHistoryOnly:true,nativeOwnerAccountHistoryZip:true,
      exactNestedSourceBytes:true,bomAndCrLfRetained:true,binaryBytesRetained:true,immutableIdsParentsSettingsProvenanceAndPins:true,
      runtimeRolePagedEndpointAndCursor:true,guestAndForeignSourceDenied:true,savedPublicationSources:checked,
      outerZipBytes:outerBytes.byteLength,exclusions:inventory.exclusions,apiCalls:requests.length,browserWrites:0,
      providerRequests:blocked.length,requests,tokenVerification:'local fixture',renderingReused:true,awsRequests:0}));
  } else if (config.offlineExportOnly) {
    const source = config.maps[0];
    await page.goto(`${origin}/workspaces?composition=${source.id}`);
    await page.locator('.opengeo-workbench').waitFor();
    const reopened = await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id),source.id);
    assert.equal(reopened.version,2);
    assert.equal(reopened.ownerUserId,config.editorId);
    const painting = await verifySnapshotPainting(page,requests,reopened,source);
    await page.getByRole('button',{name:'Project',exact:true}).click();
    await page.getByRole('menuitem',{name:/^Save as \/ export…/}).click();
    const exportDialog = page.getByRole('dialog',{name:'Save as or export Project',exact:true});
    await exportDialog.getByLabel('Project export format',{exact:true}).selectOption('jpeg');
    const jpegReady=page.waitForEvent('download',{predicate:download=>download.suggestedFilename().endsWith('.jpg')});
    const provenanceReady=page.waitForEvent('download',{predicate:download=>download.suggestedFilename().endsWith('.map-export.json')});
    await exportDialog.getByRole('button',{name:'Export file',exact:true}).click();
    const [jpegDownload,provenanceDownload]=await Promise.all([jpegReady,provenanceReady]);
    await page.waitForFunction(() => document.body.textContent.includes('Current map exported as bounded JPEG'));
    assert.ok(jpegDownload && provenanceDownload);
    const jpegBytes = await readFile(await jpegDownload.path());
    assert.deepEqual([...jpegBytes.subarray(0,3)],[255,216,255]);
    const provenance = JSON.parse(await readFile(await provenanceDownload.path(),'utf8'));
    const decoded = await page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/jpeg;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let nonWhitePixels=0,pinnedColorPixels=0;
      for(let i=0;i<pixels.length;i+=4){
        if(pixels[i]<240||pixels[i+1]<240||pixels[i+2]<240)nonWhitePixels++;
        if(Math.abs(pixels[i]-18)<=40&&Math.abs(pixels[i+1]-52)<=40&&Math.abs(pixels[i+2]-86)<=40)pinnedColorPixels++;
      }
      return {width:canvas.width,height:canvas.height,nonWhitePixels,pinnedColorPixels,colorTolerance:40};
    },jpegBytes.toString('base64'));
    assert.equal(decoded.width,painting.canvas.width);assert.equal(decoded.height,painting.canvas.height);
    assert.ok(decoded.nonWhitePixels>30);assert.ok(decoded.pinnedColorPixels>30,'JPEG retains the pinned Style line color');
    assert.equal(provenance.image.mediaType,'image/jpeg');
    assert.equal(provenance.image.width,decoded.width);assert.equal(provenance.image.height,decoded.height);
    assert.equal(provenance.image.background,'#ffffff');assert.equal(provenance.authorityIncluded,false);
    assert.equal(provenance.sourceUrlsIncluded,false);assert.equal(provenance.basemap.basemapId,'blank');
    assert.ok(provenance.layers.some(layer => layer.datasetId===reopened.definition.layers[0].datasetId));
    await exportDialog.getByRole('button',{name:'Close',exact:true}).click();

    await page.goto(`${origin}/workspaces`);
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    await page.locator('.platform-account-menu').getByText('Account settings',{exact:true}).click();
    await page.getByRole('button',{name:'Download work…',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Download saved work',exact:true});
    const includeHistory=dialog.getByLabel('Include saved map versions',{exact:true});
    assert.equal(await includeHistory.isChecked(),false);
    await includeHistory.check();
    const versionsBefore=requests.filter(item=>/\/compositions\/.+\/versions/.test(item.path)).length;
    await dialog.getByRole('button',{name:'Check saved work',exact:true}).click();
    await dialog.getByRole('button',{name:'Download ZIP',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(() => !document.querySelector('.platform-account-download-dialog button:nth-child(2)')?.disabled);
    await dialog.getByRole('status').filter({hasText:'3 saved map versions'}).waitFor();
    assert.ok(requests.filter(item=>/\/compositions\/.+\/versions$/.test(item.path)&&item.query==='?limit=25'&&item.status===200).length>versionsBefore);
    const zipReady=page.waitForEvent('download');
    await dialog.getByRole('button',{name:'Download ZIP',exact:true}).click();
    const zipDownload=await zipReady;
    const zip=unzipSync(new Uint8Array(await readFile(await zipDownload.path())));
    const inventory=JSON.parse(strFromU8(zip['opengeo-account-download.json']));
    assert.equal(inventory.includeSavedMapVersions,true);assert.equal(inventory.complete,false);
    assert.equal(inventory.exclusions.projectSavedHistory,false);
    assert.equal(inventory.exclusions.publicationSavedHistory,true);assert.equal(inventory.exclusions.savedHistory,true);
    assert.equal(inventory.exclusions.linkedBytes,true);assert.deepEqual(inventory.unresolved,[]);
    assert.equal(inventory.exported.length,3);assert.equal(inventory.estimate.savedMapVersions,3);
    const exportedVersions=[];
    for(const item of inventory.exported){
      assert.equal(item.kind,'project');
      const snapshot=JSON.parse(strFromU8(zip[item.path]));
      const saved=await page.evaluate(({id,version})=>globalThis.__acceptanceAdapter.getCompositionVersion(id,version),item);
      assert.equal(snapshot.projectId,item.id);assert.equal(snapshot.version,item.version);
      assert.deepEqual(snapshot.definition,saved.definition);assert.equal(snapshot.project.ownerUserId,config.editorId);
      assert.equal(snapshot.grantsIncluded,false);assert.equal(snapshot.dependenciesBundled,false);
      assert.equal(snapshot.definition.layers[0].styleReference.versionNumber,1);
      assert.ok(requests.some(trace=>trace.path===`/api/compositions/${item.id}/versions/${item.version}`&&trace.status===200));
      exportedVersions.push({id:item.id,version:item.version,path:item.path});
    }
    assert.deepEqual(inventory.exported.filter(item=>item.id===source.id).map(item=>item.version),[2,1]);
    assert.equal(inventory.exported.find(item=>item.id===source.id&&item.version===1).path,`projects/${source.id}/versions/v1.opengeo-project.json`);
    assert.deepEqual(await page.evaluate(id=>globalThis.__acceptanceAdapter.getComposition(id),source.id),reopened);
    assert.deepEqual(requests.filter(item=>item.method!=='GET'),[]);
    assert.ok(apiRequestsStarted<=60);assert.ok(requests.length<=60);
    assert.deepEqual(requests.filter(item=>item.status>=500),[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    process.stdout.write(JSON.stringify({status:'passed',offlineExportOnly:true,paintedMapId:source.id,
      nativeWorkbenchJpegDownload:true,jpeg:{...decoded,bytes:jpegBytes.length,provenance},
      nativeAccountHistoryZip:true,savedMapSnapshots:exportedVersions,exclusions:inventory.exclusions,
      noWrites:true,renderingVerified:true,painting,realHttpAndPostgres:true,principalFromDatabase:true,
      tokenVerification:'local fixture',providerRequests:0,requests:requests.length,requestCeiling:60,traces:requests,
      scope:'Synthetic local saved-map JPEG and owned map history ZIP only; Publication history, linked GIS and peer visual parity excluded'}));
  } else if (config.projectSnapshotPaintOnly) {
    const source = config.maps[0];
    await page.goto(`${origin}/workspaces?composition=${source.id}`);
    await page.locator('.opengeo-workbench').waitFor();
    const reopened = await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id),source.id);
    assert.equal(reopened.version,1);
    assert.equal(reopened.ownerUserId,config.editorId);
    const painting = await verifySnapshotPainting(page,requests,reopened,source);
    assert.deepEqual(requests.filter(item => item.method !== 'GET'),[]);
    assert.deepEqual(requests.filter(item => item.status >= 500),[]);
    assert.deepEqual(errors,[]);
    assert.deepEqual(blocked,[]);
    process.stdout.write(JSON.stringify({status:'passed',paintedMapId:source.id,
      minimalPaintingOnly:true,normalSavedMapOpen:true,noWrites:true,
      scope:'Normal saved-map painting continuation only; prior snapshot export/create/retry/isolation acceptance reused',
      snapshotAcceptanceReplayed:false,renderingVerified:true,painting,
      realHttpAndPostgres:true,principalFromDatabase:true,tokenVerification:'local fixture',
      providerRequests:0,requests:requests.length,traces:requests}));
  } else if (config.projectSnapshotOnly) {
    const source = config.maps[0], importedName = "Snapshot imported map";
    let painting = null;
    await page.goto(`${origin}/workspaces?composition=${source.id}`);
    await page.locator('.opengeo-workbench').waitFor();
    await page.waitForLoadState('networkidle');
    const original = await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id), source.id);
    assert.equal(original.version, 1);
    assert.equal(original.definition.layers[0].styleReference.versionNumber, 1);

    await page.getByRole('button', {name:'Project', exact:true}).click();
    await page.getByRole('menuitem', {name:/^Save as \/ export…/}).click();
    const exportDialog = page.getByRole('dialog', {name:'Save as or export Project', exact:true});
    await exportDialog.getByLabel('Project export format', {exact:true}).selectOption('opengeo-saved');
    await exportDialog.getByRole('button', {name:'Find saved versions', exact:true}).click();
    await exportDialog.getByLabel('Saved Project version', {exact:true}).selectOption('1');
    const downloadReady = page.waitForEvent('download');
    await exportDialog.getByRole('button', {name:'Export file', exact:true}).click();
    const download = await downloadReady;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.schemaVersion, 'opengeo.project-version.1.0.0');
    assert.equal(exported.projectId, source.id);
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.definition, original.definition);
    assert.equal(exported.dependenciesBundled, false);
    assert.equal(exported.accessIncluded, false);
    await exportDialog.getByRole('button', {name:'Close', exact:true}).click();

    // Descriptive file identities cannot choose the destination or its new owner.
    const guestId = '10000000-0000-4000-8000-000000000013';
    const inputSnapshot = {...exported, projectId:config.maps[1].id, ownerUserId:guestId,
      project:{id:config.maps[1].id, name:'Untrusted snapshot name', ownerUserId:guestId},
      history:{...exported.history, createdBy:guestId}};
    await page.getByRole('button', {name:'Project', exact:true}).click();
    const fileReady = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', {name:/^Open Project file…/}).click();
    const chooser = await fileReady;
    const readsBeforeReview = requests.length;
    await chooser.setFiles({name:download.suggestedFilename(), mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify(inputSnapshot))});
    const review = page.getByRole('dialog', {name:'Review Project file', exact:true});
    await review.getByText('Saved version 1 · 1 Layer references', {exact:true}).waitFor();
    assert.equal(requests.length, readsBeforeReview, 'File review makes no API request');
    await review.getByRole('button', {name:'Create a new map…', exact:true}).click();
    const createDialog = page.getByRole('dialog', {name:'Create map from snapshot', exact:true});
    await createDialog.getByLabel('New map name', {exact:true}).fill(importedName);
    assert.equal(requests.length, readsBeforeReview, 'Choosing a name makes no API request');
    await createDialog.getByRole('button', {name:'Create new map', exact:true}).click();
    await createDialog.getByText(/Save As failed safely/).waitFor();
    assert.equal(snapshotCreateResponseLost, true);
    await createDialog.getByRole('button', {name:'Create new map', exact:true}).click();
    const open = createDialog.getByRole('link', {name:'Open created map', exact:true});
    await open.waitFor();
    const href = await open.getAttribute('href');
    const createdId = new URL(href, origin).searchParams.get('composition');
    assert.ok(createdId && createdId !== source.id);
    const ownAttempts = snapshotCreateAttempts.filter(item => item.actor === 'Bearer local-style-editor');
    assert.equal(ownAttempts.length, 2);
    const createBody = JSON.parse(ownAttempts[0].body);
    assert.ok(createBody.creation_key);
    assert.deepEqual(JSON.parse(ownAttempts[1].body), createBody, 'Retry preserves the original creation key and intent');
    assert.equal(ownAttempts[0].path, `/api/projects/${source.projectId}/maps`);
    assert.deepEqual(Object.keys(createBody).sort(), ['creation_key','definition','description','name']);
    assert.deepEqual(createBody.definition, exported.definition);
    assert.deepEqual(await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id), source.id), original);

    await open.click();
    await page.waitForURL(url => url.searchParams.get('composition') === createdId);
    await page.locator('.opengeo-workbench').waitFor();
    const reopened = await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id), createdId);
    assert.equal(reopened.name, importedName);
    assert.equal(reopened.version, 1);
    assert.equal(reopened.accessContainerId, original.accessContainerId);
    assert.equal(reopened.ownerUserId, config.editorId);
    assert.deepEqual(reopened.definition, exported.definition);
    assert.deepEqual(reopened.definition.layers[0].styleReference, original.definition.layers[0].styleReference);
    const retained = await page.evaluate(id => globalThis.__acceptanceAdapter.getCompositionVersion(id, 1), createdId);
    assert.equal(retained.version, 1);
    assert.equal(retained.createdBy, config.editorId);
    assert.deepEqual(retained.definition, exported.definition);
    if (config.projectSnapshotPaint) {
      painting = await verifySnapshotPainting(page, requests, reopened, source);
    }
    const matches = await page.evaluate(query => globalThis.__acceptanceAdapter.listCompositions({query}), importedName);
    assert.equal(matches.filter(item => item.name === importedName).length, 1, 'Lost response creates no duplicate map');
    assert.deepEqual(await page.evaluate(id => globalThis.__acceptanceAdapter.getComposition(id), source.id), original);
    const denials = await page.evaluate(async ({id, projectId, body, organizationId, otherOrganizationId}) => {
      const results = [];
      for (const [scope, token, organization] of [
        ['guest','local-style-guest',organizationId], ['foreign-account','local-style-editor',otherOrganizationId]
      ]) {
        const headers = {authorization:`Bearer ${token}`, 'x-opengeo-organization':organization, 'content-type':'application/json'};
        const read = await fetch(`/api/compositions/${id}`, {headers});
        const create = await fetch(`/api/projects/${projectId}/maps`, {method:'POST',headers,body:JSON.stringify(body)});
        results.push({scope, readStatus:read.status, createStatus:create.status});
      }
      return results;
    }, {id:createdId, projectId:source.projectId, body:createBody,
      organizationId:config.organizationId, otherOrganizationId:config.otherOrganizationId});
    for (const denial of denials) {
      assert.equal(denial.readStatus, 404, `${denial.scope} cannot read the imported map`);
      assert.ok([403,404].includes(denial.createStatus), `${denial.scope} cannot create from the imported definition`);
    }
    assert.equal(requests.filter(item => item.method !== 'GET' && item.status < 400).length, 2);
    assert.deepEqual(requests.filter(item => item.status >= 500), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    process.stdout.write(JSON.stringify({status:'passed', createdMapId:createdId,
      nativeSavedVersionExport:true, nativeFileReviewWithoutRequests:true, nativeCreateAndNormalReopen:true,
      lostCreateResponseRecoveredWithoutDuplicate:true, sameCreationKeyRetried:true,
      exactLayerAndPinnedStyleReferences:true, governedOwnerFromActor:true, fileIdentityIgnored:true,
      originalMapUnchanged:true, denials, realHttpAndPostgres:true, principalFromDatabase:true,
      tokenVerification:'local fixture', renderingVerified:Boolean(painting), ...(painting ? {painting} : {}),
      providerRequests:0, requests:requests.length,
      traces:requests}));
  } else if (config.compositionGuestOnly) {
    await page.goto(`${origin}/workspaces`);
    await page.locator('.composition-directory[data-state="ready"]').waitFor();
    assert.equal(await page.locator('.composition-directory tbody tr').count(), 0);
    for (const map of config.maps) {
      await page.goto(`${origin}/workspaces?composition=${map.id}`);
      await page.getByRole('heading', {name:'Project not found', exact:true}).waitFor();
      assert.equal(await page.locator('.opengeo-workbench').count(), 0);
      assert.equal(await page.getByRole('button', {name:'Save', exact:true}).count(), 0);
    }
    const map = config.maps[0];
    await page.goto(`${origin}/workspaces?project=${map.projectId}&map=${map.id}`);
    await page.getByRole('heading', {name:'Project not found', exact:true}).waitFor();
    assert.equal(await page.locator('.opengeo-workbench').count(), 0);
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
    assert.equal(requests.filter(r => /\/compositions\/[a-f0-9-]+$/.test(r.path) && r.status === 404).length, 2);
    assert.deepEqual(requests.filter(r => /\/(?:datasets|styles|maps)\//.test(r.path) && r.status === 200), []);
    assert.deepEqual(requests.filter(r => r.status >= 500), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    process.stdout.write(JSON.stringify({status:'passed', guestDirectoryExcludesPrivateCompositions:true,
      guestCanonicalCompositionsDenied:2, guestLegacyMapRouteDenied:true, noWorkbenchOrSaveExposed:true,
      noWrites:true, noSuccessfulPrivateLayerOrStyleDetailReads:true, realHttpAndPostgres:true,
      principalFromDatabase:true, tokenVerification:'local fixture', ownerAcceptanceReplayed:false,
      providerRequests:0, requests:requests.length, traces:requests}));
  } else {
  await page.goto(`${origin}/workspaces`);
  await page.locator('.composition-directory[data-state="ready"]').waitFor();
  assert.equal(await page.locator('.composition-directory tbody tr').count(), 2);
  await page.getByLabel('Search authored Projects',{exact:true}).fill('second');
  await page.waitForFunction(() => document.querySelector('.composition-directory')?.dataset.state === 'ready'
    && document.querySelectorAll('.composition-directory tbody tr').length === 1);
  assert.match(await page.locator('.composition-directory tbody tr a').first().getAttribute('href'), /composition=/);
  const showFilterEditor=async()=>{
    await page.locator('.opengeo-workbench').evaluate(s=>s.__opengeoData.set('roads',{type:'FeatureCollection',features:[{type:'Feature',properties:{status:'reviewed'},geometry:{type:'LineString',coordinates:[[-10,0],[10,0]]}}]}));
    await page.getByLabel('Layer actions for Roads',{exact:true}).click();
    await page.getByRole('button',{name:'Style layer',exact:true}).click();
  };
  const showLabelEditor=async()=>{
    await page.locator('.opengeo-workbench').evaluate(s=>s.__opengeoData.set('roads-context',{type:'FeatureCollection',features:[{type:'Feature',properties:{status:'reviewed'},geometry:{type:'LineString',coordinates:[[-10,0],[10,0]]}}]}));
    await page.getByLabel('Layer actions for Roads context',{exact:true}).click();
    await page.getByRole('button',{name:'Style layer',exact:true}).click();
  };
  for (const map of config.maps) {
    const route = map === config.maps[0] ? `composition=${map.id}` : `project=${map.projectId}&map=${map.id}`;
    await page.goto(`${origin}/workspaces?${route}`);
    await page.getByRole("button", {name:"Find Styles for this Layer", exact:true}).click();
    await page.getByRole("button", {name:"Styles in Roads", exact:true}).click();
    await page.getByLabel("Version of Revised roads", {exact:true}).fill("1");
    await page.getByRole("button", {name:"Apply Revised roads", exact:true}).click();
    await page.getByRole("button", {name:"Use previous inline styling", exact:true}).waitFor();
    await page.getByRole("button", {name:"Move Roads context up", exact:true}).click();
    assert.deepEqual(await page.locator('.gis-layer-row').evaluateAll(rows=>rows.map(row=>row.dataset.layerId)), ['roads-context','roads']);
    await showFilterEditor();
    await page.getByLabel('Opacity blending',{exact:true}).selectOption('composite');
    await page.getByLabel('Filter field',{exact:true}).selectOption('status');
    await page.getByLabel('Filter operator',{exact:true}).selectOption('not_in');
    await page.getByLabel('Filter value',{exact:true}).fill('hidden\narchived');
    await page.getByRole('button',{name:'Apply map filter',exact:true}).click();
    await showLabelEditor();
    await page.getByLabel('Opacity blending',{exact:true}).selectOption('composite');
    await page.getByLabel('Label drawing order',{exact:true}).selectOption('above-data');
    await page.getByLabel('Name field',{exact:true}).selectOption('status');
    await page.getByLabel('Show labels on map',{exact:true}).check();
    await showFilterEditor();
    await page.getByLabel("Show Roads", {exact:true}).uncheck();
    await page.getByRole("button", {name:"Save", exact:true}).click();
    await page.locator('.opengeo-workbench[data-save-state="saved"]').waitFor();
    await page.reload();
    await page.getByRole("button", {name:"Use previous inline styling", exact:true}).waitFor();
    await page.getByText("The exact saved Style is active. Inline style controls do not alter this binding.", {exact:true}).waitFor();
    assert.match(await page.locator('.opengeo-workbench').textContent(), /version 1/);
    await showFilterEditor();
    assert.equal(await page.getByLabel('Opacity blending',{exact:true}).inputValue(),'composite');
    assert.equal(await page.getByLabel('Filter operator',{exact:true}).inputValue(),'not_in');
    assert.equal(await page.getByLabel('Filter value',{exact:true}).inputValue(),'hidden\narchived');
    assert.deepEqual(await page.locator('.opengeo-workbench').evaluate(s=>s.__opengeoLayers.find(l=>l.layerId==='roads').filter),['!',['in',['get','status'],['literal',['hidden','archived']]]]);

    await showLabelEditor();
    assert.equal(await page.getByLabel('Opacity blending',{exact:true}).inputValue(),'composite');
    assert.equal(await page.getByLabel('Label drawing order',{exact:true}).inputValue(),'above-data');
    assert.equal(await page.getByLabel('Show labels on map',{exact:true}).isChecked(),true);
    assert.equal(await page.getByLabel('Name field',{exact:true}).inputValue(),'status');
    await showFilterEditor();
    assert.equal(await page.getByLabel("Show Roads", {exact:true}).isChecked(), false);
    assert.deepEqual(await page.locator('.gis-layer-row').evaluateAll(rows=>rows.map(row=>row.dataset.layerId)), ['roads-context','roads']);
  }
  const rendering = await verifyStyleCanvas(page, {workbench:workbenchUrl,
    style:new URL(styleImport, origin+workbenchUrl).pathname,
    maplibre:new URL(maplibreImport, origin+workbenchUrl).pathname});
  const publication = config.publications[1];
  const writesBefore = requests.filter(r => r.method !== 'GET').length;
  await page.goto(`${origin}/workspaces?publication=${publication.id}`);
  await page.getByRole('heading',{name:publication.title,exact:true,level:1}).waitFor();
  assert.equal(await page.getByLabel('Publication',{exact:true}).inputValue(),publication.id);
  assert.equal(await page.getByLabel('Publication',{exact:true}).locator('option').count(),1);
  await page.reload();
  await page.getByRole('heading',{name:publication.title,exact:true,level:1}).waitFor();
  assert.equal(requests.filter(r => r.method !== 'GET').length,writesBefore);
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(r => r.method === 'PATCH' && r.status === 200 && /\/maps\//.test(r.path)).length, 2);
  const failures = requests.filter(r => r.status >= 500);
  assert.deepEqual(failures, []);
  process.stdout.write(JSON.stringify({authoredProjectDirectory:true, serverFilteredSearch:true, builtWorkbenchSaveReopen:true, inlineAndReferencedCompositeOpacitySavedReopened:true, labelOrderSavedReopened:true,membershipFilterSavedReopened:true,filterEditorRestored:true,syntheticLoadedFieldData:true,visibilitySavedReopened:true, layerOrderSavedReopened:true, compositions:2, exactVersion:1,
    realHttpAndPostgres:true, canonicalAndLegacyRoutes:true, exactPublicationReopen:true, publicationInspectionReadOnly:true, principalFromDatabase:true, tokenVerification:"local fixture", rendering,
    providerRequestsBlocked:blocked.length, requests:requests.length}));
  }
} catch (error) {
  const safeErrorTypes = ['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AggregateError','AssertionError','TimeoutError'];
  console.error(JSON.stringify(config.accountMetadataOnly
    ? {step:metadataStep,errorType:safeErrorTypes.includes(error.name)?error.name:'Error',httpRequests:requests.length}
    : {requests, pageText: await page?.locator("body").textContent()}));
  throw error;
} finally {
  if (config.accountMetadataOnly) {
    const closures = await Promise.allSettled([browser?.close(), browserServer?.close(),
      new Promise((done, reject) => server.close(error => error ? reject(error) : done()))]);
    const failures = closures.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned browser/server cleanup failed');
  } else {
    await browser?.close();
    await browserServer?.close();
    await new Promise(done => server.close(done));
  }
}
