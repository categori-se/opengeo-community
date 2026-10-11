// A leased, checksum-verified range source. Construct only after explicit archive use.
import {matchesReviewedDisplay} from './reviewedDisplayIdentity.js';
const BLOCK = 65536, LIMIT = 64 * 1024 ** 2, RESPONSE = 8 * 1024 ** 2;
const ARCHIVE_LIMIT = 2 * 1024 ** 3;
export function createReviewedArchiveReadBudget() {
  let requests=0, bytes=0;
  return {reserve(size) {
    if (!Number.isSafeInteger(size) || size<=0 || requests>=256 || bytes+size>LIMIT)
      throw Error('Archive shared read budget reached. Select the copy again to continue.');
    requests++; bytes+=size;
  }, stats:()=>({requests,requestedBytes:bytes})};
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
function ticketUrl(object, ticket) {
  const url = new URL(ticket?.url);
  if (ticket.method !== 'GET' || url.origin !== 'https://s3.us-east-1.amazonaws.com'
    || url.username || url.password || url.hash || !url.searchParams.has('X-Amz-Signature')
    || decodeURIComponent(url.pathname) !== `/${object.bucket}/${object.key}`
    || !object.version_id || object.version_id === 'null' || /[\x00-\x1f\x7f]/.test(object.version_id)
    || url.searchParams.get('versionId') !== object.version_id
    || !ticket.headers || Object.keys(ticket.headers).some(key => key !== 'x-amz-expected-bucket-owner')
    || !/^[0-9]{12}$/.test(object.expected_owner)
    || ticket.headers['x-amz-expected-bucket-owner'] !== object.expected_owner) throw Error('Invalid archive read ticket.');
  return url;
}
export function createReviewedArchiveRangeSource({record, layer, assertScope = async () => {}, budget = null,
  fetchImpl = globalThis.fetch, onProgress = () => {}, onError = () => {}, signal,
  now = () => Date.now()}) {
  const obj = record?.objects?.[0];
  const index = obj?.block_index;
  const validIndex = index && obj.block_sha256 == null && typeof obj.prefix === 'string'
    && obj.prefix.endsWith('/') && typeof index.key === 'string' && index.key.startsWith(obj.prefix)
    && index.key !== obj.key && !index.key.split('/').some(part => ['', '.', '..'].includes(part))
    && !/[\x00-\x1f\x7f\\]/.test(index.key) && hash(index.sha256)
    && Number.isSafeInteger(index.size_bytes) && index.size_bytes >= 32 && index.size_bytes <= 1024 ** 2
    && index.size_bytes === Math.ceil(obj.size_bytes / BLOCK) * 32;
  if (record?.format !== 'pmtiles' || !matchesReviewedDisplay(record, layer, {ticket: true})
    || record.objects.length !== 1 || !Number.isSafeInteger(obj?.size_bytes)
    || obj.size_bytes < 127 || obj.size_bytes > (index ? ARCHIVE_LIMIT : LIMIT) || obj.encoding !== 'identity'
    || obj.decoded_size_bytes !== obj.size_bytes || obj.decoded_sha256 !== obj.sha256
    || !hash(obj.sha256) || (index ? !validIndex : (!Array.isArray(obj.block_sha256)
      || obj.block_sha256.length !== Math.ceil(obj.size_bytes / BLOCK) || !obj.block_sha256.every(hash)))
    || record.download_bytes !== obj.size_bytes || record.range_block_bytes !== BLOCK
    || record.range_limits?.requests !== 256 || record.range_limits?.bytes !== LIMIT
    || record.range_limits?.seconds !== 300 || record.range_limits?.response_bytes !== RESPONSE) {
    throw Error('Invalid reviewed tile archive inventory.');
  }
  const ticket = obj.ticket, url = ticketUrl(obj, ticket);
  const indexUrl = index ? ticketUrl({...obj, ...index}, index.ticket) : null;
  let blocks = obj.block_sha256;
  const controller = new AbortController(), deadline = now() + 300000;
  let requests = 0, requestedBytes = 0, downloaded = 0, closed = false, queue = Promise.resolve();
  const cache = new Map(), key = `https://opengeo-archive.invalid/${crypto.randomUUID()}`;
  function dispose(reason = new DOMException('Archive session closed.', 'AbortError')) {
    if (closed) return; closed = true; controller.abort(reason); clearTimeout(timer); cache.clear(); blocks = null;
    signal?.removeEventListener('abort', abortParent);
  }
  const abortParent = () => dispose(signal.reason);
  const timer = setTimeout(() => {
    const error = new Error('Archive read session expired. Select the copy again to continue.');
    dispose(error); onError(error);
  },300000);
  signal?.addEventListener('abort', abortParent, {once:true});
  if (signal?.aborted) dispose(signal.reason);
  const check = async caller => {
    controller.signal.throwIfAborted(); caller?.throwIfAborted();
    if (closed || now() >= deadline) throw Error('Archive read session expired.');
    await assertScope(); controller.signal.throwIfAborted(); caller?.throwIfAborted();
  };
  async function loadIndex(caller) {
    if (blocks) return;
    await check(caller);
    // The checksum inventory shares the same consent, lifetime and cumulative
    // network budget as the map ranges. It is never fetched by metadata listing.
    if (++requests > 256 || requestedBytes + index.size_bytes > LIMIT) throw Error('Archive read budget reached.');
    budget?.reserve(index.size_bytes);
    requestedBytes += index.size_bytes;
    const request = new AbortController(), abort = () => request.abort();
    controller.signal.addEventListener('abort', abort, {once:true}); caller?.addEventListener('abort', abort, {once:true});
    const timeout = setTimeout(abort,20000);
    try {
      const response = await fetchImpl(indexUrl.href, {method:'GET', headers:index.ticket.headers,
        credentials:'omit', redirect:'error', cache:'no-store', signal:request.signal});
      if (response.status !== 200 || response.redirected || (response.url && response.url !== indexUrl.href)
        || response.headers.get('x-amz-version-id') !== index.version_id || !response.body) {
        await response.body?.cancel(); throw Error('Archive block index version verification failed.');
      }
      const reader=response.body.getReader(), body=new Uint8Array(index.size_bytes); let received=0;
      try {while(true) {
        await check(caller); request.signal.throwIfAborted(); const {done,value}=await reader.read(); if(done)break;
        if(received+value.byteLength>body.byteLength)throw Error('Archive block index exceeds its reviewed size.');
        body.set(value,received);received+=value.byteLength;
      }} finally {await reader.cancel().catch(()=>{});}
      if(received!==body.byteLength || await digest(body)!==index.sha256)throw Error('Archive block index checksum verification failed.');
      await check(caller);
      blocks=Array.from({length:body.byteLength/32},(_,i)=>Array.from(body.subarray(i*32,(i+1)*32),v=>v.toString(16).padStart(2,'0')).join(''));
      downloaded+=body.byteLength;onProgress({downloaded,total:obj.size_bytes+index.size_bytes,requests});
    } finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',abort);caller?.removeEventListener('abort',abort);}
  }
  async function read(offset,length,caller,etag) {
    await check(caller);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
      || offset >= obj.size_bytes || length > RESPONSE || (etag && etag !== obj.sha256)) throw Error('Invalid archive byte range.');
    // HTTP ranges may extend beyond EOF; PMTiles initially asks for 16 KiB even
    // when a complete small archive is shorter than that.
    length = Math.min(length, obj.size_bytes - offset);
    const first = Math.floor(offset/BLOCK), last = Math.floor((offset+length-1)/BLOCK);
    if (last-first+1 > RESPONSE/BLOCK) throw Error('Archive range exceeds the response limit.');
    await loadIndex(caller);
    if (Array.from({length:last-first+1},(_,i)=>first+i).some(index=>!cache.has(index))) {
      const low = first*BLOCK, high = Math.min(obj.size_bytes,(last+1)*BLOCK)-1, size = high-low+1;
      if (++requests > 256 || requestedBytes + size > LIMIT) throw Error('Archive read budget reached. Select the copy again to continue.');
      budget?.reserve(size);
      requestedBytes += size;
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort',abort,{once:true});caller?.addEventListener('abort',abort,{once:true});
      const timeout = setTimeout(abort,20000);
      try {
        const response = await fetchImpl(url.href,{method:'GET',headers:{...ticket.headers,Range:`bytes=${low}-${high}`},
          credentials:'omit',redirect:'error',cache:'no-store',signal:request.signal});
        if (response.status !== 206 || response.redirected || (response.url && response.url !== url.href)
          || response.headers.get('content-range') !== `bytes ${low}-${high}/${obj.size_bytes}`
          || response.headers.get('x-amz-version-id') !== obj.version_id || !response.body) {
          await response.body?.cancel();throw Error('Archive range or version verification failed.');
        }
        const reader = response.body.getReader(), body = new Uint8Array(size);let received=0;
        try {while(true){await check(caller);request.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
          if(received+value.byteLength>size)throw Error('Archive range response is too large.');body.set(value,received);received+=value.byteLength;
        }} finally {await reader.cancel().catch(()=>{});}
        if(received!==size)throw Error('Archive range response was incomplete.');
        const verified=[];
        for(let index=first;index<=last;index++){
          const block=body.slice((index-first)*BLOCK,Math.min(size,(index-first+1)*BLOCK));
          if(await digest(block)!==blocks[index])throw Error('Archive block checksum verification failed.');
          verified.push([index,block]);
        }
        await check(caller);for(const [index,block] of verified)cache.set(index,block);
        downloaded+=size;onProgress({downloaded,total:obj.size_bytes+(index?.size_bytes??0),requests});
      } finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',abort);caller?.removeEventListener('abort',abort);}
    }
    await check(caller);
    const result=new Uint8Array(length);let written=0;
    for(let index=first;index<=last;index++){
      const low=Math.max(offset,index*BLOCK)-index*BLOCK,high=Math.min(offset+length,(index+1)*BLOCK)-index*BLOCK;
      const part=cache.get(index).subarray(low,high);result.set(part,written);written+=part.length;
    }
    return {data:result.buffer,etag:obj.sha256};
  }
  return {getKey:()=>key,dispose,stats:()=>({requests,requestedBytes,downloaded,closed}),
    getBytes(offset,length,caller,etag){
      const operation=queue.then(()=>read(offset,length,caller,etag)).catch(error=>{
        if(!caller?.aborted&&!closed){dispose(error);onError(error);}throw error;
      });queue=operation.catch(()=>{});return operation;
    }};
}
