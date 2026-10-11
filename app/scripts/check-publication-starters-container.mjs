// Compile the exact drafts created by the UI, not hand-written substitutes.
// Local immutable image only; no image rebuild, AWS request, save or publication.
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {publicationFormats, publicationStarter} from '../src/lib/publicationDrafts.js';
import {PodmanRunner} from '../../services/observable-coordinator/src/podman-runner.mjs';
import {INVOCATION_SCHEMA, REQUEST_SCHEMA, REQUIRED_SANDBOX, sha256} from '../../services/observable-coordinator/src/contracts.mjs';

const imageDigest=process.argv[2], only=process.argv[3];
assert.match(imageDigest??'',/^sha256:[a-f0-9]{64}$/,'Supply an exact local image ID');
assert(!only || publicationFormats.some(([format])=>format===only),'Unknown format');
const output=await mkdtemp('/tmp/opengeo-publication-starters-');
const limits={cpuMillis:1000,memoryMiB:2048,timeoutSeconds:120,maxInputFiles:128,
  maxInputBytes:16*1024*1024,maxOutputFiles:512,maxOutputBytes:32*1024*1024};
const results=[];
try {
  for(const [format] of publicationFormats.filter(([format])=>!only || format===only)) {
    const draft=publicationStarter({format,title:'Starter acceptance',sourceProject:{currentRevisionNumber:0}});
    const files=await Promise.all(draft.files.map(async file=>{
      const bytes=Buffer.from(await file.blob.arrayBuffer());
      return {path:file.relativePath,contentType:file.contentType,sizeBytes:bytes.length,checksumSha256:sha256(bytes),bytes};
    }));
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const inputs=new Map(files.map(file=>[file.path,file.bytes]));
    const invocation={schemaVersion:INVOCATION_SCHEMA,buildJobId:randomUUID(),
      requestChecksumSha256:'b'.repeat(64),inputManifestChecksumSha256:'c'.repeat(64),entryPath:draft.entryPath,lockfilePath:draft.lockfilePath,
      files:files.map(({bytes,...file})=>file),request:{schemaVersion:REQUEST_SCHEMA,sourceProjectId:randomUUID(),sourceRevisionId:randomUUID(),
        sourceRevisionNumber:1,sourceManifestChecksumSha256:'c'.repeat(64),purpose:'preview',compilerImageDigest:imageDigest,
        frameworkVersion:'1.13.4',lockfileFormat:'npm-package-lock-v3',lockfileChecksumSha256:null,networkPolicy:'deny_all',resourceLimits:limits}};
    const result=await new PodmanRunner().run({invocation,inputs,limits});
    assert.deepEqual(result.sandbox,REQUIRED_SANDBOX);
    assert.equal(result.report.validationReport.publicationAuthorized,false);
    const routes=result.report.routeManifest;
    await writeFile(join(output,format+'-report.json'),JSON.stringify(result.report,null,2));
    assert(result.outputs.has('dist/index.html'),`${format} starter has no root index; output paths: ${[...result.outputs.keys()].filter(path=>path.endsWith('.html')).join(', ')}`);
    assert(routes.some(route=>route.path==='/' && route.file==='dist/index.html'),`${format} needs the root route for its configured destination`);
    const html=result.outputs.get('dist/index.html').toString();assert(html.includes('Starter acceptance'));
    for(const file of files)assert.equal(sha256(inputs.get(file.path)),file.checksumSha256,'Source bytes remain unchanged');
    results.push({format,entryPath:draft.entryPath,sourceFiles:files.map(({bytes,...file})=>file),
      rootRoute:true,outputTreeChecksumSha256:result.report.outputTreeChecksumSha256,outputFiles:result.outputs.size});
    console.log(JSON.stringify({format,rootRoute:true}));
  }
  const receipt={passed:true,imageDigest,exactUiStarters:true,results,awsRequests:0,publicationAuthorized:false};
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({output,...receipt}));
}catch(error){
  await writeFile(join(output,'failure.json'),JSON.stringify({imageDigest,message:error.message,results},null,2));
  console.error('Failure evidence: '+output);throw error;
}
