import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createReviewedArchiveRangeSource,createReviewedArchiveReadBudget} from '../src/lib/reviewedArchiveRange.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(size = 65536*2+17){
 const bytes=Buffer.alloc(size);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const obj={bucket:'private-fixture',key:'reviewed/map.pmtiles',prefix:'reviewed/',version_id:'version-one',expected_owner:'123456789012',
  size_bytes:bytes.length,decoded_size_bytes:bytes.length,sha256:sha(bytes),decoded_sha256:sha(bytes),encoding:'identity',
  block_sha256:Array.from({length:Math.ceil(bytes.length/65536)},(_,i)=>sha(bytes.subarray(i*65536,(i+1)*65536))),
  ticket:{method:'GET',url:'https://s3.us-east-1.amazonaws.com/private-fixture/reviewed/map.pmtiles?versionId=version-one&X-Amz-Signature=fixture',headers:{'x-amz-expected-bucket-owner':'123456789012'}}};
 const layer={datasetId:'layer',sourceVersion:2,sourceUrl:'https://provider.invalid/MapServer/4'};
 const record={format:'pmtiles',dataset_id:'layer',source_version:2,source_url:layer.sourceUrl,objects:[obj],download_bytes:bytes.length,
  range_block_bytes:65536,range_limits:{requests:256,bytes:64*1024**2,seconds:300,response_bytes:8*1024**2}};
 let calls=0;const fetchImpl=async(url,options)=>{calls++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  const [low,high]=options.headers.Range.slice(6).split('-').map(Number);
  return new Response(bytes.subarray(low,high+1),{status:206,headers:{'content-range':`bytes ${low}-${high}/${bytes.length}`,'x-amz-version-id':'version-one'}});
 };
 return {bytes,obj,layer,record,fetchImpl,calls:()=>calls};
}

test('two archive objects share the same request budget, including cached reads',async()=>{
 const budget=createReviewedArchiveReadBudget(),a=fixture(129*65536),b=fixture(129*65536);
 const first=createReviewedArchiveRangeSource({...a,budget}),second=createReviewedArchiveRangeSource({...b,budget});
 try{
  for(let i=0;i<128;i++){await first.getBytes(i*65536,1);await second.getBytes(i*65536,1);}
  await first.getBytes(0,1);assert.equal(budget.stats().requests,256);
  await assert.rejects(second.getBytes(128*65536,1),/shared read budget/);
  assert.equal(a.calls()+b.calls(),256);
 }finally{first.dispose();second.dispose();}
});

test('shared byte reservation rejects overflow before either object can fetch',()=>{
 const budget=createReviewedArchiveReadBudget();for(let i=0;i<8;i++)budget.reserve(8*1024**2);
 assert.throws(()=>budget.reserve(1),/shared read budget/);
 assert.equal(budget.stats().requestedBytes,64*1024**2);
});

test('no reads before use; aligned verified blocks are cached and sliced exactly',async()=>{
 const f=fixture(),source=createReviewedArchiveRangeSource(f);assert.equal(f.calls(),0);
 try{const a=await source.getBytes(65530,30);assert.deepEqual(Buffer.from(a.data),f.bytes.subarray(65530,65560));
  assert.equal(f.calls(),1);assert.equal(source.stats().downloaded,131072);
  const b=await source.getBytes(2,10);assert.deepEqual(Buffer.from(b.data),f.bytes.subarray(2,12));assert.equal(f.calls(),1);
  const c=await source.getBytes(131072,17);assert.deepEqual(Buffer.from(c.data),f.bytes.subarray(131072));assert.equal(f.calls(),2);
  assert.ok(!source.getKey().includes('X-Amz')&&!source.getKey().includes(f.obj.key));
 }finally{source.dispose();}
 await assert.rejects(source.getBytes(0,1));assert.equal(f.calls(),2);
});

for(const fault of ['version','range','bytes','oversize','truncated','full-response'])test(`rejects ${fault} before returning unverified data`,async()=>{
 const f=fixture();let errors=0;
 const source=createReviewedArchiveRangeSource({...f,onError:()=>errors++,fetchImpl:async()=>{
  let bytes=f.bytes.subarray(0,65536);if(fault==='bytes')bytes=Buffer.alloc(65536,255);
  if(fault==='oversize')bytes=f.bytes.subarray(0,65537);if(fault==='truncated')bytes=bytes.subarray(0,65535);
  return new Response(bytes,{status:fault==='full-response'?200:206,headers:{'content-range':fault==='range'?'bytes 1-65536/131089':'bytes 0-65535/131089','x-amz-version-id':fault==='version'?'other-version':'version-one'}});
 }});
 await assert.rejects(source.getBytes(0,10));assert.equal(errors,1);assert.equal(source.stats().closed,true);
 await assert.rejects(source.getBytes(0,10));
});

test('scope failure and expiry stop reads before storage',async()=>{
 for(const expired of [false,true]){const f=fixture();let time=0;
  const source=createReviewedArchiveRangeSource({...f,now:()=>time,assertScope:async()=>{if(!expired)throw Error('revoked');}});
  time=expired?300001:0;await assert.rejects(source.getBytes(0,10));assert.equal(f.calls(),0);source.dispose();
 }
});

test('cancellation aborts the active storage request',async()=>{
 const f=fixture();let pending,started;
 const ready=new Promise(resolve=>started=resolve);
 const source=createReviewedArchiveRangeSource({...f,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{pending=signal;signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));started();})});
 const result=source.getBytes(0,10);await ready;source.dispose();await assert.rejects(result);assert.ok(pending.aborted);
});

test('metadata cannot expand budgets or select a different source/version',()=>{
 for(const change of [f=>f.record.range_limits.bytes++,f=>f.record.source_version++,f=>f.obj.block_sha256.pop(),f=>f.obj.ticket.url=f.obj.ticket.url.replace('version-one','other')]){
  const f=fixture();change(f);assert.throws(()=>createReviewedArchiveRangeSource(f));assert.equal(f.calls(),0);
 }
});


test('request and cumulative byte budgets stop before the excess request',async()=>{
 for(const budget of ['requests','bytes']){
  const f=fixture(budget==='requests'?257*65536:9*1024**2);
  const source=createReviewedArchiveRangeSource(f);
  const count=budget==='requests'?256:8, length=budget==='requests'?1:8*1024**2;
  for(let i=0;i<count;i++) await source.getBytes(i*65536,length);
  await assert.rejects(source.getBytes(count*65536,length),/budget/);
  assert.equal(f.calls(),count);assert.equal(source.stats().closed,true);
 }
});

function indexedFixture(size=2*1024**3) {
 const f=fixture(),block=Buffer.alloc(65536,7),blockHash=sha(block);
 const indexBody=Buffer.concat(Array.from({length:Math.ceil(size/65536)},()=>Buffer.from(blockHash,'hex')));
 const index={key:'reviewed/map.blocks',version_id:'index-one',size_bytes:indexBody.length,sha256:sha(indexBody),
  ticket:{method:'GET',url:'https://s3.us-east-1.amazonaws.com/private-fixture/reviewed/map.blocks?versionId=index-one&X-Amz-Signature=fixture',headers:{'x-amz-expected-bucket-owner':'123456789012'}}};
 f.obj.size_bytes=f.obj.decoded_size_bytes=f.record.download_bytes=size;delete f.obj.block_sha256;f.obj.block_index=index;
 let calls=0;
 return {...f,indexBody,block,index,calls:()=>calls,fetchImpl:async(url,options)=>{
  calls++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  if(url===index.ticket.url){assert.equal(options.headers.Range,undefined);return new Response(indexBody,{status:200,headers:{'x-amz-version-id':'index-one'}});}
  const [low,high]=options.headers.Range.slice(6).split('-').map(Number);assert.equal(high-low+1,65536);
  return new Response(block,{status:206,headers:{'content-range':`bytes ${low}-${high}/${size}`,'x-amz-version-id':'version-one'}});
 }};
}

test('a two-GiB inventory reads only its verified index and requested viewport block',async()=>{
 const f=indexedFixture(),source=createReviewedArchiveRangeSource(f);assert.equal(f.calls(),0);
 try {
  const result=await source.getBytes(1024**3+7,12);assert.deepEqual(Buffer.from(result.data),f.block.subarray(7,19));
  assert.equal(f.calls(),2);assert.equal(source.stats().requestedBytes,1024**2+65536);
  await source.getBytes(1024**3+8,3);assert.equal(f.calls(),2);
 } finally {source.dispose();}
});

for(const fault of ['checksum','version','oversize','truncated','redirect'])test(`rejects index ${fault} before fetching map data`,async()=>{
 const f=indexedFixture();let calls=0;
 const source=createReviewedArchiveRangeSource({...f,fetchImpl:async()=>{
  calls++;let body=f.indexBody;if(fault==='checksum')body=Buffer.alloc(body.length);
  if(fault==='oversize')body=Buffer.concat([body,Buffer.from([0])]);if(fault==='truncated')body=body.subarray(1);
  const response=new Response(body,{status:200,headers:{'x-amz-version-id':fault==='version'?'other':'index-one'}});
  if(fault==='redirect')Object.defineProperty(response,'redirected',{value:true});return response;
 }});
 await assert.rejects(source.getBytes(0,1));assert.equal(calls,1);assert.equal(source.stats().closed,true);
});

test('indexed reads cannot expand the request budget',async()=>{
 const f=indexedFixture(),source=createReviewedArchiveRangeSource(f);
 try {for(let i=0;i<255;i++)await source.getBytes(i*65536,1);
  await assert.rejects(source.getBytes(255*65536,1),/budget/);assert.equal(f.calls(),256);
 }finally{source.dispose();}
});

test('checksum index must stay in the reviewed prefix and have the exact inventory length',()=>{
 for(const mutate of [f=>f.index.key='outside/map.blocks',f=>f.index.size_bytes-=32,
  f=>f.index.ticket.url=f.index.ticket.url.replace('index-one','different'),f=>f.obj.block_sha256=['a'.repeat(64)]]){
  const f=indexedFixture();mutate(f);assert.throws(()=>createReviewedArchiveRangeSource(f));assert.equal(f.calls(),0);
 }
});

test('checksum-index bytes count against the existing cumulative download ceiling',async()=>{
 const f=indexedFixture();let calls=0;
 const source=createReviewedArchiveRangeSource({...f,fetchImpl:async(url,options)=>{
  calls++;
  if(url===f.index.ticket.url)return f.fetchImpl(url,options);
  const [low,high]=options.headers.Range.slice(6).split('-').map(Number);
  return new Response(Buffer.alloc(high-low+1,7),{status:206,headers:{'content-range':`bytes ${low}-${high}/${f.obj.size_bytes}`,'x-amz-version-id':'version-one'}});
 }});
 try {
  for(let i=0;i<7;i++)await source.getBytes(i*8*1024**2,8*1024**2);
  await assert.rejects(source.getBytes(7*8*1024**2,8*1024**2),/budget/);
  assert.equal(calls,8);assert.equal(source.stats().downloaded,57*1024**2);
 }finally{source.dispose();}
});

test('cancellation interrupts checksum-index loading before any tile request',async()=>{
 const f=indexedFixture();let ready,requestSignal,calls=0;
 const started=new Promise(resolve=>ready=resolve);
 const source=createReviewedArchiveRangeSource({...f,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{
  calls++;assert.equal(url,f.index.ticket.url);requestSignal=signal;
  signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));ready();
 })});
 const pending=source.getBytes(0,1);await started;source.dispose();await assert.rejects(pending);
 assert.equal(calls,1);assert.equal(requestSignal.aborted,true);
});

test('managed tiled reads bind exact versions without inventing provider identities',async()=>{
 const f=fixture();
 f.layer={datasetId:'layer',sourceType:'governed-dataset',datasetVersionId:'saved-version'};
 delete f.record.source_version;delete f.record.source_url;f.record.dataset_version_id='saved-version';
 const source=createReviewedArchiveRangeSource(f);
 try{await source.getBytes(0,10);assert.equal(f.calls(),1);}finally{source.dispose();}
 for(const record of [{...f.record,dataset_version_id:'different'},{...f.record,source_version:2},
   {...f.record,source_url:'https://provider.invalid'}, {...f.record,dataset_id:'other'}]){
   assert.throws(()=>createReviewedArchiveRangeSource({...f,record}),/inventory/);
 }
 assert.throws(()=>createReviewedArchiveRangeSource({...f,layer:{datasetId:'layer'}}),/inventory/);
});
