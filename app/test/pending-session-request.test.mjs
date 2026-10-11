import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pendingSessionRequest} from '../src/lib/pendingSessionRequest.js';
const deferred = () => {let resolve, reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('concurrent account reads share one flight, but settled results are never cached', async()=>{
 const pending=new Map(), d=deferred();let calls=0;
 const load=()=>{calls++;return d.promise;};
 const first=pendingSessionRequest(pending,'token/account',load);
 const second=pendingSessionRequest(pending,'token/account',load);
 d.resolve('session');assert.deepEqual(await Promise.all([first,second]),['session','session']);
 assert.equal(calls,1);assert.equal(pending.size,0);
 await pendingSessionRequest(pending,'token/account',load);assert.equal(calls,2);
});
test('canceling one consumer preserves others; canceling the last releases the request', async()=>{
 const pending=new Map(), d=deferred();let networkSignal;
 const load=signal=>{networkSignal=signal;return d.promise;};
 const a=new AbortController(), b=new AbortController();
 const first=pendingSessionRequest(pending,'scope',load,{signal:a.signal});
 const second=pendingSessionRequest(pending,'scope',load,{signal:b.signal});
 await Promise.resolve();a.abort();await assert.rejects(first,{name:'AbortError'});
 assert.equal(networkSignal.aborted,false);
 b.abort();await assert.rejects(second,{name:'AbortError'});
 assert.equal(networkSignal.aborted,true);assert.equal(pending.size,0);
 d.resolve('late');await Promise.resolve();
});
test('different identity/account keys remain isolated; failures do not poison retries',async()=>{
 const pending=new Map(), a=deferred(), b=deferred();
 const first=pendingSessionRequest(pending,'one',()=>a.promise);
 const second=pendingSessionRequest(pending,'two',()=>b.promise);
 a.reject(new Error('unavailable'));b.resolve('two');
 await assert.rejects(first,/unavailable/);assert.equal(await second,'two');
 assert.equal(await pendingSessionRequest(pending,'one',()=>Promise.resolve('retry')),'retry');
 assert.equal(pending.size,0);
});
test('API callers share transport but parse independent response bodies and recheck changed tokens',async()=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js');
 const d=deferred();let token='first', calls=0;
 const body={user_id:'10000000-0000-4000-8000-000000000001',email:'test@example.test',display_name:'Test',memberships:[],selected_organization_id:null,selected_organization_role:null};
 const client=new OpenGeoApiClient({tokenProvider:()=>token,fetchImplementation:async()=>{calls++;await d.promise;return Response.json(body);}});
 const a=client.getSession(), b=client.getSession();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 token='second';const c=client.getSession();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
 d.resolve();const results=await Promise.all([a,b,c]);
 assert.equal(results[0].userId,body.user_id);assert.deepEqual(results[0],results[1]);assert.notEqual(results[0],results[1]);
 await client.getSession();assert.equal(calls,3);
});

const sessionBody = userId => ({user_id:userId,email:'test@example.test',display_name:'Test',memberships:[],selected_organization_id:null,selected_organization_role:null});
const unavailableSession = () => Response.json({detail:'identity_store_unavailable'},{status:503});
function sessionRetryClock(t) {
 t.mock.timers.enable({apis:['setTimeout']});
 const scheduled=deferred(), setTimer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{
  const timer=setTimer(callback,milliseconds,...args);
  if(milliseconds===2000) scheduled.resolve();
  return timer;
 });
 return {scheduled:scheduled.promise,tick:milliseconds=>t.mock.timers.tick(milliseconds)};
}

test('cold session retries once after two seconds with the same authentication and account',async t=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js'), clock=sessionRetryClock(t), calls=[];
 let tokenReads=0;
 const client=new OpenGeoApiClient({tokenProvider:()=>{tokenReads++;return 'existing-token';},organizationProvider:()=> '10000000-0000-4000-8000-000000000002',fetchImplementation:async(url,options)=>{
  calls.push({url,headers:[...options.headers],method:options.method});
  return calls.length===1?unavailableSession():Response.json(sessionBody('10000000-0000-4000-8000-000000000001'));
 }});
 const result=client.getSession();await clock.scheduled;
 clock.tick(1999);assert.equal(calls.length,1);clock.tick(1);
 assert.equal((await result).userId,'10000000-0000-4000-8000-000000000001');
 assert.equal(tokenReads,1);assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
 assert.equal(client.pendingSessions.size,0);
});

test('a second unavailable session response ends the automatic recovery',async t=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js'), clock=sessionRetryClock(t);let calls=0;
 const client=new OpenGeoApiClient({tokenProvider:()=> 'existing-token',fetchImplementation:async()=>{calls++;return unavailableSession();}});
 const result=client.getSession();await clock.scheduled;clock.tick(2000);
 await assert.rejects(result,error=>error.status===503&&error.code==='identity_store_unavailable');
 clock.tick(20000);assert.equal(calls,2);assert.equal(client.pendingSessions.size,0);
});

test('session recovery does not retry unauthorized, unrelated, malformed or uncertain failures',async()=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js');
 for(const makeResponse of [()=>Response.json({detail:'authentication_required'},{status:401}),()=>Response.json({detail:'service_unavailable'},{status:503}),()=>new Response('invalid JSON',{status:503}),()=>{throw Error('uncertain transport');}]) {
  let calls=0;const client=new OpenGeoApiClient({tokenProvider:()=> 'existing-token',fetchImplementation:async()=>{calls++;return makeResponse();}});
  await assert.rejects(client.getSession());assert.equal(calls,1);assert.equal(client.pendingSessions.size,0);
 }
});

test('session recovery never replays writes, other reads or anonymous session requests',async()=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js');
 for(const [path,options] of [['/auth/session',{method:'POST',body:{}}],['/projects',{}],['/auth/session',{anonymous:true}]]) {
  let calls=0;const client=new OpenGeoApiClient({tokenProvider:()=> 'existing-token',organizationProvider:()=> '10000000-0000-4000-8000-000000000002',fetchImplementation:async()=>{calls++;return unavailableSession();}});
  await assert.rejects(client.request(path,options),error=>error.status===503);assert.equal(calls,1);
 }
});

test('canceling the last session consumer during resume delay prevents the retry',async t=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js'), clock=sessionRetryClock(t), controller=new AbortController();let calls=0,transportSignal;
 const client=new OpenGeoApiClient({tokenProvider:()=> 'existing-token',fetchImplementation:async(url,options)=>{calls++;transportSignal=options.signal;return unavailableSession();}});
 const result=client.getSession({signal:controller.signal});await clock.scheduled;controller.abort();
 await assert.rejects(result,{name:'AbortError'});assert.equal(transportSignal.aborted,true);
 clock.tick(20000);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(client.pendingSessions.size,0);
});

test('concurrent session consumers share recovery and one canceled caller leaves the other active',async t=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js'), clock=sessionRetryClock(t), controller=new AbortController();let calls=0,transportSignal;
 const client=new OpenGeoApiClient({tokenProvider:()=> 'existing-token',fetchImplementation:async(url,options)=>{calls++;transportSignal=options.signal;return calls===1?unavailableSession():Response.json(sessionBody('10000000-0000-4000-8000-000000000001'));}});
 const canceled=client.getSession({signal:controller.signal}), first=client.getSession(),second=client.getSession();await clock.scheduled;
 controller.abort();await assert.rejects(canceled,{name:'AbortError'});assert.equal(transportSignal.aborted,false);assert.equal(calls,1);
 clock.tick(2000);const results=await Promise.all([first,second]);
 assert.equal(calls,2);assert.deepEqual(results[0],results[1]);assert.notEqual(results[0],results[1]);assert.equal(client.pendingSessions.size,0);
});

test('changing token, account and endpoint during recovery keeps both session scopes separate',async t=>{
 const {OpenGeoApiClient}=await import('../src/lib/apiClient.js'), clock=sessionRetryClock(t), calls=[];
 let token='first-token',account='10000000-0000-4000-8000-000000000002';
 const client=new OpenGeoApiClient({baseUrl:'/first-api',tokenProvider:()=>token,organizationProvider:()=>account,fetchImplementation:async(url,options)=>{
  calls.push({url,token:options.headers.get('authorization'),account:options.headers.get('x-opengeo-organization')});
  return calls.length===1?unavailableSession():Response.json(sessionBody(options.headers.get('authorization')==='Bearer first-token'?'10000000-0000-4000-8000-000000000001':'10000000-0000-4000-8000-000000000003'));
 }});
 const original=client.getSession();await clock.scheduled;
 token='second-token';account='10000000-0000-4000-8000-000000000004';client.baseUrl='/second-api';
 assert.equal((await client.getSession()).userId,'10000000-0000-4000-8000-000000000003');
 assert.equal(calls.length,2);clock.tick(2000);
 assert.equal((await original).userId,'10000000-0000-4000-8000-000000000001');
 assert.deepEqual(calls[2],calls[0]);assert.equal(calls[1].url,'/second-api/auth/session');assert.equal(calls[1].token,'Bearer second-token');assert.equal(calls[1].account,'10000000-0000-4000-8000-000000000004');assert.equal(client.pendingSessions.size,0);
});
