import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {it} from 'node:test';
import {artifactLeaseResolver} from '../src/artifact-lease-api.mjs';
import {RdsDataBuildRepository} from '../src/production-adapters.mjs';

it('uses only the configured HTTPS origin and a bounded, nonredirecting lease request', async()=>{
  assert.equal(artifactLeaseResolver(null),null);
  for(const origin of ['http://api.invalid','https://user:pass@api.invalid','https://api.invalid/path','https://api.invalid/?token=x']) {
    assert.throws(()=>artifactLeaseResolver(origin));
  }
  const request={buildJobId:randomUUID(),coordinatorToken:randomUUID(),authority:{organizationId:randomUUID(),userId:randomUUID()}};
  const calls=[];
  const resolve=artifactLeaseResolver('https://api.invalid',{fetchImpl:async(url,options)=>{
    calls.push({url,options});return new Response('[]',{status:200});
  }});
  assert.deepEqual(await resolve(request),[]);
  assert.equal(calls[0].url,`https://api.invalid/observable-build-leases/${request.buildJobId}/artifact-inputs`);
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body),{organization_id:request.authority.organizationId,
    user_id:request.authority.userId,coordinator_token:request.coordinatorToken});
  await assert.rejects(resolve({...request,buildJobId:'../elsewhere'}));assert.equal(calls.length,1);
  for(const status of [403,409,503]) {
    const failure=artifactLeaseResolver('https://api.invalid',{fetchImpl:async()=>new Response('{}',{status})});
    await assert.rejects(failure(request),error=>error.retryable===(status===503));
  }
  const oversized=artifactLeaseResolver('https://api.invalid',{fetchImpl:async()=>new Response(' '.repeat(65537))});
  await assert.rejects(oversized(request),/artifact_resolution_invalid/);
});

it('binds cached lease authority to its job token and releases a claimed job on context failure',async()=>{
  const [job,token,org,user,project,source,revision,input]=Array.from({length:8},()=>randomUUID());
  const authority={organizationId:org,userId:user,projectId:project,sourceProjectId:source,inputId:input,manifest:{artifacts:[]}};
  for(const invalid of [false,true]) {
    const calls=[],resolved=[];
    const repository=new RdsDataBuildRepository({execute:async(sql)=>{
      calls.push(sql);
      if(sql.includes('claim_observable')) return [['claimed',job,org,project,source,revision,1,'preview',
        {schemaVersion:'opengeo.observable-build-request.2.0.0'},'a'.repeat(64),{},'b'.repeat(64),'prefix/',1]];
      if(sql.includes('read_observable_artifact_lease')) return [[invalid?{...authority,userId:'invalid'}:authority]];
      if(sql.includes('release_observable')) return [['pending']];
      return [[true]];
    }},{artifactResolver:async args=>{resolved.push(args);return [];} });
    if(invalid) {
      await assert.rejects(repository.claim(job,token,900));
      assert.match(calls.at(-1),/release_observable/);assert.equal(resolved.length,0);
    } else {
      const claim=await repository.claim(job,token,900);assert.deepEqual(claim.artifactInputs,authority.manifest);
      await assert.rejects(repository.resolveArtifactInputs(job,randomUUID()));
      assert.deepEqual(await repository.resolveArtifactInputs(job,token),[]);
      assert.equal(resolved[0].authority.userId,user);
      assert.equal(calls.length,2,'Repeated resolution uses cached context and fresh API checks');
      await repository.complete(job,token,{});
      await assert.rejects(repository.resolveArtifactInputs(job,token));
    }
  }
});
