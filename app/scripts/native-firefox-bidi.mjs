import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';

// Derived from the frozen, accepted local availability client; no browser download.
export const nativeFirefoxProfile='/tmp/opengeo-structural-firefox-20261027/profile';
const delay=milliseconds=>new Promise(done=>setTimeout(done,milliseconds));
const size=path=>!existsSync(path)?0:statSync(path).isDirectory()
  ?readdirSync(path).reduce((total,name)=>total+size(join(path,name)),0):statSync(path).size;
const alive=pid=>{try{process.kill(-pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const signal=(pid,name)=>{try{process.kill(-pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};
const prefs={
  'network.proxy.type':1,'network.proxy.http':'127.0.0.1','network.proxy.http_port':9,
  'network.proxy.ssl':'127.0.0.1','network.proxy.ssl_port':9,
  'network.proxy.socks':'127.0.0.1','network.proxy.socks_port':9,'network.proxy.socks_version':5,
  'network.proxy.socks_remote_dns':true,'network.proxy.failover_direct':false,'network.proxy.allow_bypass':false,
  'network.proxy.no_proxies_on':'127.0.0.1','network.trr.mode':5,
  'network.dns.disablePrefetch':true,'network.prefetch-next':false,'network.predictor.enabled':false,
  'network.http.speculative-parallel-limit':0,'network.http.http3.enable':false,
  'media.peerconnection.enabled':false,'app.update.auto':false,'app.update.enabled':false,
  'app.shield.optoutstudies.enabled':false,'extensions.update.enabled':false,
  'extensions.systemAddon.update.enabled':false,'browser.search.update':false,
  'browser.safebrowsing.downloads.enabled':false,'browser.safebrowsing.malware.enabled':false,
  'browser.safebrowsing.phishing.enabled':false,'toolkit.telemetry.enabled':false,
  'datareporting.healthreport.uploadEnabled':false,'datareporting.policy.dataSubmissionEnabled':false,
  'network.captive-portal-service.enabled':false,'network.connectivity-service.enabled':false,
  'browser.startup.homepage':'about:blank','browser.startup.page':0,
  'browser.cache.disk.enable':false,'browser.cache.offline.enable':false,
  'browser.sessionstore.resume_from_crash':false,'browser.shell.checkDefaultBrowser':false
};

export function command(client,method,params={},timeoutMilliseconds=client.deadline-Date.now()) {
  assert.ok(client.commands<client.maxCommands,'Cumulative BiDi command ceiling');client.commands++;
  if(!['network.continueRequest','network.failRequest'].includes(method))
    assert.ok(++client.actionCommands<=client.maxActionCommands,'BiDi action/evaluation ceiling');
  assert.ok(timeoutMilliseconds>0,'Firefox active deadline');
  const id=++client.sequence;
  return new Promise((done,reject)=>{
    const timer=setTimeout(()=>{client.pending.delete(id);reject(Error(`BiDi timeout: ${method}`));},timeoutMilliseconds);
    client.pending.set(id,{done:value=>{clearTimeout(timer);done(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    try{client.socket.send(JSON.stringify({id,method,params}));}
    catch(error){client.pending.get(id).reject(error);client.pending.delete(id);}
  });
}

export async function openNativeFirefox({profilePath=nativeFirefoxProfile,activeMilliseconds=20000,maxCommands=12,
  maxActionCommands=Math.min(250,maxCommands),started=Date.now(),capabilities={},onSpawn=()=>{}}={}) {
  assert.ok(activeMilliseconds>0&&activeMilliseconds<=80000,'Firefox active budget');
  assert.ok(Number.isSafeInteger(maxCommands)&&maxCommands>0&&maxCommands<=900,'BiDi command budget');
  assert.ok(Number.isSafeInteger(maxActionCommands)&&maxActionCommands>0&&maxActionCommands<=250,'BiDi action budget');
  assert.ok(!existsSync(profilePath),'Never reuse or remove an existing profile');
  assert.equal(resolve(profilePath),nativeFirefoxProfile,'Only the explicitly owned temporary profile is permitted');
  mkdirSync(dirname(profilePath),{recursive:true,mode:0o700});
  assert.equal(realpathSync(dirname(profilePath)),dirname(profilePath),'Profile parent must not redirect through symlinks');
  assert.equal(statSync(dirname(profilePath)).uid,process.getuid(),'Profile parent must be owned by this user');
  mkdirSync(profilePath,{mode:0o700});
  // Owned denial listener never parses, resolves or forwards a destination. HTTP,
  // HTTPS CONNECT and SOCKS all fail here, without pausing app requests in BiDi.
  const proxy={mode:'owned-loopback-deny',host:'127.0.0.1',connections:0,closed:false};
  const denyProxy=createServer(socket=>{proxy.connections++;socket.on('error',()=>{});socket.destroy();});
  denyProxy.unref();
  await new Promise((done,reject)=>{denyProxy.once('error',reject);denyProxy.listen({host:proxy.host,port:0},done);});
  proxy.port=denyProxy.address().port;
  try {
    const effectivePrefs={...prefs,'network.proxy.http_port':proxy.port,'network.proxy.ssl_port':proxy.port,'network.proxy.socks_port':proxy.port};
    writeFileSync(join(profilePath,'user.js'),Object.entries(effectivePrefs).map(([key,value])=>`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n')+'\n',{mode:0o600});
  }catch(error){denyProxy.close();throw error;}
  const environment={...process.env,MOZ_HEADLESS:'1'};
  for(const key of ['LD_LIBRARY_PATH','MOZ_GMP_PATH','GDK_BACKEND'])delete environment[key];
  const client={pending:new Map(),listeners:new Map(),sequence:0,commands:0,actionCommands:0,maxCommands,maxActionCommands,
    deadline:started+activeMilliseconds,profilePath,proxy};
  let stderr='',spawnError,cleanupPromise,watchdog;
  client.process=spawn('/usr/bin/firefox',['--headless','--no-remote','--profile',profilePath,'--remote-debugging-port','0'],
    {env:environment,detached:true,stdio:['ignore','ignore','pipe']});
  client.process.once('error',error=>{spawnError=error;});
  client.cleanup=()=>cleanupPromise??=(async()=>{
    clearTimeout(watchdog);
    const begin=Date.now(),pid=client.process.pid;
    if(client.socket?.readyState===WebSocket.OPEN&&client.commands<maxCommands&&client.actionCommands<maxActionCommands){
      try{await command(client,'browser.close',{},500);}catch{}
    }
    client.socket?.close();
    if(pid&&alive(pid))signal(pid,'SIGTERM');
    while(pid&&alive(pid)&&Date.now()-begin<3000)await delay(25);
    if(pid&&alive(pid))signal(pid,'SIGKILL');
    while(pid&&alive(pid)&&Date.now()-begin<4950)await delay(10);
    await new Promise((done,reject)=>denyProxy.close(error=>{if(error)reject(error);else done();}));proxy.closed=true;
    const result={pid:pid??null,processGroupAbsent:!pid||!alive(pid),milliseconds:Date.now()-begin,profileBytes:size(profilePath),proxyClosed:proxy.closed};
    assert.ok(result.processGroupAbsent,'Owned Firefox process group must be absent');return result;
  })();
  watchdog=setTimeout(()=>void client.cleanup().catch(()=>{}),Math.max(1,client.deadline-Date.now()));
  client.process.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);});
  try {
    onSpawn({pid:client.process.pid??null,profilePath,started});
    let endpoint;
    while(!(endpoint=stderr.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/)?.[1])){
      if(spawnError)throw spawnError;
      assert.equal(client.process.exitCode,null,`Firefox exited: ${stderr.slice(-1200)}`);
      assert.equal(client.process.signalCode,null,'Firefox terminated before BiDi startup');
      assert.ok(Date.now()<client.deadline,'Firefox BiDi startup deadline');await delay(20);
    }
    client.socket=new WebSocket(`${endpoint}/session`);
    client.on=(method,handler)=>{const handlers=client.listeners.get(method)??[];handlers.push(handler);client.listeners.set(method,handlers);};
    client.socket.addEventListener('message',event=>{
      const response=JSON.parse(event.data),pending=client.pending.get(response.id);
      if(pending){client.pending.delete(response.id);response.type==='error'?pending.reject(Error(`${response.error}: ${response.message}`)):pending.done(response.result);}
      else if(response.type==='event')for(const handler of client.listeners.get(response.method)??[])
        Promise.resolve().then(()=>handler(response.params)).catch(error=>{client.eventError??=error;});
    });
    client.socket.addEventListener('close',()=>{for(const pending of client.pending.values())pending.reject(Error('BiDi socket closed'));client.pending.clear();});
    await new Promise((done,reject)=>{
      const timer=setTimeout(()=>reject(Error('BiDi connect deadline')),Math.max(1,client.deadline-Date.now()));
      client.socket.addEventListener('open',()=>{clearTimeout(timer);done();},{once:true});
      client.socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('BiDi connection failed'));},{once:true});
    });
    client.command=(method,params)=>{if(client.eventError)throw client.eventError;return command(client,method,params);};
    client.session=await client.command('session.new',{capabilities});
    client.context=(await client.command('browsingContext.create',{type:'tab'})).context;
    client.navigate=(url,context=client.context)=>client.command('browsingContext.navigate',{context,url,wait:'complete'});
    client.evaluateJSON=async(expression,context=client.context)=>{
      const result=await client.command('script.evaluate',{target:{context},expression:`Promise.resolve((${expression})).then(value=>JSON.stringify(value))`,awaitPromise:true});
      assert.equal(result.type,'success',JSON.stringify(result.exceptionDetails)?.slice(0,1500));
      assert.equal(result.result.type,'string');return JSON.parse(result.result.value);
    };
    client.captureScreenshot=async(context=client.context)=>{
      const result=await client.command('browsingContext.captureScreenshot',{context,origin:'viewport',format:{type:'image/png'}});
      assert.ok(result.data.length<=32*1024**2*4/3,'Screenshot output ceiling');return Buffer.from(result.data,'base64');
    };
    return client;
  }catch(error){error.cleanup=await client.cleanup().catch(cleanupError=>({error:cleanupError.message}));throw error;}
}
