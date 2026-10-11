import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {retainArtifactOutputs} from '../src/artifact-output.mjs';
test('retains exact source-root assets and rejects page collisions and symlink parents',()=>{
 const root=mkdtempSync(join(tmpdir(),'artifact-output-'));
 try {
  const outputRoot=join(root,'dist'),bytes=Buffer.from('<h1>Retained</h1>');
  const file={path:'src/maps/survey.html',sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')};
  const args={files:[file],inputRoot:root,outputRoot,prefix:'src/',readExact:()=>bytes};
  retainArtifactOutputs(args);assert.deepEqual(readFileSync(join(outputRoot,'maps/survey.html')),bytes);
  retainArtifactOutputs(args);
  writeFileSync(join(outputRoot,'maps/survey.html'),'generated page');assert.throws(()=>retainArtifactOutputs(args),/collision/);
  rmSync(join(outputRoot,'maps'),{recursive:true});mkdirSync(join(root,'elsewhere'));symlinkSync(join(root,'elsewhere'),join(outputRoot,'maps'));
  assert.throws(()=>retainArtifactOutputs(args),/collision/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
