import {copyFile,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {integratePublication} from './publication-shell.mjs';
import {copyTree,readJson,routeHtmlPath,routeAliases,sealManifest,snapshotTree,sha256,writeJson,assertPublicArtifactBoundary} from './release-utils.mjs';

// Compose maintained sources while retaining independent published editions and
// immutable downloads. Retained objects use conditional server-side copies;
// inspection never reads their encrypted source bytes.
export async function composePublications(workspaceRoot) {
 const work=resolve(workspaceRoot,'.local-archives/public-article-revision');
 const inventory=await readJson(resolve(work,'inventory.json'));
 if(inventory.status!=='passed'||inventory.objects.length>1000)throw Error('A complete retained public inventory is required');
 const root=resolve(workspaceRoot,'dist/public');
 const retainedDemo=await readFile(resolve(work,'retained-public-demo.html'));
 const expectedDemo=inventory.objects.find(o=>o.path==='public-demo.html');
 if(retainedDemo.length!==expectedDemo.bytes||createHash('md5').update(retainedDemo).digest('hex')!==expectedDemo.etag.replaceAll('"',''))throw Error('Retained demo does not match the current public edition');
 await Promise.all(["publications/main-site/dist","publications/noaa-coastal-imagery/dist","publications/map-folio/dist",".local-archives/public-article-revision/notebook-dist",".local-archives/public-article-revision/additional-publications/nepal-native-dist"].map(path=>snapshotTree(resolve(workspaceRoot,path))));
 await rm(root,{recursive:true,force:true});
 const inputs=[['publications/main-site/dist',''],['publications/noaa-coastal-imagery/dist','noaa-coastal-imagery'],['publications/map-folio/dist','map-folio'],['.local-archives/public-article-revision/notebook-dist','accessible-cartographic-design'],['.local-archives/public-article-revision/additional-publications/nepal-native-dist','nepal-census-tables']];
 const requested=await requestedProjectInputs(work);
 inputs.push(...requested.map(row=>[row.path,row.mount]));
 const builds=[];
 for(const [source,mount] of inputs){const tree=await snapshotTree(resolve(workspaceRoot,source));await copyTree(resolve(workspaceRoot,source),resolve(root,mount));builds.push({path:source,mount,artifactTree:tree});}
 await writeFile(resolve(root,'public-demo.html'),retainedDemo);
 const mapSource=resolve(workspaceRoot,'.local-archives/studio-sharing/noaa-owner-workflow/map-folio-source-adaptation/geo-stream-continuation/derived-source/original/source-map.json');
 await mkdir(resolve(root,'map-folio/original'),{recursive:true});await copyFile(mapSource,resolve(root,'map-folio/original/source-map.json'));
 const audit=await readJson(resolve(workspaceRoot,'docs/opengeo-tools-source-audit.json'));
 const saved=await readJson(resolve(work,'source-save-receipt.json'));
 const plan=await readJson(resolve(work,'source-save-plan.json'));
 if(saved.status!=='passed')throw Error('The edited sources must be saved and read back before composition');
 const revisions=[];
 for(const [name,row] of Object.entries(plan)){
  const revision=saved.committed[name];
  if(saved.readback[name]?.id!==revision.id||revision.parentRevisionId!==row.parentId||revision.rightsStatus!==row.head.rightsStatus)throw Error('Saved Source association changed');
  for(const [path,file] of Object.entries(row.changes))if(revision.files.find(f=>f.relativePath===path)?.checksumSha256!==sha256(await readFile(resolve(workspaceRoot,file))))throw Error('Saved source bytes changed: '+file);
  revisions.push({name,sourceProjectId:row.sourceId,revisionId:revision.id,revisionNumber:revision.revisionNumber,rightsStatus:revision.rightsStatus});
 }
 const nativeEdition=await verifiedNepalEdition(work,builds);
 revisions.push(nativeEdition);
 revisions.push(...await verifiedProjectEditions(work,builds));
 const paths=[...audit.routes.map(r=>r.path),'/public-demo'];
 for(const build of builds.slice(1))for(const f of build.artifactTree.files.filter(f=>f.path.endsWith('.html'))){if(f.path!=='index.html'&&!f.path.endsWith('/index.html')&&!f.path.startsWith('_'))paths.push('/'+build.mount+'/'+f.path.slice(0,-5));else if(!f.path.startsWith('_'))paths.push('/'+build.mount+'/'+f.path.slice(0,-10));}
 // One host shell, independent of the publication's native compiler/runtime.
 const site=await import(pathToFileURL(resolve(workspaceRoot,'publications/main-site/src/data/site.js')));
 const config=(await import(pathToFileURL(resolve(workspaceRoot,'publications/main-site/observablehq.config.js')))).default;
 const cssSources=['global.css','theme.css','shell.css'];
 const cssBytes=Buffer.from((await Promise.all(cssSources.map(p=>readFile(resolve(workspaceRoot,'publications/main-site/src/styles',p),'utf8')))).join('\n'));
 const scriptBytes=await readFile(resolve(workspaceRoot,'publications/main-site/src/components/site-shell.js'));
 const cssPath='_site/reading.'+sha256(cssBytes).slice(0,12)+'.css',scriptPath='_site/navigation.'+sha256(scriptBytes).slice(0,12)+'.js';
 await mkdir(resolve(root,'_site'),{recursive:true});await writeFile(resolve(root,cssPath),cssBytes);await writeFile(resolve(root,scriptPath),scriptBytes);
 const corrections=[];
 for(const route of [...new Set(paths)].filter(p=>p!=='/public-demo')) {
  const path=routeHtmlPath(route),target=resolve(root,path),before=await readFile(target,'utf8');
  const compatibility=route==='/noaa-coastal-imagery/project';
  const input=compatibility?await readFile(resolve(workspaceRoot,'publications/noaa-coastal-imagery/dist/index.html'),'utf8'):before;
  const groups=config.pages.map(g=>g.name==='Datasets'?{...g,pages:[...g.pages,...(site.datasetIntroductions??[]).map(p=>({name:p.title,path:p.publicUrl}))]}:g);
  const after=integratePublication(input,{path:compatibility?'/noaa-coastal-imagery/':route,cssPath:'/'+cssPath,scriptPath:'/'+scriptPath,primaryNav:site.primaryNav,siteMetadata:site.siteMetadata,groups,publications:site.publishedProjects,publicationSources:[{publicUrl:'/',publicationId:'4f4e8fba-1832-4ebf-80e2-6584070efaca'},...site.publishedProjects,...(site.datasetIntroductions??[])]});
  await writeFile(target,after);corrections.push({path,beforeSha256:sha256(before),afterSha256:sha256(after),...(compatibility?{canonicalInput:'noaa-coastal-imagery/index.html'}:{})});
 }
 const sharedAssets=[{path:cssPath,sha256:sha256(cssBytes)},{path:scriptPath,sha256:sha256(scriptBytes)}];
 const artifactTree=await snapshotTree(root),files=new Map(artifactTree.files.map(f=>[f.path,f])),occupied=new Set(files.keys()),aliases=[],routes=[];
 for(const path of [...new Set(paths)].sort()){
  const htmlPath=routeHtmlPath(path),f=files.get(htmlPath);if(!f)throw Error('Missing route '+path);
  const keys=routeAliases(path).filter(key=>!occupied.has(key));for(const key of keys)occupied.add(key);
  routes.push({path,htmlPath,sha256:f.sha256,bytes:f.bytes,aliases:keys});for(const key of keys)aliases.push({key,sourcePath:htmlPath,sha256:f.sha256,bytes:f.bytes,contentType:'text/html; charset=utf-8'});
 }
 // Keep zero-byte redirect objects and their original metadata. Never turn a
 // redirected download or acceptance endpoint into a fabricated HTML article.
 const retainedObjects=inventory.objects.filter(o=>!occupied.has(o.path)&&o.path!=='opengeo-public-release-manifest.json');
 assertPublicArtifactBoundary([...occupied,...retainedObjects.map(o=>o.path)],'Composed public release',{allowWorkbenchDemo:true});
 const manifest=sealManifest({schemaVersion:'opengeo.public-bundle.3.0.0',publicOrigin:'https://opengeo.tools',source:{kind:'maintained-publication-collection',publicationMethod:'external-static-collection; native Studio build/review history retained',revisions,framework:'@observablehq/framework@1.13.4',sourceAuditPath:'docs/opengeo-tools-source-audit.json',sourceAuditSha256:sha256(await readFile(resolve(workspaceRoot,'docs/opengeo-tools-source-audit.json'))),recoveredOutputRebuilt:true,builds,corrections,sharedAssets},artifactTree,routes,aliases,retention:{sourcePrefix:inventory.prefix,inventorySha256:sha256(await readFile(resolve(work,'inventory.json'))),objects:retainedObjects}});
 await writeJson(resolve(workspaceRoot,'dist/opengeo-public-bundle.json'),manifest);
 return {files:artifactTree.files.length,routes:routes.length,aliases:aliases.length,retainedObjects:retainedObjects.length,previousPrefix:inventory.prefix,tree:artifactTree.digest};
}

export async function checkComposedPublications(workspaceRoot, manifest) {
 const {verifyTree,verifyManifestSeal}=await import('./release-utils.mjs');verifyManifestSeal(manifest,'Maintained public bundle');
 const projectEditions=await verifiedProjectEditions(resolve(workspaceRoot,'.local-archives/public-article-revision'),manifest.source.builds);
 const added=projectEditions.length;
 if(manifest.publicOrigin!=='https://opengeo.tools'||manifest.routes.length!==43+added||manifest.source.kind!=='maintained-publication-collection'||manifest.source.builds.length!==5+added)throw Error('Invalid maintained publication inventory');
 const root=resolve(workspaceRoot,'dist/public');await verifyTree(root,manifest.artifactTree,'Composed public output');
 for(const build of manifest.source.builds)await verifyTree(resolve(workspaceRoot,build.path),build.artifactTree,'Compiled publication input');
 const nativeEdition=await verifiedNepalEdition(resolve(workspaceRoot,'.local-archives/public-article-revision'),manifest.source.builds);
 if(JSON.stringify(manifest.source.revisions.find(r=>r.name==='nepalCensus'))!==JSON.stringify(nativeEdition))throw Error('Native Nepal publication association changed');
 for(const edition of projectEditions)if(JSON.stringify(manifest.source.revisions.find(r=>r.name===edition.name))!==JSON.stringify(edition))throw Error('Named Publication source/build association changed');
 const inventoryPath=resolve(workspaceRoot,'.local-archives/public-article-revision/inventory.json');
 if(sha256(await readFile(inventoryPath))!==manifest.retention.inventorySha256)throw Error('Public retention inventory changed');
 const inventory=await readJson(inventoryPath);
 if(manifest.retention.sourcePrefix!==inventory.prefix)throw Error('Retained release identity changed');
 const keys=new Set(manifest.artifactTree.files.map(f=>f.path));
 const files=new Map(manifest.artifactTree.files.map(f=>[f.path,f]));
 for(const route of manifest.routes){const f=files.get(route.htmlPath);if(!f||f.sha256!==route.sha256||f.bytes!==route.bytes||routeHtmlPath(route.path)!==route.htmlPath)throw Error('Changed route seal mismatch');}
 for(const alias of manifest.aliases){const f=files.get(alias.sourcePath);if(keys.has(alias.key)||!f||alias.sha256!==f.sha256||alias.bytes!==f.bytes)throw Error('Alias collision or changed content');keys.add(alias.key);}
 for(const item of manifest.retention.objects){if(keys.has(item.path)||!inventory.objects.some(o=>o.path===item.path&&o.bytes===item.bytes&&o.etag===item.etag))throw Error('Retained object changed or collides');keys.add(item.path);}
 for(const old of inventory.objects)if(old.path!=='opengeo-public-release-manifest.json'&&!keys.has(old.path))throw Error('Existing public object lost: '+old.path);
 assertPublicArtifactBoundary([...keys],'Maintained public outputs',{allowWorkbenchDemo:true});
 const projects=await import(pathToFileURL(resolve(workspaceRoot,'publications/main-site/src/data/site.js')));
 if(projects.publishedProjects.length!==(added?8:4)||projects.publishedProjects.some(p=>!p.publicationId||!p.sourceProjectId||!p.publicUrl||'studioUrl' in p))throw Error('Public Projects must reference published Publications');
 const backend=(await readJson(resolve(workspaceRoot,'.local-archives/public-article-revision/projects.json'))).rows.publications;
 const readingPublications=[...projects.publishedProjects,...projects.datasetIntroductions.filter(p=>p.publicationId)];
 if(added&&readingPublications.length!==11)throw Error('The finite eleven-publication reading directory changed');
 for(const p of readingPublications){
  const record=backend.find(b=>b.site_id===p.publicationId&&b.source_project_id===p.sourceProjectId&&b.hostname==='opengeo.tools'&&b.status==='published');
  if(!record||new URL(p.publicationEntry??'',`https://opengeo.tools${record.mount_path}`).pathname!==p.publicUrl)throw Error('Publication directory identity mismatch');
  if(p.publicationEntry){
   const saved=await readJson(resolve(workspaceRoot,'.local-archives/public-article-revision/source-save-receipt.json'));
   const revision=Object.values(saved.committed).find(r=>r.sourceProjectId===p.sourceProjectId);
   if(!revision||revision.entryPath!==`src/${p.publicationEntry}index.md`||revision.title!==p.title||record.title!==p.title)throw Error('Analytical publication entry is not bound to its saved Source');
  }
 }
 if(manifest.source.corrections.length!==42+added||manifest.source.sharedAssets.length!==2)throw Error('Shared host shell missing');
 for(const asset of manifest.source.sharedAssets)if(files.get(asset.path)?.sha256!==asset.sha256)throw Error('Shared site asset changed');
 for(const route of manifest.routes.filter(r=>r.path!=='/public-demo')){
  const html=await readFile(resolve(root,route.htmlPath),'utf8');
  if(route.path.startsWith('/noaa-coastal-imagery/')){
   const nav=html.match(/<nav id="site-navigation"[\s\S]*?<\/nav>/)?.[0];
   if(!nav||nav.includes('<summary>NOAA coastal imagery</summary>')||/href="\/noaa-coastal-imagery\/(sources|datasets|project)/.test(nav))throw Error('Layer records must not become publication navigation');
   if(route.path==='/noaa-coastal-imagery/project'&&(!html.includes('id="coastal-connecticut-2004"')||html.includes('The project introduction and acquisition records are now combined')))throw Error('Legacy NOAA address must open the dataset introduction');
  }
  if(!html.includes('id="site-navigation"')||!html.includes('id="page-outline"')||!html.includes('id="site-appearance"'))throw Error('Hosted navigation missing: '+route.path);
 }

 console.log(JSON.stringify({status:'passed',pages:43+added,publishedProjects:projects.publishedProjects.length,publicEditions:readingPublications.length,retainedObjects:manifest.retention.objects.length,originalObjectsPreserved:inventory.objects.length-1,tree:manifest.artifactTree.digest}));
}

async function verifiedNepalEdition(work,builds) {
 const accepted=await readJson(resolve(work,'additional-publications/nepal-author-acceptance.json'));
 const delivered=await readJson(resolve(work,'additional-publications/nepal-native-publication.json'));
 const build=accepted.nepalBuild,source=accepted.nepalSource.head,pub=delivered.publication;
 const review=delivered.status.reviews.find(r=>r.buildJobId===build.id&&r.deployment?.stage==='deployed');
 const input=builds.find(b=>b.mount==='nepal-census-tables')?.artifactTree.files;
 const output=build.result.outputManifest.files;
 if(accepted.status!=='passed'||accepted.sessionsCleared!==true||accepted.errors.length
   ||accepted.checks.nativePreviewAccepted!=='passed'||accepted.checks.exactNativePreviewHash!=='passed'
   ||build.state!=='succeeded'||source.id!==build.sourceRevisionId||source.rights_status!=='approved'
   ||pub.siteId!=='5ecf3551-ee5f-4aba-a57d-193db3206bca'||pub.status!=='published'
   ||pub.sourceProjectId!==build.sourceProjectId||pub.publishedRevision!==source.revision_number
   ||pub.publicUrl!=='https://opengeo.tools/nepal-census-tables/'||!review?.approvedAt
   ||review.resultChecksumSha256!==build.resultChecksumSha256||review.outputTreeChecksumSha256!==build.result.outputTreeChecksumSha256
   ||input?.length!==1||output.length!==1||input[0].path!=='index.html'
   ||input[0].sha256!==output[0].checksumSha256||input[0].bytes!==output[0].sizeBytes)throw Error('Exact native Nepal edition is not deployed and accepted');
 return {name:'nepalCensus',sourceProjectId:build.sourceProjectId,revisionId:source.id,revisionNumber:source.revision_number,rightsStatus:source.rights_status,buildJobId:build.id,reviewId:review.id,nativeReleasePrefix:review.deployment.releasePrefix};
}

async function requestedProjectInputs(work){
 let receipt;try{receipt=await readJson(resolve(work,'project-publications/native-publication.json'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
 if(receipt.status!=='passed'||Object.keys(receipt.records).length!==7)throw Error('The seven requested native publications must finish before composing their public reading collection');
 return Object.values(receipt.records).map(row=>({path:'.local-archives/public-article-revision/project-publications/native-dist/'+row.id,mount:row.slug}));
}
async function verifiedProjectEditions(work,builds){
 const inputs=await requestedProjectInputs(work);if(!inputs.length)return [];
 const receipt=await readJson(resolve(work,'project-publications/native-publication.json'));
 const sources=await readJson(resolve(work,'project-publications/source-save-receipt.json'));
 const checks=await readJson(resolve(work,'project-publications/notebook-check.json'));
 if(sources.status!=='passed'||checks.status!=='passed'||checks.externalRequests!==0||checks.articles.length!==7||checks.errors.length||receipt.sessionCleared!==true)throw Error('Named Notebook source/reader acceptance missing');
 const revisions=[];
 for(const row of Object.values(receipt.records)){
  const source=sources.records[row.id],build=row.build,review=row.review;
  const pub=receipt.workspaces?.find(p=>p.siteId===row.siteId&&p.sourceProjectId===row.sourceId);
  const files=builds.find(b=>b.mount===row.slug)?.artifactTree.files,output=build.result?.outputManifest.files;
  if(build.state!=='succeeded'||build.sourceRevisionId!==source.revision.id||source.revision.rightsStatus!=='approved'||source.readback.id!==source.revision.id
   ||!row.previewAccepted?.exactHash||!row.previewAccepted.compiledCellsIdentical||row.previewAccepted.errors.length
   ||!review?.approvedAt||review.deployment?.stage!=='deployed'||review.buildJobId!==build.id
   ||review.resultChecksumSha256!==build.resultChecksumSha256||review.outputTreeChecksumSha256!==build.result.outputTreeChecksumSha256
   ||!pub||pub.status!=='published'||pub.publishedRevision!==source.revision.revisionNumber||pub.publicUrl!=='https://opengeo.tools/'+row.slug+'/'
   ||files?.length!==1||files[0].path!=='index.html'||output?.length!==1||!['index.html','dist/index.html'].includes(output[0].path)||files[0].sha256!==output[0].checksumSha256||files[0].bytes!==output[0].sizeBytes)throw Error('Exact named Notebook edition not deployed: '+row.id);
  const article=checks.articles.find(a=>a.id===row.id);if(article?.sourceSHA256!==source.sourceSHA256||article.themes.length!==2)throw Error('Named Notebook reader source changed');
  revisions.push({name:row.id,sourceProjectId:row.sourceId,revisionId:source.revision.id,revisionNumber:source.revision.revisionNumber,rightsStatus:'approved',buildJobId:build.id,reviewId:review.id,nativeReleasePrefix:review.deployment.releasePrefix});
 }
 return revisions;
}
