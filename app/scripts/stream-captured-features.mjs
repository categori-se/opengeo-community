// Operator-only streaming of exact captured GeoJSON; no GDAL reserialization.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export async function capturedSha256(path) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function* streamCapturedFeatures(path, {maximumValueMiB = 64} = {}) {
  assert.ok(Number.isInteger(maximumValueMiB) && maximumValueMiB >= 64 && maximumValueMiB <= 512);
  // Only descend the root features array, retaining nested attributes and nulls.
  const child=spawn('/usr/bin/python3',[
    fileURLToPath(new URL('../../scripts/stream-captured-features.py',import.meta.url)),path,
    '--maximum-value-mib', String(maximumValueMiB)],
    {stdio:['ignore','pipe','pipe'],timeout:1800000});
  let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4000);});
  const completion=new Promise(resolve=>{
    child.once('error',error=>resolve({error}));
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  try {
    for await(const line of lines) {
      assert.ok(line.length<maximumValueMiB*1024**2,'Individual feature exceeds review limit');
      const feature=JSON.parse(line);
      assert.equal(feature.type,'Feature');
      assert.ok(feature.properties&&typeof feature.properties==='object');
      yield feature;
    }
    const result=await completion;
    assert.equal(result.error,undefined,String(result.error));
    assert.equal(result.code,0,`Capture streaming failed (${result.signal}): ${diagnostic}`);
  } finally {
    lines.close();
    if(child.exitCode===null) child.kill();
    await completion;
  }
}
