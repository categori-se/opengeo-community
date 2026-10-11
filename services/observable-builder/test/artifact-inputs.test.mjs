import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it} from 'node:test';
import {compilePortableMapArtifact} from '../../../app/src/lib/portableMapArtifact.js';
import {parseInvocation, inspectInputs, runBuild, DISTRIBUTION_INVOCATION_SCHEMA, DISTRIBUTION_REQUEST_SCHEMA} from '../src/contract.mjs';
import {ARTIFACT_INVOCATION_SCHEMA, ARTIFACT_REQUEST_SCHEMA, artifactChecksum} from '../src/artifact-inputs.mjs';
import {jsonbText} from '../../observable-coordinator/src/contracts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function sample() {
  const artifact = await compilePortableMapArtifact({title:'Retained survey',runtimeJs:'/* synthetic runtime */',runtimeCss:'body{}',runtimeLicense:'BSD',
    candidates:[{id:'sites',sourceId:'sites',title:'Sites',visible:true,paintOrder:{sites:0},
      source:{type:'geojson',data:{type:'FeatureCollection',features:[]}},paints:[{id:'sites',source:'sites',type:'circle'}]}],selectedIds:['sites']});
  const index = '<!doctype html><title>Survey report</title><iframe src="maps/survey.html" sandbox="allow-scripts"></iframe>';
  const source = randomUUID(), revision = randomUUID();
  const manifest = {schemaVersion:'opengeo.publication-artifact-inputs.1.0.0',sourceProjectId:source,
    sourceRevisionId:revision,sourceManifestChecksumSha256:'a'.repeat(64),referenceRevision:1,
    artifacts:[{path:'maps/survey.html',artifactId:randomUUID(),version:2,outputObjectId:randomUUID(),
      manifestChecksumSha256:artifact.manifest.manifestChecksumSha256,output:artifact.manifest.output}]};
  assert.equal(artifactChecksum(manifest),sha(jsonbText(manifest)));
  const request = {schemaVersion:ARTIFACT_REQUEST_SCHEMA,sourceProjectId:source,sourceRevisionId:revision,
    sourceRevisionNumber:1,sourceManifestChecksumSha256:manifest.sourceManifestChecksumSha256,
    artifactInputsChecksumSha256:artifactChecksum(manifest),purpose:'preview',compilerImageDigest:`sha256:${'b'.repeat(64)}`,
    frameworkVersion:'1.13.4',lockfileFormat:'npm-package-lock-v3',lockfileChecksumSha256:null,networkPolicy:'deny_all',
    resourceLimits:{cpuMillis:1000,memoryMiB:1024,timeoutSeconds:60,maxInputFiles:128,maxInputBytes:16777216,maxOutputFiles:512,maxOutputBytes:33554432}};
  return {artifact,index,invocation:{schemaVersion:ARTIFACT_INVOCATION_SCHEMA,buildJobId:randomUUID(),request,
    requestChecksumSha256:artifactChecksum(request),inputManifestChecksumSha256:manifest.sourceManifestChecksumSha256,
    artifactInputs:manifest,entryPath:'index.html',lockfilePath:null,dataFiles:[],
    files:[{path:'index.html',contentType:'text/html',sizeBytes:Buffer.byteLength(index),checksumSha256:sha(index)}]}};
}

it('compiles a Publication with the exact retained browser Artifact without rebuilding that Artifact', async () => {
  const {artifact,index,invocation}=await sample();
  const root=mkdtempSync(join(tmpdir(),'opengeo-artifact-compiler-'));
  try {
    const inputs=join(root,'inputs');mkdirSync(join(inputs,'maps'),{recursive:true});
    writeFileSync(join(inputs,'index.html'),index);writeFileSync(join(inputs,'maps/survey.html'),artifact.html);
    const parsed=inspectInputs(invocation,inputs);
    assert.equal(parsed.allFiles.length,2);
    const report=runBuild({invocation,inputRoot:inputs,workspaceRoot:join(root,'workspace')});
    assert.equal(readFileSync(join(root,'workspace/dist/maps/survey.html'),'utf8'),artifact.html);
    assert.equal(report.validationReport.inputFileCount,2);
    assert.equal(report.validationReport.publicationAuthorized,false);
    assert.equal(report.requestChecksumSha256,invocation.requestChecksumSha256);
    assert.equal(report.outputManifest.files.find(file=>file.path==='dist/maps/survey.html').checksumSha256,
      artifact.manifest.output.checksumSha256);
    writeFileSync(join(inputs,'maps/survey.html'),artifact.html.replace('Retained survey','Changed survey'));
    assert.throws(()=>inspectInputs(invocation,inputs));
  } finally {rmSync(root,{recursive:true,force:true});}
});

it('rejects altered pins, request seals, public release, collisions and excessive inputs', async () => {
  const {invocation}=await sample();
  for (const mutate of [
    value=>{value.artifactInputs.artifacts[0].version++;},
    value=>{value.request.artifactInputsChecksumSha256='f'.repeat(64);},
    value=>{value.requestChecksumSha256='f'.repeat(64);},
    value=>{value.artifactInputs.extra='unsealed';},
    value=>{value.artifactInputs.artifacts[0].output.url='https://signed.invalid';},
  ]) {
    const changed=structuredClone(invocation);mutate(changed);
    assert.throws(()=>parseInvocation(changed));
  }
  for (const mutate of [
    value=>{value.request.purpose='release_candidate';},
    value=>{value.artifactInputs.artifacts[0].path='index.html';},
    value=>{value.request.resourceLimits.maxInputFiles=1;},
    value=>{value.request.resourceLimits.maxInputBytes=100;},
  ]) {
    const changed=structuredClone(invocation);mutate(changed);
    changed.request.artifactInputsChecksumSha256=artifactChecksum(changed.artifactInputs);
    changed.requestChecksumSha256=artifactChecksum(changed.request);
    assert.throws(()=>parseInvocation(changed));
  }
});

it('admits an approval-bound Artifact release only through the new sealed invocation', async () => {
  const {invocation} = await sample();
  invocation.schemaVersion = DISTRIBUTION_INVOCATION_SCHEMA;
  Object.assign(invocation.request, {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA, purpose: 'release_candidate',
    outputProfile: 'default-32m', sizeAcknowledgment: null, distributionApprovalId: randomUUID(),
    distributionApprovalChecksumSha256: 'd'.repeat(64)});
  invocation.requestChecksumSha256 = artifactChecksum(invocation.request);
  assert.equal(parseInvocation(invocation).allFiles.length, 2);
  for (const field of ['distributionApprovalId', 'distributionApprovalChecksumSha256']) {
    const changed = structuredClone(invocation); changed.request[field] = null;
    changed.requestChecksumSha256 = artifactChecksum(changed.request);
    assert.throws(() => parseInvocation(changed), /distribution_request_invalid/);
  }
  const tampered = structuredClone(invocation); tampered.request.distributionApprovalId = randomUUID();
  assert.throws(() => parseInvocation(tampered), /artifact_request_checksum_mismatch/);
});
