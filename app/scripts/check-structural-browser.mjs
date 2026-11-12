import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {initializeIntegratedStudioSession} from './integrated-studio-built-shell.mjs';
import {openNativeFirefox} from './native-firefox-bidi.mjs';

const json=JSON.stringify;
const bounded=async(promise,milliseconds,message)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),Math.max(1,milliseconds));})]);}finally{clearTimeout(timer);}};
const q=(selector,text=null)=>`[...document.querySelectorAll(${json(selector)})].find(element=>${text===null?'true':`element.textContent.trim()===${json(text)}`})`;
const geometry=offset=>({type:'MultiPolygon',coordinates:[[[[offset,0],[offset+2,0],[offset+2,2],[offset,2],[offset,0]]]]});
const pointCount=value=>value.coordinates.reduce((total,polygon)=>total+polygon.reduce((count,ring)=>count+ring.length,0),0);
const area=value=>(value.type==='Polygon'?[value.coordinates]:value.coordinates).reduce((total,polygon)=>total+polygon.reduce((sum,ring,index)=>{
  let signed=0;for(let i=1;i<ring.length;i++)signed+=ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1];
  return sum+(index?-1:1)*Math.abs(signed/2);
},0),0);

// Shared DOM reads and ordinary input; neither backend injects geometry or map state.
function controls(raw,guard) {
  const evaluate=async expression=>{guard();const result=await raw.evalJSON(expression);guard();return result;};
  const wait=(expression,milliseconds=10000)=>evaluate(`(async()=>{const end=Date.now()+${Math.max(1,Math.min(milliseconds,raw.deadline-Date.now()))};do{const result=(${expression});if(result)return result;await new Promise(done=>setTimeout(done,80));}while(Date.now()<end);throw Error(${json(`DOM wait: ${expression.slice(0,180)}`)});})()`);
  const locate=async(selector,text)=>{
    await wait(`Boolean(${q(selector,text)})`);
    return evaluate(`(async()=>{const element=${q(selector,text)};if(element.disabled)throw Error('Disabled control');element.scrollIntoView({block:'center',inline:'center'});await new Promise(requestAnimationFrame);const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);if(!rect.width||!rect.height||!(hit===element||element.contains(hit)))throw Error('Control is obscured');return {x,y};})()`);
  };
  return {...raw,evalJSON:evaluate,wait,
    click:async(selector,text=null)=>{const point=await locate(selector,text);guard();await raw.clickPoint(point);guard();},
    drag:async(from,to)=>{guard();assert.ok(raw.dragPoints,'Native drag requires the Chromium mouse primitive');await raw.dragPoints(from,to);guard();},
    check:async selector=>{if(!await evaluate(`Boolean(${q(selector)}?.checked)`)){const point=await locate(selector);await raw.clickPoint(point);}assert.equal(await evaluate(`${q(selector)}.checked`),true);},
    select:async(selector,value)=>{
      const index=await evaluate(`(()=>{const select=${q(selector)};return [...select.options].findIndex(option=>option.value===${json(value)});})()`);
      assert.ok(index>=0,'Requested retained identity must be an actual option');
      const point=await locate(selector);await raw.clickPoint(point);await raw.keys(['Home',...Array(index).fill('ArrowDown'),'Enter']);
      assert.equal(await evaluate(`${q(selector)}.value`),value);
    }
  };
}

async function renderedSegmentReady(page,canvas,facts,state) {
  const started=Date.now(),deadline=Math.min(started+5000,page.deadline,state.deadline);
  const proof=facts.renderedReadiness={limitMilliseconds:5000,maxScreenshots:3,byteLimit:6*1024**2,screenshotBytes:0,attempts:[]};state.checkpoint();
  const step=promise=>bounded(promise,deadline-Date.now(),'Rendered geometry readiness deadline');
  // Source fitFeatureBounds: bbox [0,0,3,2], padding 40, maxZoom 15, duration 0.
  const scene=()=>page.evalJSON(`(async()=>{const element=document.querySelector(${json(`${canvas} .maplibregl-canvas`)});if(!element)throw Error('Actual MapLibre canvas unavailable');element.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const first=element.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=element.getBoundingClientRect(),merc=lat=>180/Math.PI*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360)),height=merc(2)-merc(0),scale=Math.min((r.width-80)/3,(r.height-80)/height),project=(longitude,latitude)=>({x:r.left+r.width/2+(longitude-1.5)*scale,y:r.top+r.height/2+(height/2-merc(latitude))*scale});return {point:{...project(1,0),width:r.width,height:r.height},rect:{left:r.left,top:r.top,width:r.width,height:r.height},stable:['left','top','width','height'].every(key=>Math.abs(first[key]-r[key])<0.25),samples:[project(0.5,1),project(2.5,1),{x:r.left+r.width/2,y:r.top+20}],viewport:{width:innerWidth,height:innerHeight}};})()`);
  for(let attempt=0;attempt<3;attempt++) {
    assert.ok(Date.now()<deadline,'Rendered geometry readiness deadline');const before=await step(scene());
    const png=await step(page.screenshot());assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    proof.screenshotBytes+=png.length;assert.ok(png.length<=2*1024**2&&proof.screenshotBytes<=proof.byteLimit,'Readiness screenshot byte ceiling');
    // Decode the actual compositor screenshot into an unattached 2D canvas; never read or alter the product WebGL context.
    const observed=await step(page.evalJSON(`(async()=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(${json(png.toString('base64'))}),character=>character.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);const pixels=${json(before.samples)}.map(point=>[...context.getImageData(Math.round(point.x*bitmap.width/${before.viewport.width}),Math.round(point.y*bitmap.height/${before.viewport.height}),1,1).data]);bitmap.close();const r=document.querySelector(${json(`${canvas} .maplibregl-canvas`)}).getBoundingClientRect();return {pixels,rect:{left:r.left,top:r.top,width:r.width,height:r.height}};})()`));
    const stable=before.stable&&Object.keys(before.rect).every(key=>Math.abs(before.rect[key]-observed.rect[key])<0.25);
    const background=[16,35,51],fill=[66,183,168].map((value,index)=>Math.round(value*0.28+background[index]*0.72));
    const matches=(pixel,expected)=>pixel[3]>=250&&expected.every((value,index)=>Math.abs(pixel[index]-value)<=6);
    const visible=matches(observed.pixels[0],fill)&&matches(observed.pixels[1],fill)&&matches(observed.pixels[2],background);
    proof.attempts.push({milliseconds:Date.now()-started,stable,pixels:observed.pixels,expected:[fill,fill,background],visible});state.checkpoint();
    if(stable&&visible){proof.milliseconds=Date.now()-started;proof.ready=true;return before.point;}
    if(attempt<2)await step(page.evalJSON(`new Promise(done=>setTimeout(()=>requestAnimationFrame(()=>done(true)),${Math.max(0,Math.min(1200,deadline-Date.now()-200))}))`));
  }
  throw Error('Actual fixture fill and background did not render at the stable fitted canvas coordinates');
}

async function firefoxDriver(state) {
  const {origin,organization,report,checkpoint,guard,fail}=state;
  const client=await openNativeFirefox({activeMilliseconds:Math.min(80000-state.priorUsage.activeMilliseconds,state.deadline-Date.now()),
    maxCommands:900-state.priorUsage.firefoxCommands,maxActionCommands:250-state.priorUsage.firefoxActionCommands,
    capabilities:{alwaysMatch:{unhandledPromptBehavior:{default:'ignore'}}},
    onSpawn:({pid,profilePath})=>{report.nativeFirefoxPid=pid;report.firefoxProfile=profilePath;Object.assign(report.engines.firefox,{pid,ownedProcessGroup:pid,ownedProfile:profilePath});checkpoint();}});
  state.firefox=client;
  const capabilities=client.session.capabilities;report.engines.firefox.browser={name:capabilities.browserName,version:capabilities.browserVersion,platform:capabilities.platformName};
  report.engines.firefox.outbound=client.proxy;checkpoint();
  client.on('network.beforeRequestSent',event=>{
    try {
      report.browserRequests++;const url=new URL(event.request.url);
      if(url.origin===origin&&url.pathname.startsWith('/api/'))report.apiRequests++;
      guard();const allowed=url.origin===origin||['data:','blob:'].includes(url.protocol)||url.href==='about:blank';
      if(!allowed)report.blockedExternal++;
      assert.ok(!event.isBlocked,'No request interception is installed');
      if(!allowed)assert.ok(['http:','https:','ws:','wss:'].includes(url.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Unexpected non-app navigation must not use a direct loopback exemption');
    }catch(error){report.engines.firefox.failedNetworkObservation={requestId:event.request.request,protocol:new URL(event.request.url).protocol,
      origin:new URL(event.request.url).origin,isBlocked:event.isBlocked,error:error.message};checkpoint();fail(error);void client.cleanup().catch(()=>{});}
  });
  client.on('network.responseCompleted',event=>{
    try {
      const response=event.response;
      const encoding=response.headers.find(header=>header.name.toLowerCase()==='content-encoding')?.value;
      assert.ok(!encoding||encoding.value==='identity','Local response-byte accounting requires uncompressed bodies');
      const bytes=response.content?.size??response.bodySize;
      assert.ok(Number.isFinite(bytes)&&bytes>=0,'BiDi response size must be available');report.responseBytes+=bytes;guard();
    }catch(error){fail(error);void client.cleanup().catch(()=>{});}
  });
  client.on('browsingContext.userPromptOpened',async event=>{
    try{assert.ok(state.confirmExpected&&event.type==='confirm'&&/Dissolve boundaries and union 2 features/.test(event.message),'Only the selected native dissolve confirmation');
      state.confirmExpected=false;report.engines.firefox.dialogs++;await client.command('browsingContext.handleUserPrompt',{context:event.context,accept:true});}
    catch(error){fail(error);void client.cleanup().catch(()=>{});}
  });
  client.on('log.entryAdded',event=>{if(event.level==='error'&&report.engines.firefox.errors.length<8)report.engines.firefox.errors.push(String(event.text).slice(0,300));});
  await client.command('session.subscribe',{events:['network.beforeRequestSent','network.responseCompleted','browsingContext.userPromptOpened','log.entryAdded']});
  // Observe requests and bytes without BiDi pause/continue. The owned deny proxy
  // and disabled direct failover enforce outbound denial at the transport layer.
  await client.command('script.addPreloadScript',{functionDeclaration:`()=>(${initializeIntegratedStudioSession.toString()})(${json({organization,actor:'owner',origin})})`});
  const page=async context=>{
    await client.command('browsingContext.setViewport',{context,viewport:{width:1440,height:1000},devicePixelRatio:1});
    return controls({deadline:client.deadline,
      navigate:url=>{const target=new URL(url);assert.ok(target.origin===origin||url.startsWith('data:text/html,'),'Controlled Firefox navigation stays on the exact app origin or inline WebGL gate');return client.navigate(url,context);},evalJSON:expression=>client.evaluateJSON(expression,context),
      clickPoint:({x,y})=>client.command('input.performActions',{context,actions:[{type:'pointer',id:'structural-mouse',parameters:{pointerType:'mouse'},actions:[
        {type:'pointerMove',origin:'viewport',x:Math.round(x),y:Math.round(y),duration:0},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]}),
      keys:keys=>client.command('input.performActions',{context,actions:[{type:'key',id:'structural-keyboard',actions:keys.flatMap(key=>[
        {type:'keyDown',value:({Home:'\uE011',ArrowDown:'\uE015',Enter:'\uE007'})[key]},{type:'keyUp',value:({Home:'\uE011',ArrowDown:'\uE015',Enter:'\uE007'})[key]}])}]}),
      screenshot:()=>client.captureScreenshot(context)
    },guard);
  };
  return {page:await page(client.context),newPage:async()=>page((await client.command('browsingContext.create',{type:'tab'})).context),
    cleanup:()=>client.cleanup(),client};
}

async function chromiumDriver(state) {
  const {origin,organization,report,guard,fail}=state,deadline=Math.min(state.deadline,Date.now()+(state.chromiumMilliseconds??60000));
  const executablePath=['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(existsSync);
  assert.ok(executablePath,'Reuse installed Chromium');
  const server=await chromium.launchServer({host:'127.0.0.1',port:0,headless:true,chromiumSandbox:false,executablePath,timeout:Math.max(1,Math.min(15000,deadline-Date.now())),
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--disable-dev-shm-usage']});
  state.chromiumServer=server;
  const owned=server.process(),userDataDir=owned.spawnargs.find(argument=>argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  Object.assign(report.engines.chromium,{pid:owned.pid,ownedProcessGroup:owned.pid,ownedProfile:userDataDir,userDataDir,
    spawnSummary:{executable:owned.spawnfile,userDataDir,headless:true}});state.checkpoint();
  const endpoint=new URL(server.wsEndpoint());assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.protocol,'ws:');
  const browser=await chromium.connect(endpoint.href,{timeout:Math.max(1,Math.min(10000,deadline-Date.now()))});
  state.chromium=browser;
  report.engines.chromium.browser={name:'chromium',version:browser.version()};
  if(state.blockServiceWorkers)report.engines.chromium.serviceWorkers='block';
  if(state.cdpDecodedBytes)report.engines.chromium.responseAccounting='CDP Network.dataReceived.dataLength';state.checkpoint();
  const closeAfterFailure=error=>{fail(error);void browser.close().catch(closeError=>{report.engines.chromium.observerCloseError=closeError.message;state.checkpoint();});};
  const watchdog=setTimeout(()=>{fail(Error('Chromium active deadline'));void server.kill().catch(error=>{report.engines.chromium.watchdogKillError=error.message;state.checkpoint();});},Math.max(1,deadline-Date.now()));
  const context=await browser.newContext({viewport:{width:1440,height:1000},...(state.blockServiceWorkers?{serviceWorkers:'block'}:{})}),pending=new Set();
  await context.addInitScript(initializeIntegratedStudioSession,{organization,actor:'owner',origin});
  await context.route('**/*',async route=>{
    try{const url=new URL(route.request().url());guard();if(url.origin===origin||['data:','blob:'].includes(url.protocol)||url.href==='about:blank'){state.beforeBrowserRequest?.(route.request());await route.continue();}
      else{report.blockedExternal++;await route.abort();}}
    catch(error){fail(error);await route.abort().catch(()=>{});closeAfterFailure(error);}
  });
  context.on('request',request=>{try{report.browserRequests++;const url=new URL(request.url());if(url.origin===origin&&url.pathname.startsWith('/api/'))report.apiRequests++;guard();}catch(error){closeAfterFailure(error);}});
  context.on('response',response=>{
    if(state.cdpDecodedBytes&&!state.shouldReadBrowserBody?.(response))return;
    const task=response.body().then(body=>{if(!state.cdpDecodedBytes)report.responseBytes+=body.length;state.observeBrowserResponse?.(response,body);guard();}).catch(error=>{if(!state.closing){
      report.engines.chromium.responseObservationFailure={url:response.url(),method:response.request().method(),status:response.status(),fromServiceWorker:response.fromServiceWorker(),error:error.message};state.checkpoint();closeAfterFailure(error);}});
    pending.add(task);void task.finally(()=>pending.delete(task));
  });
  const page=async()=>{
    const instance=await context.newPage();instance.setDefaultTimeout(Math.max(1,Math.min(10000,deadline-Date.now())));
    if(state.cdpDecodedBytes){const cdp=await context.newCDPSession(instance);await cdp.send('Network.enable');cdp.on('Network.dataReceived',event=>{
      try{assert.ok(Number.isSafeInteger(event.dataLength)&&event.dataLength>=0,'CDP decoded response size must be available');report.responseBytes+=event.dataLength;if(!state.closing)guard();else assert.ok(report.responseBytes+report.screenshotBytes<=report.limits.responseAndScreenshotBytes,'Cleanup response byte ceiling');}catch(error){closeAfterFailure(error);}});}
    instance.on('pageerror',error=>{if(report.engines.chromium.errors.length<8)report.engines.chromium.errors.push(error.message.slice(0,300));});
    instance.on('dialog',async dialog=>{
      try{assert.ok(state.confirmExpected&&dialog.type()==='confirm'&&/Dissolve boundaries and union 2 features/.test(dialog.message()),'Only the selected native dissolve confirmation');
        state.confirmExpected=false;report.engines.chromium.dialogs++;await dialog.accept();}
      catch(error){fail(error);await dialog.dismiss().catch(()=>{});}
    });
    return controls({deadline,navigate:url=>instance.goto(url,{waitUntil:'load',timeout:Math.max(1,deadline-Date.now())}),
      evalJSON:expression=>instance.evaluate(expression),clickPoint:({x,y})=>instance.mouse.click(Math.round(x),Math.round(y)),
      dragPoints:async(from,to)=>{await instance.mouse.move(Math.round(from.x),Math.round(from.y));await instance.mouse.down();
        await instance.mouse.move(Math.round(to.x),Math.round(to.y),{steps:12});await instance.mouse.up();},
      inspectFailure:selector=>instance.evaluate(selector=>{const card=selector?document.querySelector(selector):null;return {url:location.href,title:document.title,cardPresent:Boolean(card),statuses:[...(card?.querySelectorAll('.project-feature-canvas-status,.project-catalog-error,.project-catalog-feedback')??[])].slice(0,6).map(element=>element.textContent.slice(0,500)),buttons:[...(card?.querySelectorAll('button')??[])].slice(0,45).map(element=>({text:element.textContent.trim().slice(0,80),disabled:element.disabled})),geometry:card?.querySelector('textarea[aria-label="GeoJSON geometry"]')?.value.slice(0,1500)??null,records:[...(card?.querySelectorAll('.project-feature-record strong')??[])].slice(0,4).map(element=>element.textContent.slice(0,100))};},selector),
      keys:async keys=>{for(const key of keys)await instance.keyboard.press(key);},screenshot:()=>instance.screenshot({fullPage:false})},()=>{assert.ok(Date.now()<deadline,'Chromium active deadline');guard();});
  };
  return {page:await page(),newPage:page,cleanup:async()=>{state.closing=true;clearTimeout(watchdog);const begin=Date.now();
    await bounded(Promise.allSettled([...pending]),500,'Response settlement deadline').catch(()=>{});
    try{await bounded(server.close(),Math.max(1,4500-(Date.now()-begin)),'Chromium close deadline');}
    catch(error){await bounded(server.kill(),Math.max(1,4950-(Date.now()-begin)),'Chromium kill deadline');}
    let processGroupAbsent=false;try{process.kill(-owned.pid,0);}catch(error){if(error.code==='ESRCH')processGroupAbsent=true;else throw error;}
    return {closed:!browser.isConnected(),processExited:owned.exitCode!==null||owned.signalCode!==null,processGroupAbsent,
      profileRemoved:Boolean(userDataDir&&!existsSync(userDataDir)),milliseconds:Date.now()-begin};}};
}

// Read only the native canvas rectangle. Coordinates follow the source's
// fitFeatureBounds([0,0,5,3], padding 40) and never access a product map object.
const cutCanvasScene=(page,canvas,polygonOnly=false)=>page.evalJSON(`(async()=>{const element=document.querySelector(${json(`${canvas} .maplibregl-canvas`)});if(!element)throw Error('Actual MapLibre canvas unavailable');element.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const first=element.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=element.getBoundingClientRect(),merc=latitude=>180/Math.PI*Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360)),height=merc(3)-merc(0),scale=Math.min((r.width-80)/5,(r.height-80)/height),project=([longitude,latitude])=>({x:r.left+r.width/2+(longitude-2.5)*scale,y:r.top+r.height/2+(height/2-merc(latitude))*scale});return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},stable:['left','top','width','height'].every(key=>Math.abs(first[key]-r[key])<0.25),selection:project([4,2]),blade:${json(polygonOnly?[[-0.4,0.75],[3.4,0.75],[3.4,1.2],[5.4,1.2]]:[[1.6,0.75],[3.4,0.75],[3.4,1.2],[5.4,1.2]])}.map(project),samples:${json(polygonOnly?[[0.25,0.75],[4,2],[0.5,2.25]]:[[0.25,0.75],[4,2],[1.5,1.5]])}.map(project),viewport:{width:innerWidth,height:innerHeight}};})()`);

async function renderedCutReady(page,canvas,state,key='renderedReadiness') {
  const started=Date.now(),deadline=Math.min(started+5000,state.deadline,page.deadline),proof=state.report[key]={limitMilliseconds:5000,maxScreenshots:3,attempts:[]};
  const step=promise=>bounded(promise,deadline-Date.now(),'Rendered cut readiness deadline');
  for(let attempt=0;attempt<3;attempt++){
    state.guard();const before=await step(cutCanvasScene(page,canvas,state.report.collectionGeometryType==='Polygon')),png=await step(page.screenshot());
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2,'Bounded readiness screenshot');
    state.report.screenshotBytes+=png.length;state.guard();
    const observed=await step(page.evalJSON(`(async()=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(${json(png.toString('base64'))}),character=>character.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);const pixels=${json(before.samples)}.map(point=>[...context.getImageData(Math.round(point.x*bitmap.width/${before.viewport.width}),Math.round(point.y*bitmap.height/${before.viewport.height}),1,1).data]);bitmap.close();const r=document.querySelector(${json(`${canvas} .maplibregl-canvas`)}).getBoundingClientRect();return {pixels,rect:{left:r.left,top:r.top,width:r.width,height:r.height}};})()`));
    const background=[16,35,51],fill=[66,183,168].map((value,index)=>Math.round(value*0.28+background[index]*0.72)),matches=(pixel,expected)=>pixel[3]>=250&&expected.every((value,index)=>Math.abs(pixel[index]-value)<=6);
    const stable=before.stable&&Object.keys(before.rect).every(key=>Math.abs(before.rect[key]-observed.rect[key])<0.25),visible=matches(observed.pixels[0],fill)&&matches(observed.pixels[1],fill)&&matches(observed.pixels[2],background);
    proof.attempts.push({milliseconds:Date.now()-started,stable,visible,pixels:observed.pixels,expected:[fill,fill,background]});state.checkpoint();
    if(stable&&visible){proof.ready=true;return before;}
    if(attempt<2)await step(page.evalJSON(`new Promise(done=>setTimeout(()=>requestAnimationFrame(()=>done(true)),${Math.max(0,Math.min(1200,deadline-Date.now()-200))}))`));
  }
  throw Error(state.report.collectionGeometryType==='Polygon'?'Native Polygon fill and untouched hole must render before selection or cutting':'Both disconnected native polygon fills must render before selection or cutting');
}

async function runCutOnlyJourney({origin,work,organization,apiRequest,builtShell}) {
  const polygonOnly=process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_POLYGON==='1',geometryType=polygonOnly?'Polygon':'MultiPolygon',partIndex=polygonOnly?0:1,byteCeiling=(polygonOnly?48:64)*1024**2;
  const resumePath=process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_RESUME,resumeSha=process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_RESUME_SHA256;
  if(polygonOnly)assert.ok(!resumePath&&!resumeSha,'Fresh Polygon scope cannot replay or reuse the prior MultiPolygon setup');
  const firstSha='a5871fc742327cdbdcc34129afa9f39cc17aefb1edf49fb265a46f864277a9a9',probeSha='9edca35f14944e3a9777343fc55f512acfa51e58ab77aaba4dd4ec2244541656',uuidSha='d5c63d50ac43ee49706735d776b504bfbeeec8fa4b542f16457ce68884e140ad',probeCorrection=resumeSha===probeSha,uuidFix=resumeSha===uuidSha,apiCeiling=polygonOnly?60:uuidFix?80:probeCorrection?60:40;
  let resume;
  if(resumePath||resumeSha){
    assert.ok(resumePath&&resumeSha,'Cut continuation requires the immutable first receipt and exact SHA');
    assert.ok([firstSha,probeSha,uuidSha].includes(resumeSha),'Only the three diagnosed cut attempts may continue');
    const bytes=readFileSync(resumePath);assert.equal(createHash('sha256').update(bytes).digest('hex'),resumeSha);resume=JSON.parse(bytes);
    assert.equal(resume.schemaVersion,'opengeo.structural-browser-cut.1');assert.equal(resume.status,'failed');assert.equal(resume.stage,'chromium-native-select-second-part');
    if(uuidFix){assert.match(resume.error,/^page\.evaluate: Error: DOM wait:/);assert.ok(resume.error.includes('Part 2/2'));assert.equal(resume.renderedReadiness.ready,true);assert.ok(resume.renderedReadiness.attempts.at(-1).stable&&resume.renderedReadiness.attempts.at(-1).visible);assert.deepEqual(resume.renderedReadiness.attempts.at(-1).pixels,[[30,76,84,255],[30,76,84,255],[16,35,51,255]]);}
    else assert.equal(resume.error,probeCorrection?'Both disconnected native polygon fills must render before selection or cutting':'response.body: Worker closed');
    assert.equal(resume.source.journeySha256,uuidFix?'c622caf29f1d2367da9022623f760fb59551cc46dba87970188d555215c20ee2':probeCorrection?'dbaeafe286ecac6f1cbb6b0438a399291a16101454920588985e2656750592ee':'5d02e27e7b62b4a25d6b527b6171b1fcfdf0415c4392b98e4d8e25d5d7da92d9');
    assert.equal(resume.setup.complete,true);assert.equal(resume.writeIntents.length,5);assert.ok(!resume.cutWire&&!resume.cutResponse,'No native cut was attempted');
    assert.equal(resume.apiRequests,uuidFix?37:probeCorrection?21:5);assert.equal(resume.browserRequests,uuidFix?547:probeCorrection?303:59);assert.equal(resume.responseBytes,uuidFix?11111137:probeCorrection?5881182:651227);assert.equal(resume.screenshotBytes,uuidFix?327469:probeCorrection?245568:0);
    if(probeCorrection||uuidFix){
      let previous=resume;
      if(uuidFix){
        assert.equal(resume.resume.receiptSha256,probeSha);const bytes=readFileSync(resume.resume.receiptPath);assert.equal(createHash('sha256').update(bytes).digest('hex'),probeSha);previous=JSON.parse(bytes);
        assert.equal(previous.schemaVersion,'opengeo.structural-browser-cut.1');assert.equal(previous.status,'failed');assert.equal(previous.stage,'chromium-native-select-second-part');assert.equal(previous.error,'Both disconnected native polygon fills must render before selection or cutting');assert.equal(previous.source.journeySha256,'dbaeafe286ecac6f1cbb6b0438a399291a16101454920588985e2656750592ee');
        assert.equal(previous.apiRequests,21);assert.equal(previous.browserRequests,303);assert.equal(previous.responseBytes,5881182);assert.equal(previous.screenshotBytes,245568);assert.ok(!previous.cutWire&&!previous.cutResponse);assert.deepEqual(resume.setup,previous.setup);assert.deepEqual(resume.writeIntents,previous.writeIntents);assert.deepEqual(resume.applicationShell,previous.applicationShell);
        const cleanup=previous.engines.chromium.cleanup;assert.ok(cleanup.closed&&cleanup.processExited&&cleanup.processGroupAbsent&&cleanup.profileRemoved);assert.equal(resume.resume.setupWritesReplayed,0);assert.equal(resume.resume.readbackComplete,true);
      }
      assert.equal(previous.resume.receiptSha256,firstSha);assert.equal(previous.resume.setupWritesReplayed,0);assert.equal(previous.resume.readbackComplete,true);
      const firstBytes=readFileSync(previous.resume.receiptPath);assert.equal(createHash('sha256').update(firstBytes).digest('hex'),firstSha);const first=JSON.parse(firstBytes);
      assert.equal(first.schemaVersion,'opengeo.structural-browser-cut.1');assert.equal(first.status,'failed');assert.equal(first.stage,'chromium-native-select-second-part');assert.equal(first.error,'response.body: Worker closed');assert.equal(first.source.journeySha256,'5d02e27e7b62b4a25d6b527b6171b1fcfdf0415c4392b98e4d8e25d5d7da92d9');
      assert.equal(first.apiRequests,5);assert.equal(first.browserRequests,59);assert.equal(first.responseBytes,651227);assert.equal(first.screenshotBytes,0);assert.ok(!first.cutWire&&!first.cutResponse);assert.deepEqual(resume.setup,first.setup);assert.deepEqual(resume.writeIntents,first.writeIntents);assert.deepEqual(resume.applicationShell,first.applicationShell);
      const cleanup=first.engines.chromium.cleanup;assert.ok(cleanup.closed&&cleanup.processExited&&cleanup.processGroupAbsent&&cleanup.profileRemoved);
    }
    if(uuidFix)assert.equal(resume.applicationShell.treeDigest,'0ac22d87f2c3769675113c755b91bae8b7318aff9f1074687acc0386d1c3b141');
    else {assert.equal(resume.applicationShell.treeDigest,builtShell.evidence.treeDigest);assert.equal(resume.applicationShell.manifestSha256,builtShell.evidence.manifestSha256);}
    const {projectId,mapId,datasetId,featureId}=resume.setup;for(const id of [projectId,mapId,datasetId,featureId])assert.match(id,/^[0-9a-f-]{36}$/);
    const expected=[['POST','/projects',201],['POST',`/projects/${projectId}/maps`,201],['POST',`/projects/${projectId}/uploads/request`,201],['POST',`/projects/${projectId}/datasets/${datasetId}/feature-collection`,201],['PATCH',`/projects/${projectId}/maps/${mapId}`,200]];
    assert.deepEqual(resume.writeIntents.map(intent=>[intent.method,intent.endpoint,intent.status]),expected);assert.ok(resume.writeIntents.every(intent=>intent.state==='response-received'&&!intent.responseUnknown));
    assert.deepEqual(resume.writeIntents[3].data.features,[resume.setup.initialFeature]);assert.equal(resume.setup.initialFeature.id,featureId);assert.equal(resume.setup.savedMap.id,mapId);assert.deepEqual(resume.setup.savedMap.definition,resume.writeIntents[4].data.definition);
    const cleanup=resume.engines.chromium.cleanup;assert.ok(cleanup.closed&&cleanup.processExited&&cleanup.processGroupAbsent&&cleanup.profileRemoved,'First owned browser must already be fully cleaned');
  }
  const prefix=polygonOnly?'polygon-cut-browser':uuidFix?'cut-line-browser-uuid-fix':probeCorrection?'cut-line-browser-probe-correction':resume?'cut-line-browser-continuation':'cut-line-browser',path=join(work,`${prefix}.json`),artifacts=[`${prefix}-drawn.png`,`${prefix}-reopened.png`];
  assert.ok([path,`${path}.checkpoint`,join(work,`${prefix}-failure.png`),...artifacts.map(name=>join(work,name))].every(file=>!existsSync(file)),'Existing cut receipt forbids replay; reconcile its exact IDs first');
  assert.ok(!process.env.OPENGEO_STRUCTURAL_BROWSER_RESUME&&!process.env.OPENGEO_STRUCTURAL_BROWSER_RESUME_SHA256,'The stopped two-engine fixture cannot resume in the cut-only scope');
  if(polygonOnly){for(const value of [process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_EXPECTED_TREE,process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_EXPECTED_MANIFEST])assert.match(value??'',/^[a-f0-9]{64}$/);assert.equal(builtShell.evidence.treeDigest,process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_EXPECTED_TREE);assert.equal(builtShell.evidence.manifestSha256,process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_EXPECTED_MANIFEST);}
  else assert.equal(builtShell.evidence.treeDigest,uuidFix?'6c2575d3d1895d6386db259f52b622bffe1816e74f59f267ff76ec09992a6964':'0ac22d87f2c3769675113c755b91bae8b7318aff9f1074687acc0386d1c3b141','Reuse the accepted cut-capable Studio bytes');
  if(uuidFix){assert.equal(builtShell.evidence.manifestSha256,'ad6fc1b66ffeafa4e0944f42cbc296aba49ed37b64c7f91102f4756665f89ccd');assert.equal(createHash('sha256').update(readFileSync(new URL('../src/components/FeatureCanvas.js',import.meta.url))).digest('hex'),'1c7828fcd535858009dc23c65e1e3fc21bc8bea9be53e28bac71000d1e427066');}
  const started=Date.now(),deadline=Number(process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_DEADLINE_MS);
  const priorUsage={outerRuntimeMilliseconds:uuidFix?82148:probeCorrection?48612:resume?22730:0,nativeJourneyMilliseconds:resume?.cumulativeNativeJourneyMilliseconds??resume?.totalMilliseconds??0,apiRequests:resume?.apiRequests??0,browserRequests:resume?.browserRequests??0,responseBytes:resume?.responseBytes??0,screenshotBytes:resume?.screenshotBytes??0};
  assert.ok(Number.isSafeInteger(deadline)&&deadline>started&&deadline<=started+(polygonOnly?80000:uuidFix?27000:probeCorrection?49000:100000-priorUsage.outerRuntimeMilliseconds),'Pass the remaining absolute active deadline and retain the stated cleanup reserve');
  const report={schemaVersion:'opengeo.structural-browser-cut.1',scope:'draw-cut-apply-persist-fresh-reopen',collectionGeometryType:geometryType,status:'running',startedAt:new Date(started).toISOString(),outerActiveDeadline:new Date(deadline).toISOString(),
    limits:{outerMilliseconds:polygonOnly?100000:120000,activeMilliseconds:polygonOnly?80000:uuidFix?27000:100000,cleanupReserveMilliseconds:uuidFix?10000:20000,writeIntents:6,apiRequests:apiCeiling,browserRequests:1200,responseAndScreenshotBytes:byteCeiling},
    apiRequests:priorUsage.apiRequests,browserRequests:priorUsage.browserRequests,responseBytes:priorUsage.responseBytes,screenshotBytes:priorUsage.screenshotBytes,blockedExternal:resume?.blockedExternal??0,setup:resume?structuredClone(resume.setup):{},writeIntents:resume?structuredClone(resume.writeIntents):[],engines:{chromium:{dialogs:0,errors:[]}},priorUsage,
    byteAccounting:'Native API JSON bytes plus CDP Network.dataReceived decoded dataLength; screenshots share the ceiling; only the actual cut response body is read',
    ...(resume?{resume:{receiptPath:resumePath,receiptSha256:resumeSha,setupWritesReplayed:0,readbackComplete:false,changedMethod:uuidFix?'Use the accepted UUID promotion/property fix in FeatureCanvas; preserve strict native probes and the exact original fixture':probeCorrection?'Move first readiness sample to [0.25,0.75], strictly outside the demonstrated default draft triangle; retain exact expected teal/tolerance, CDP accounting and blocked service workers':'Cut-only service workers blocked; CDP decoded-byte observations replace asset body reads; only cut response body read; observer close promises caught',diagnosis:uuidFix?'The real MapLibre vector-tile encoder coerces UUID IDs to integers; promoted opengeo:featureId preserves native rendered selection identity':probeCorrection?'The prior [0.5,0.5] sample was on the default draft triangle and observed its exact yellow-over-teal composite; this is a measurement correction':'The first failure was response.body Worker closed; service-worker involvement is a hypothesis, not established causation'}}:{}),
    ...(uuidFix?{changedSource:{previousTreeDigest:resume.applicationShell.treeDigest,treeDigest:builtShell.evidence.treeDigest,manifestSha256:builtShell.evidence.manifestSha256,featureCanvasSha256:'1c7828fcd535858009dc23c65e1e3fc21bc8bea9be53e28bac71000d1e427066'}}:{}),
    applicationShell:builtShell.evidence,source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')},
    notProven:['Production identity or AWS transport','General reshape','Shared-edge or network topology','Other rendering engines','Full upstream product parity']};
  let failure,driver,cutEndpoint,resolveCutResponse;
  const cutResponse=new Promise(done=>{resolveCutResponse=done;});
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;report.cumulativeNativeJourneyMilliseconds=priorUsage.nativeJourneyMilliseconds+report.elapsedMilliseconds;writeFileSync(`${path}.checkpoint`,json(report,null,2)+'\n',{mode:0o600});renameSync(`${path}.checkpoint`,path);};
  const state={origin,organization,report,checkpoint,deadline,chromiumMilliseconds:100000,blockServiceWorkers:true,cdpDecodedBytes:true,closing:false,confirmExpected:false,fail:error=>{failure??=error;}};
  state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<deadline,'Absolute cut-only active deadline');assert.ok(report.apiRequests<=apiCeiling&&report.browserRequests<=1200&&report.responseBytes+report.screenshotBytes<=byteCeiling&&report.writeIntents.length<=6,'Cut-only request/byte/write ceilings');};
  const request=async(endpoint,{method='GET',data,status=200}={})=>{
    state.guard();report.apiRequests++;state.guard();let intent;
    if(method!=='GET'){assert.ok(!resume,'Cut continuation may not repeat any committed setup write');assert.ok(report.writeIntents.length<5,'Only five setup writes precede the one UI cut');intent={endpoint,method,data,state:'attempted',atMilliseconds:Date.now()-started};report.writeIntents.push(intent);checkpoint();}
    let response;
    try{response=await bounded(apiRequest(endpoint,{method,headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,...(data?{'content-type':'application/json'}:{})},...(data?{body:Buffer.from(json(data))}:{})}),deadline-Date.now(),`Cut-only deadline awaiting ${method} ${endpoint}`);}
    catch(error){if(intent){intent.responseUnknown=true;intent.error=error.message;checkpoint();}throw error;}
    report.responseBytes+=response.body.length;state.guard();assert.equal(response.status,status,`${method} ${endpoint}: ${response.body.toString().slice(0,300)}`);
    const result=response.body.length?JSON.parse(response.body):null;
    if(intent){intent.state='response-received';intent.status=response.status;intent.resultId=result?.id??result?.dataset_id??result?.dataset?.id??null;checkpoint();}return result;
  };
  state.beforeBrowserRequest=request=>{
    const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/')||['GET','HEAD'].includes(request.method()))return;
    assert.equal(request.method(),'POST','Only the deliberate cut may write from the browser');assert.equal(url.pathname,`/api${cutEndpoint}`,'Only this new fixture may be changed');assert.equal(report.writeIntents.length,5,'Exactly one native cut request');
    const data=request.postDataJSON();assert.equal(data.feature_id,report.setup.featureId);assert.equal(data.expected_version,1);assert.equal(data.part_index,partIndex);assert.equal(data.cut_line.type,'LineString');assert.equal(data.cut_line.coordinates.length,4);
    report.cutWire={endpoint:cutEndpoint,method:request.method(),data};report.writeIntents.push({endpoint:cutEndpoint,method:'POST',state:'UI-cut-attempted',data,atMilliseconds:Date.now()-started});checkpoint();state.guard();
  };
  state.observeBrowserResponse=(response,body)=>{
    if(new URL(response.url()).pathname!==`/api${cutEndpoint}`||response.request().method()!=='POST')return;
    assert.equal(response.status(),200,'Native Apply cut must succeed against the actual API');report.cutResponse=JSON.parse(body);const intent=report.writeIntents.at(-1);intent.state='response-received';intent.status=200;checkpoint();resolveCutResponse(report.cutResponse);
  };
  state.shouldReadBrowserBody=response=>new URL(response.url()).pathname===`/api${cutEndpoint}`&&response.request().method()==='POST';
  const screenshot=async(page,name)=>{state.guard();const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2,'Bounded cut screenshot');report.screenshotBytes+=png.length;state.guard();writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  const captureFailure=async()=>{
    const page=state.diagnosticPage;if(!page)return;const end=Date.now()+1500;
    try{report.failureDOM=await bounded(page.inspectFailure(state.diagnosticCard),Math.max(1,end-Date.now()),'Failure DOM observation deadline');}catch(error){report.failureDOMError=error.message;}
    if(Date.now()<end)try{const png=await bounded(page.screenshot(),end-Date.now(),'Failure screenshot deadline');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2&&report.responseBytes+report.screenshotBytes+png.length<=byteCeiling,'Failure screenshot shares the retained byte ceiling');report.screenshotBytes+=png.length;const name=`${prefix}-failure.png`;writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});report.failureScreenshot={name,bytes:png.length};}catch(error){report.failureScreenshotError=error.message;}
    checkpoint();
  };
  const cleanup=async()=>{if(!driver)return;const active=driver;driver=null;report.engines.chromium.cleanup=await active.cleanup();const facts=report.engines.chromium.cleanup;assert.ok(facts.closed&&facts.processExited&&facts.processGroupAbsent&&facts.profileRemoved,'Owned Chromium process group/profile must be absent');checkpoint();};
  checkpoint();
  try{
    let feature,project,map,dataset,savedMap;
    if(resume){
      report.stage='cut-continuation-fixture-readback';checkpoint();feature=report.setup.initialFeature;dataset=report.setup.datasetId;
      project=await request(`/projects/${report.setup.projectId}`);assert.equal(project.id,report.setup.projectId);assert.equal(project.name,resume.writeIntents[0].data.name);
      map=await request(`/projects/${project.id}/maps/${report.setup.mapId}`);assert.deepEqual(map,report.setup.savedMap,'The exact previously saved map must survive before any native cut');savedMap=map;
      const base=`/projects/${project.id}/datasets/${dataset}`,collection=await request(`${base}/feature-collection`);assert.equal(collection.dataset_id,dataset);assert.equal(collection.geometry_type,'MultiPolygon');assert.equal(collection.generation,1);assert.equal(collection.feature_count,1);
      const current=(await request(`${base}/features?limit=100`)).features;assert.equal(current.length,1);assert.equal(current[0]['opengeo:version'],1);assert.deepEqual({type:current[0].type,id:current[0].id,geometry:current[0].geometry,properties:current[0].properties},feature,'The original uncut feature identity, attributes and disconnected polygons must survive exactly');
      report.resume.readbackComplete=true;checkpoint();
    }else{
    report.stage='cut-fixture-setup';checkpoint();
    feature={type:'Feature',id:randomUUID(),geometry:polygonOnly?{type:'Polygon',coordinates:[[[0,0],[5,0],[5,3],[0,3],[0,0]],[[0.25,2],[0.75,2],[0.75,2.5],[0.25,2.5],[0.25,2]]]}:{type:'MultiPolygon',coordinates:[[[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[2,0],[5,0],[5,3],[2,3],[2,0]]]]},properties:{name:polygonOnly?'Native Polygon bent cut with hole':'Native bent cut second part',survey_code:polygonOnly?'cut-polygon-hole':'cut-second-part'}};
    report.setup.featureId=feature.id;report.setup.initialFeature=feature;
    project=await request('/projects',{method:'POST',status:201,data:{name:`Native cut-line acceptance ${feature.id}`}});report.setup.projectId=project.id;checkpoint();
    map=await request(`/projects/${project.id}/maps`,{method:'POST',status:201,data:{name:'Native second-part drawn cut'}});report.setup.mapId=map.id;checkpoint();
    const bytes=Buffer.from(json({type:'FeatureCollection',features:[feature]})),ticket=await request(`/projects/${project.id}/uploads/request`,{method:'POST',status:201,data:{name:'Native bent cut polygons',classification:'internal',format:'geojson',filename:'native-cut-polygons.geojson',content_type:'application/geo+json',size_bytes:bytes.length,checksum_sha256:createHash('sha256').update(bytes).digest('hex')}});
    dataset=ticket.dataset?.id??ticket.dataset_id;assert.match(dataset,/^[0-9a-f-]{36}$/);report.setup.datasetId=dataset;checkpoint();
    const base=`/projects/${project.id}/datasets/${dataset}`;cutEndpoint=`${base}/features/cut-line`;
    await request(`${base}/feature-collection`,{method:'POST',status:201,data:{geometry_type:geometryType,fields:[{name:'name',type:'string',required:true},{name:'survey_code',type:'string',required:true}],features:[feature]}});
    const layers=[{layerId:`dataset_${dataset}_live`,datasetId:dataset,title:polygonOnly?'Native Polygon cut with hole':'Native bent cut polygons',sourceType:'governed-dataset',sourceVersion:1,geometryType,bbox:[0,0,5,3],visible:true,opacity:0.9,order:800,style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}}];
    savedMap=await request(`/projects/${project.id}/maps/${map.id}`,{method:'PATCH',data:{expected_version:map.version,definition:{...map.definition,layers},change_message:'Reference one bounded native cut-line fixture'}});report.setup.savedMap=savedMap;report.setup.complete=true;checkpoint();
    }
    const base=`/projects/${project.id}/datasets/${dataset}`;cutEndpoint=`${base}/features/cut-line`;
    report.stage=polygonOnly?'chromium-native-select-Polygon':'chromium-native-select-second-part';checkpoint();driver=await chromiumDriver(state);let page=driver.page;
    const card=`[data-dataset-id="${dataset}"]`,canvas=`${card} .project-feature-canvas`,record=id=>`${card} .project-feature-record[data-feature-id="${id}"]`,url=`${origin}/workspaces?project=${project.id}&map=${map.id}&manage=data#project-data`;
    state.diagnosticPage=page;state.diagnosticCard=card;
    const open=async(page,count)=>{await page.navigate(url);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===${count}`);};
    const snapshot=(page,id)=>page.evalJSON(`(()=>{const record=document.querySelector(${json(record(id))});return {identity:record.querySelector('strong').textContent,...JSON.parse(record.querySelector('pre').textContent)};})()`);
    await open(page,1);await page.click(`${canvas} .project-feature-structure-controls > summary`);await page.click(`${canvas} button`,'Select feature');
    const rendered=await renderedCutReady(page,canvas,state);await page.clickPoint(rendered.selection);
    await page.wait(polygonOnly?`Boolean(${q(`${card} form button`,'Save v2')})`:`${q(`${canvas} button`,'Part 2/2')}&&${q(`${card} form button`,'Save v2')}`);
    assert.match(await page.evalJSON(`document.querySelector(${json(`${canvas} .project-feature-canvas-status`)}).textContent`),new RegExp(`Selected ${feature.id} at v1${polygonOnly?'':'.*component 2'}`));
    assert.deepEqual(await page.evalJSON(`JSON.parse(document.querySelector(${json(`${card} textarea[aria-label="GeoJSON geometry"]`)}).value)`),feature.geometry);
    report.nativeSelection={featureId:feature.id,expectedVersion:1,partIndex,point:rendered.selection};checkpoint();
    report.stage='chromium-native-draw-apply-cut';checkpoint();await page.click(`${canvas} button`,'Cut polygon');
    const scene=await cutCanvasScene(page,canvas,polygonOnly);assert.equal(scene.stable,true);
    for(const [index,point] of scene.blade.entries()){state.guard();assert.ok(point.x>scene.rect.left&&point.x<scene.rect.left+scene.rect.width&&point.y>scene.rect.top&&point.y<scene.rect.top+scene.rect.height,'Every cut vertex is an actual visible canvas point');await page.clickPoint(point);await page.wait(`document.querySelector(${json(`${canvas} .project-feature-canvas-status`)}).textContent.startsWith(${json(`${index+1} cut vertices captured.`)})`);}
    report.drawnBlade={intendedCrs84:polygonOnly?[[-0.4,0.75],[3.4,0.75],[3.4,1.2],[5.4,1.2]]:[[1.6,0.75],[3.4,0.75],[3.4,1.2],[5.4,1.2]],nativePointerPositions:scene.blade};report.drawnScreenshot=await screenshot(page,artifacts[0]);checkpoint();
    await page.click(`${canvas} button`,'Apply cut');await page.wait(`${q(`${record(feature.id)} strong`)}?.textContent.endsWith(' · v2')&&document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===2`);
    const mutation=await bounded(cutResponse,Math.min(5000,deadline-Date.now()),'Native cut response observation deadline');
    assert.equal(mutation.operation,'cut_line');assert.equal(mutation.retained_feature.id,feature.id);assert.equal(mutation.created_features.length,1);assert.deepEqual(mutation.deleted_features,[]);assert.equal(mutation.collection_generation,2);assert.equal(mutation.feature_count,2);
    const createdId=mutation.created_features[0].id;assert.notEqual(createdId,feature.id);report.setup.createdFeatureId=createdId;checkpoint();
    report.stage='chromium-cut-postgis-readback';checkpoint();
    const current=(await request(`${base}/features?limit=100`)).features;assert.equal(current.length,2);const retained=current.find(item=>item.id===feature.id),created=current.find(item=>item.id===createdId);assert.ok(retained&&created);
    assert.equal(retained['opengeo:version'],2);assert.equal(created['opengeo:version'],1);for(const item of current){assert.equal(item.geometry.type,geometryType);assert.deepEqual(item.properties,feature.properties);}
    assert.equal(retained.geometry.coordinates.length,2);assert.equal(created.geometry.coordinates.length,1);
    if(polygonOnly){const canonical=ring=>ring.slice(0,-1).map(point=>json(point)).sort();assert.deepEqual(canonical(retained.geometry.coordinates[1]),canonical(feature.geometry.coordinates[1]),'Uncut hole preserves all exact vertices');}
    else assert.deepEqual(retained.geometry.coordinates[0],feature.geometry.coordinates[0],'Untouched first polygon stays under the original ID with exact coordinates');
    const blade=report.cutWire.data.cut_line.coordinates;assert.ok(blade.every(([x,y],index)=>Math.abs(x-report.drawnBlade.intendedCrs84[index][0])<0.04&&Math.abs(y-report.drawnBlade.intendedCrs84[index][1])<0.04),'Wire positions follow the four native pointer clicks');
    assert.ok(blade[0][0]<(polygonOnly?0:2)&&blade[1][0]>(polygonOnly?0:2)&&blade[1][0]<5&&blade[2][0]>(polygonOnly?0:2)&&blade[2][0]<5&&blade[3][0]>5&&Math.abs(blade[2][1]-blade[1][1])>0.3,'The actual open blade crosses the selected second polygon and bends inside it');
    const atX=(a,b,x)=>[x,a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0])],boundary=[atX(blade[0],blade[1],polygonOnly?0:2),blade[1],blade[2],atX(blade[2],blade[3],5)],ring=[[polygonOnly?0:2,0],[5,0],...[...boundary].reverse(),[polygonOnly?0:2,0]],bottom=polygonOnly?{type:'Polygon',coordinates:[ring]}:{type:'MultiPolygon',coordinates:[[ring]]};
    const createdArea=area(created.geometry),retainedArea=area(retained.geometry),expectedCreatedArea=area(bottom);assert.ok(Math.abs(createdArea-expectedCreatedArea)<1e-7&&Math.abs(retainedArea-(area(feature.geometry)-expectedCreatedArea))<1e-7,'Persisted PostGIS pieces match the bent native blade');assert.ok(retainedArea-(polygonOnly?0:1)>createdArea,'Largest cut piece and any untouched part retain the original identity');assert.ok(Math.abs(retainedArea+createdArea-area(feature.geometry))<1e-7,'Total original area survives');
    report.persisted={retained,created,retainedArea,createdArea,expectedCreatedArea,totalArea:retainedArea+createdArea,untouchedPartExact:!polygonOnly,untouchedHoleExact:polygonOnly};report.writeIntents.at(-1).state='persisted-cut-readback';checkpoint();
    report.stage='chromium-cut-fresh-open-map-history';checkpoint();page=await driver.newPage();state.diagnosticPage=page;await open(page,2);
    assert.deepEqual(await request(`/projects/${project.id}/maps/${map.id}`),savedMap,'Cutting does not replace the saved composition');
    report.freshHistorySnapshots={};
    for(const item of [retained,created]){const reopened=await snapshot(page,item.id);assert.equal(reopened.identity,`${item.id} · v${item['opengeo:version']}`);assert.deepEqual(reopened.geometry,item.geometry);assert.deepEqual(reopened.properties,feature.properties);
      const revisions=item.id===feature.id?[{version:2,operation:'update',geometry:retained.geometry,properties:feature.properties},{version:1,operation:'create',geometry:feature.geometry,properties:feature.properties}]:[{version:1,operation:'create',geometry:created.geometry,properties:feature.properties}];
      await page.click(`${record(item.id)} button`,'History');await page.wait(`document.querySelectorAll(${json(`${record(item.id)} .project-feature-history li`)}).length===${revisions.length}`);
      const snapshots=await page.evalJSON(`[...document.querySelectorAll(${json(`${record(item.id)} .project-feature-history li`)})].map(item=>({heading:item.querySelector('.project-feature-history-heading').textContent,snapshot:JSON.parse(item.querySelector('details pre').textContent)}))`);
      for(const [index,revision] of revisions.entries()){assert.ok(snapshots[index].heading.startsWith(`v${revision.version} ${revision.operation}`));assert.deepEqual(snapshots[index].snapshot,{geometry:revision.geometry,properties:revision.properties});}report.freshHistorySnapshots[item.id]=snapshots;checkpoint();}
    await renderedCutReady(page,canvas,state,'freshRenderedReadiness');report.reopenedScreenshot=await screenshot(page,artifacts[1]);report.freshMapAndFeatureHistory=true;report.writeIntents.at(-1).state='persisted-cut-and-fresh-immutable-history-readback';assert.equal(report.writeIntents.length,6);state.guard();
    await cleanup();report.engines.chromium.status='pass';report.status='pass';report.result=polygonOnly?'Native true-Polygon selection and bent-line cut persist two Polygon identities, exact attributes/uncut hole, largest-piece identity, saved composition and fresh immutable histories':'Native MapLibre second-part selection and bent-line Apply cut persisted two PostGIS identities, exact attributes/untouched part, largest-piece retention, saved composition and fresh-page immutable histories';checkpoint();return report;
  }catch(error){failure??=error;report.status='failed';report.error=failure.message;checkpoint();await captureFailure();throw failure;}
  finally{
    try{await cleanup();}catch(error){report.status='failed';report.cleanupError=error.message;checkpoint();if(!failure)throw error;}
    if(state.chromiumServer&&state.chromiumServer.process().exitCode===null&&state.chromiumServer.process().signalCode===null)try{await bounded(state.chromiumServer.kill(),5000,'Cut-only final Chromium cleanup deadline');}catch(error){report.chromiumCleanupError=error.message;report.status='failed';}
    report.totalMilliseconds=Date.now()-started;checkpoint();
  }
}

async function runPolygonDissolveJourney({origin,work,organization,apiRequest,builtShell}) {
  const receiptPath=process.env.OPENGEO_POLYGON_DISSOLVE_RECEIPT,receiptSha=process.env.OPENGEO_POLYGON_DISSOLVE_RECEIPT_SHA256;
  assert.match(receiptSha??'',/^[a-f0-9]{64}$/);assert.ok(receiptPath);
  const receiptBytes=readFileSync(receiptPath);assert.equal(createHash('sha256').update(receiptBytes).digest('hex'),receiptSha);
  const prior=JSON.parse(receiptBytes);assert.equal(prior.status,'pass');assert.equal(prior.collectionGeometryType,'Polygon');assert.equal(prior.freshMapAndFeatureHistory,true);
  assert.ok(prior.engines.chromium.cleanup.closed&&prior.engines.chromium.cleanup.processGroupAbsent&&prior.engines.chromium.cleanup.profileRemoved);
  const {projectId,mapId,datasetId,featureId,createdFeatureId}=prior.setup;
  for(const id of [projectId,mapId,datasetId,featureId,createdFeatureId])assert.match(id,/^[0-9a-f-]{36}$/);
  for(const value of [process.env.OPENGEO_POLYGON_DISSOLVE_TREE,process.env.OPENGEO_POLYGON_DISSOLVE_MANIFEST])assert.match(value??'',/^[a-f0-9]{64}$/);
  assert.equal(builtShell.evidence.treeDigest,process.env.OPENGEO_POLYGON_DISSOLVE_TREE);
  assert.equal(builtShell.evidence.manifestSha256,process.env.OPENGEO_POLYGON_DISSOLVE_MANIFEST);
  const path=join(work,'polygon-dissolve-browser.json'),prefix='polygon-dissolve-browser';assert.ok(!existsSync(path),'Reconcile a previous dissolve intent instead of replaying it');
  const started=Date.now(),deadline=Number(process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_DEADLINE_MS);
  assert.ok(Number.isSafeInteger(deadline)&&deadline>started&&deadline<=started+80000);
  const report={schemaVersion:'opengeo.structural-browser-polygon-dissolve.1',status:'running',scope:'existing-cut-fixture-select-dissolve-fresh-reopen',collectionGeometryType:'Polygon',
    sourceCutReceipt:{path:receiptPath,SHA256:receiptSha},setup:{projectId,mapId,datasetId,featureId,createdFeatureId},setupWrites:0,
    applicationShell:builtShell.evidence,source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')},
    limits:{outerMilliseconds:100000,activeMilliseconds:80000,writeIntents:1,apiRequests:60,browserRequests:1200,responseAndScreenshotBytes:48*1024**2},
    apiRequests:0,browserRequests:0,responseBytes:0,screenshotBytes:0,blockedExternal:0,writeIntents:[],engines:{chromium:{dialogs:0,errors:[]}},
    notProven:['Production identity/AWS transport','Installed PWA/devices/assistive technology','Other rendering engines','General reshape/shared-edge topology','Full upstream product parity']};
  let failure,driver,activePage,resolveMutation;
  const mutationResponse=new Promise(resolve=>{resolveMutation=resolve;}),base=`/projects/${projectId}/datasets/${datasetId}`,endpoint=`${base}/features/merge-parts`;
  const card=`[data-dataset-id="${datasetId}"]`,canvas=`${card} .project-feature-canvas`,record=id=>`${card} .project-feature-record[data-feature-id="${id}"]`;
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;writeFileSync(path+'.checkpoint',json(report,null,2)+'\n',{mode:0o600});renameSync(path+'.checkpoint',path);};
  const state={origin,organization,report,checkpoint,deadline,chromiumMilliseconds:80000,blockServiceWorkers:true,cdpDecodedBytes:true,closing:false,confirmExpected:false,fail:error=>{failure??=error;}};
  state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<deadline,'Polygon dissolve active deadline');assert.ok(report.apiRequests<=60&&report.browserRequests<=1200&&report.responseBytes+report.screenshotBytes<=48*1024**2&&report.writeIntents.length<=1,'Polygon dissolve request/byte/write ceilings');};
  const request=async url=>{state.guard();report.apiRequests++;state.guard();const response=await bounded(apiRequest(url,{method:'GET',headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization}}),deadline-Date.now(),'Polygon dissolve readback deadline');
    report.responseBytes+=response.body.length;state.guard();assert.equal(response.status,200,`${url}: ${response.body.toString().slice(0,200)}`);return JSON.parse(response.body);};
  state.beforeBrowserRequest=request=>{
    const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/')||['GET','HEAD'].includes(request.method()))return;
    assert.equal(request.method(),'POST');assert.equal(url.pathname,`/api${endpoint}`);assert.equal(report.writeIntents.length,0,'Exactly one UI dissolve; no fixture setup or cut replay');
    const body=request.postDataJSON();assert.equal(body.retained_feature_id,featureId);assert.equal(body.geometry_operation,'dissolve');
    assert.deepEqual(body.features.map(item=>[item.feature_id,item.expected_version]).sort(),[[featureId,2],[createdFeatureId,1]].sort());
    report.writeIntents.push({endpoint,method:'POST',state:'UI-dissolve-attempted',data:body});report.dissolveWire=body;checkpoint();
  };
  state.shouldReadBrowserBody=response=>new URL(response.url()).pathname===`/api${endpoint}`&&response.request().method()==='POST';
  state.observeBrowserResponse=(response,body)=>{if(!state.shouldReadBrowserBody(response))return;assert.equal(response.status(),200);report.mutation=JSON.parse(body);report.writeIntents[0].state='response-received';checkpoint();resolveMutation(report.mutation);};
  const screenshot=async(page,suffix)=>{const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();const name=`${prefix}-${suffix}.png`;writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  const cleanup=async()=>{if(!driver)return;const current=driver;driver=null;report.engines.chromium.cleanup=await current.cleanup();const c=report.engines.chromium.cleanup;assert.ok(c.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);checkpoint();};
  const core=feature=>({id:feature.id,version:feature['opengeo:version'],geometry:feature.geometry,properties:feature.properties});
  checkpoint();
  try {
    report.stage='readback-existing-Polygon-cut-fixture';checkpoint();
    const map=await request(`/projects/${projectId}/maps/${mapId}`);assert.deepEqual(map,prior.setup.savedMap);
    const collection=await request(`${base}/feature-collection`);assert.equal(collection.geometry_type,'Polygon');assert.equal(collection.generation,2);assert.equal(collection.feature_count,2);
    const before=(await request(`${base}/features?limit=100`)).features;assert.equal(before.length,2);
    for(const item of [prior.persisted.retained,prior.persisted.created])assert.deepEqual(core(before.find(feature=>feature.id===item.id)),core(item));
    report.fixtureReadbackComplete=true;report.beforeHeads=before;checkpoint();
    report.stage='native-select-Polygon-pieces-and-dissolve';driver=await chromiumDriver(state);let page=driver.page;activePage=page;
    const url=`${origin}/workspaces?project=${projectId}&map=${mapId}&manage=data#project-data`;
    const open=async(page,count)=>{await page.navigate(url);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===${count}`);};
    await open(page,2);await renderedCutReady(page,canvas,state);
    const structure=`${card} .project-feature-polygon-structure`;await page.click(`${structure} > summary`);
    for(const id of [featureId,createdFeatureId])await page.check(`${card} input[aria-label="Select feature ${id} for polygon merge"]`);
    await page.select(`${structure} select`,featureId);assert.equal(await page.evalJSON(`document.querySelector(${json(`${structure} input[aria-label="Dissolve boundaries"]`)}).checked`),true);
    await cutCanvasScene(page,canvas,true);report.beforeScreenshot=await screenshot(page,'selected');checkpoint();
    state.confirmExpected=true;await page.click(`${structure} button`,'Dissolve selected');
    await page.wait(`${q(`${record(featureId)} strong`)}?.textContent.endsWith(' · v3')&&document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===1`);
    assert.equal(state.confirmExpected,false);assert.equal(report.engines.chromium.dialogs,1);
    const mutation=await bounded(mutationResponse,Math.min(5000,deadline-Date.now()),'Dissolve response observation deadline');
    assert.equal(mutation.operation,'merge_parts');assert.equal(mutation.geometry_operation,'dissolve');assert.equal(mutation.retained_feature.id,featureId);assert.deepEqual(mutation.created_features,[]);assert.equal(mutation.deleted_features.length,1);assert.equal(mutation.deleted_features[0].feature_id,createdFeatureId);assert.equal(mutation.feature_count,1);assert.equal(mutation.collection_generation,3);
    report.stage='PostGIS-Polygon-union-and-history-readback';checkpoint();
    const heads=(await request(`${base}/features?limit=100`)).features;assert.equal(heads.length,1);const retained=heads[0];
    assert.equal(retained.id,featureId);assert.equal(retained['opengeo:version'],3);assert.equal(retained.geometry.type,'Polygon');assert.deepEqual(retained.properties,prior.setup.initialFeature.properties);assert.equal(retained.geometry.coordinates.length,2);
    const canonical=ring=>ring.slice(0,-1).map(point=>json(point)).sort();assert.deepEqual(canonical(retained.geometry.coordinates[1]),canonical(prior.setup.initialFeature.geometry.coordinates[1]));
    const shell=retained.geometry.coordinates[0];assert.ok(shell.every(([x,y])=>x===0||x===5||y===0||y===3));for(const corner of [[0,0],[5,0],[5,3],[0,3]])assert.ok(shell.some(point=>json(point)===json(corner)));
    assert.ok(Math.abs(area(retained.geometry)-14.75)<1e-7);assert.ok(Math.abs(area(retained.geometry)-before.reduce((sum,item)=>sum+area(item.geometry),0))<1e-7);
    const histories={retained:await request(`${base}/features/${featureId}/history`),donor:await request(`${base}/features/${createdFeatureId}/history`)};
    assert.deepEqual(histories.retained.revisions.map(item=>[item.version,item.operation]),[[3,'update'],[2,'update'],[1,'create']]);assert.deepEqual(histories.donor.revisions.map(item=>[item.version,item.operation]),[[2,'delete'],[1,'create']]);
    assert.deepEqual(histories.retained.revisions[0].geometry,retained.geometry);assert.deepEqual(histories.retained.revisions[1].geometry,prior.persisted.retained.geometry);assert.deepEqual(histories.retained.revisions[2].geometry,prior.setup.initialFeature.geometry);
    for(const revision of histories.donor.revisions){assert.deepEqual(revision.geometry,prior.persisted.created.geometry);assert.deepEqual(revision.properties,prior.setup.initialFeature.properties);}
    report.persisted={retained,histories,area:area(retained.geometry),holeExactVertices:true};report.writeIntents[0].state='persisted-Polygon-union-and-donor-tombstone-readback';checkpoint();
    report.stage='fresh-Project-Polygon-and-history';page=await driver.newPage();activePage=page;await open(page,1);
    assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),map);
    const fresh=await page.evalJSON(`JSON.parse(document.querySelector(${json(`${record(featureId)} pre`)}).textContent)`);assert.deepEqual(fresh,{geometry:retained.geometry,properties:retained.properties});
    await page.click(`${record(featureId)} button`,'History');await page.wait(`document.querySelectorAll(${json(`${record(featureId)} .project-feature-history li`)}).length===3`);
    const snapshots=await page.evalJSON(`[...document.querySelectorAll(${json(`${record(featureId)} .project-feature-history li`)})].map(item=>({heading:item.querySelector('.project-feature-history-heading').textContent,snapshot:JSON.parse(item.querySelector('details pre').textContent)}))`);
    for(const [index,revision] of histories.retained.revisions.entries()){assert.ok(snapshots[index].heading.startsWith(`v${revision.version} ${revision.operation}`));assert.deepEqual(snapshots[index].snapshot,{geometry:revision.geometry,properties:revision.properties});}
    report.freshHistorySnapshots=snapshots;await renderedCutReady(page,canvas,state,'freshRenderedReadiness');report.reopenedScreenshot=await screenshot(page,'reopened');report.freshMapAndFeatureHistory=true;
    await cleanup();report.status='pass';report.engines.chromium.status='pass';report.writeIntents[0].state='persisted-Polygon-and-fresh-immutable-history-readback';checkpoint();return report;
  } catch(error) {
    failure??=error;report.status='failed';report.error=failure.message;
    if(activePage)try{report.failureDOM=await bounded(activePage.inspectFailure(card),1000,'Bounded failure DOM');}catch{}
    checkpoint();throw failure;
  } finally {
    try{await cleanup();}catch(error){report.status='failed';report.cleanupError=error.message;checkpoint();if(!failure)throw error;}
    report.totalMilliseconds=Date.now()-started;checkpoint();
  }
}

async function runSharedVertexJourney({origin,work,organization,apiRequest,builtShell}) {
  for(const value of [process.env.OPENGEO_SHARED_VERTEX_TREE,process.env.OPENGEO_SHARED_VERTEX_MANIFEST])assert.match(value??'',/^[a-f0-9]{64}$/);
  assert.equal(builtShell.evidence.treeDigest,process.env.OPENGEO_SHARED_VERTEX_TREE);
  assert.equal(builtShell.evidence.manifestSha256,process.env.OPENGEO_SHARED_VERTEX_MANIFEST);
  const resumePath=process.env.OPENGEO_SHARED_VERTEX_RESUME,resumeSha=process.env.OPENGEO_SHARED_VERTEX_RESUME_SHA256;
  let prior;
  if(resumePath||resumeSha){
    assert.ok(resumePath&&resumeSha);assert.match(resumeSha,/^[a-f0-9]{64}$/);
    const bytes=readFileSync(resumePath);assert.equal(createHash('sha256').update(bytes).digest('hex'),resumeSha);prior=JSON.parse(bytes);
    assert.equal(prior.schemaVersion,'opengeo.structural-browser-shared-vertex.1');assert.equal(prior.status,'failed');
    assert.equal(prior.attempt,1);assert.equal(prior.setup.complete,true,'Partial or ambiguous fixture setup cannot be replayed');
    assert.ok(prior.writeIntents.filter(item=>item.kind==='setup').every(item=>item.state==='response-received'&&!item.responseUnknown));
    assert.deepEqual(prior.applicationShell,builtShell.evidence,'One accepted build across both native attempts');
    if(prior.engines.chromium.pid){const c=prior.engines.chromium.cleanup;assert.ok(c?.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);}
    assert.ok(process.env.OPENGEO_SHARED_VERTEX_DIAGNOSIS,'Continuation requires a retained diagnosis/change of method');
  }
  const attempt=prior?2:1,prefix=`shared-vertex-browser-attempt${attempt}`,path=join(work,`${prefix}.json`);
  assert.ok(!existsSync(path)&&!existsSync(path+'.checkpoint'),'Existing shared-vertex attempt must be reconciled');
  const started=Date.now(),deadline=Number(process.env.OPENGEO_SHARED_VERTEX_DEADLINE_MS);
  assert.ok(Number.isSafeInteger(deadline)&&deadline>started&&deadline<=started+100000);
  const report={schemaVersion:'opengeo.structural-browser-shared-vertex.1',status:'running',attempt,
    scope:'native-shared-Polygon-vertex-preview-explicit-apply-fresh-history',collectionGeometryType:'Polygon',
    applicationShell:builtShell.evidence,source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')},
    limits:{outerMilliseconds:120000,apiRequests:70,browserRequests:1100,responseAndScreenshotBytes:32*1024**2,setupWrites:7,topologyUIWrites:1,attempts:2},
    apiRequests:prior?.apiRequests??0,browserRequests:prior?.browserRequests??0,responseBytes:prior?.responseBytes??0,
    screenshotBytes:prior?.screenshotBytes??0,blockedExternal:prior?.blockedExternal??0,setup:prior?structuredClone(prior.setup):{},
    writeIntents:prior?structuredClone(prior.writeIntents):[],engines:{chromium:{dialogs:0,errors:[]}},
    ...(prior?{resume:{receiptPath:resumePath,receiptSHA256:resumeSha,diagnosis:process.env.OPENGEO_SHARED_VERTEX_DIAGNOSIS,setupWritesReplayed:0,mutationWritesReplayed:0}}:{}),
    notProven:['Hosted identity or AWS transport','General topology editing or network topology','Other rendering engines','Full upstream parity']};
  let failure,driver,activePage,endpoint,allowMutation=false,resolveMutation;
  const mutationResponse=new Promise(resolve=>{resolveMutation=resolve;});
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;writeFileSync(path+'.checkpoint',json(report,null,2)+'\n',{mode:0o600});renameSync(path+'.checkpoint',path);};
  const state={origin,organization,report,checkpoint,deadline,chromiumMilliseconds:100000,blockServiceWorkers:true,cdpDecodedBytes:true,closing:false,confirmExpected:false,fail:error=>{failure??=error;}};
  state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<deadline,'Shared vertex active deadline');
    assert.ok(report.apiRequests<=70&&report.browserRequests<=1100&&report.responseBytes+report.screenshotBytes<=32*1024**2,'Shared vertex cumulative request/byte ceilings');
    assert.ok(report.writeIntents.filter(item=>item.kind==='setup').length<=7&&report.writeIntents.filter(item=>item.kind==='topology').length<=1,'Shared vertex setup and single explicit-write ceilings');};
  const request=async(url,{method='GET',data,status=200}={})=>{
    state.guard();report.apiRequests++;state.guard();let intent;
    if(method!=='GET'){assert.ok(!prior,'A continuation cannot replay setup');intent={kind:'setup',endpoint:url,method,data,state:'attempted'};report.writeIntents.push(intent);checkpoint();state.guard();}
    let response;try{response=await bounded(apiRequest(url,{method,headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,...(data?{'content-type':'application/json'}:{})},...(data?{body:Buffer.from(json(data))}:{})}),deadline-Date.now(),'Shared vertex API deadline');}
    catch(error){if(intent){intent.responseUnknown=true;checkpoint();}throw error;}
    report.responseBytes+=response.body.length;state.guard();assert.equal(response.status,status,`${method} ${url}: ${response.body.toString().slice(0,200)}`);
    const result=response.body.length?JSON.parse(response.body):null;if(intent){intent.state='response-received';intent.status=response.status;intent.resultId=result?.id??result?.dataset_id??result?.dataset?.id??null;checkpoint();}return result;
  };
  state.beforeBrowserRequest=request=>{
    const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/')||['GET','HEAD'].includes(request.method()))return;
    assert.ok(allowMutation,'Pointer selection/preview may not write before Apply shared move');assert.equal(request.method(),'POST');assert.equal(url.pathname,`/api${endpoint}`);
    assert.equal(report.writeIntents.filter(item=>item.kind==='topology').length,0,'A shared move may never be replayed');
    const body=request.postDataJSON();assert.deepEqual(body.from_position,[3,1.5]);
    assert.ok(Array.isArray(body.to_position)&&body.to_position.length===2&&Math.abs(body.to_position[0]-3.5)<0.05&&Math.abs(body.to_position[1]-1.5)<0.05,'Actual native pointer target stays within screen-pixel tolerance of [3.5,1.5]');
    assert.deepEqual(body.features.map(item=>[item.feature_id,item.expected_version]).sort(),report.setup.initialFeatures.slice(0,2).map(item=>[item.id,1]).sort());
    report.moveWire=body;report.writeIntents.push({kind:'topology',endpoint,method:'POST',data:body,state:'UI-shared-move-attempted'});checkpoint();state.guard();
  };
  state.shouldReadBrowserBody=response=>new URL(response.url()).pathname===`/api${endpoint}`&&response.request().method()==='POST';
  state.observeBrowserResponse=(response,body)=>{if(!state.shouldReadBrowserBody(response))return;assert.equal(response.status(),200);report.mutation=JSON.parse(body);report.writeIntents.find(item=>item.kind==='topology').state='response-received';checkpoint();resolveMutation(report.mutation);};
  const core=feature=>({id:feature.id,version:feature['opengeo:version'],geometry:feature.geometry,properties:feature.properties});
  const screenshot=async(page,suffix)=>{const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();const name=`${prefix}-${suffix}.png`;writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  let card,canvas,record,url;
  const observeScene=page=>page.evalJSON(`(async()=>{const e=document.querySelector(${json(canvas+' .maplibregl-canvas')});if(!e)throw Error('Actual MapLibre canvas unavailable');e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const first=e.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),merc=lat=>180/Math.PI*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360)),height=merc(3)-merc(0),scale=Math.min((r.width-80)/8,(r.height-80)/height),project=([x,y])=>({x:r.left+r.width/2+(x-4)*scale,y:r.top+r.height/2+(height/2-merc(y))*scale});return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},stable:['left','top','width','height'].every(k=>Math.abs(first[k]-r[k])<0.25),selection:project([2,2]),from:project([3,1.5]),to:project([3.5,1.5]),samples:[[2,2],[4.5,2],[7.5,0.5],[1.25,0.75]].map(project),viewport:{width:innerWidth,height:innerHeight}};})()`);
  const ready=async page=>{
    const proof={attempts:[]},end=Math.min(deadline,Date.now()+5000);report.renderedReadiness??=[];report.renderedReadiness.push(proof);
    for(let i=0;i<3;i++){
      assert.ok(Date.now()<end);const before=await observeScene(page),png=await page.screenshot();assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();
      const pixels=await page.evalJSON(`(async()=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(${json(png.toString('base64'))}),x=>x.charCodeAt(0))],{type:'image/png'}));const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);const result=${json(before.samples)}.map(p=>[...ctx.getImageData(Math.round(p.x*bitmap.width/${before.viewport.width}),Math.round(p.y*bitmap.height/${before.viewport.height}),1,1).data]);bitmap.close();return result;})()`);
      const bg=[16,35,51],fill=[66,183,168].map((v,j)=>Math.round(v*0.28+bg[j]*0.72)),matches=(p,expected)=>p[3]>=250&&expected.every((v,j)=>Math.abs(v-p[j])<=5);
      const visible=pixels.slice(0,3).every(p=>matches(p,fill))&&matches(pixels[3],bg);proof.attempts.push({stable:before.stable,visible,pixels});checkpoint();if(before.stable&&visible){proof.ready=true;return before;}
      await page.wait('new Promise(resolve=>setTimeout(()=>resolve(true),80))',Math.max(1,end-Date.now()));
    }throw Error('Three actual Polygon fills and the left hole must render before shared editing');
  };
  const cleanup=async()=>{if(!driver)return;const current=driver;driver=null;report.engines.chromium.cleanup=await current.cleanup();const c=report.engines.chromium.cleanup;assert.ok(c.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);checkpoint();};
  checkpoint();
  try{
    if(!prior){
      const make=(name,coordinates)=>({type:'Feature',id:randomUUID(),geometry:{type:'Polygon',coordinates},properties:{name,survey_code:`shared-${name}`}});
      const initialFeatures=[make('left',[[[0,0],[3,0],[3,1.5],[3,3],[0,3],[0,0]],[[0.5,0.5],[0.5,1],[1.5,1],[1.5,0.5],[0.5,0.5]]]),make('right',[[[3,0],[6,0],[6,3],[3,3],[3,1.5],[3,0]]]),make('unrelated',[[[7,0],[8,0],[8,1],[7,1],[7,0]]])];
      report.setup.initialFeatures=initialFeatures;checkpoint();
      const project=await request('/projects',{method:'POST',status:201,data:{name:`Native shared vertex ${initialFeatures[0].id}`}});report.setup.projectId=project.id;checkpoint();
      const map=await request(`/projects/${project.id}/maps`,{method:'POST',status:201,data:{name:'Native shared Polygon boundary'}});report.setup.mapId=map.id;checkpoint();
      const bytes=Buffer.from(json({type:'FeatureCollection',features:initialFeatures})),ticket=await request(`/projects/${project.id}/uploads/request`,{method:'POST',status:201,data:{name:'Native shared Polygon boundaries',classification:'internal',format:'geojson',filename:'shared-vertex-polygons.geojson',content_type:'application/geo+json',size_bytes:bytes.length,checksum_sha256:createHash('sha256').update(bytes).digest('hex')}});
      report.setup.datasetId=ticket.dataset?.id??ticket.dataset_id;assert.match(report.setup.datasetId,/^[0-9a-f-]{36}$/);checkpoint();
      const base=`/projects/${project.id}/datasets/${report.setup.datasetId}`;
      await request(`${base}/feature-collection`,{method:'POST',status:201,data:{geometry_type:'Polygon',fields:[{name:'name',type:'string',required:true},{name:'survey_code',type:'string',required:true}],features:initialFeatures}});
      const layers=[{layerId:`dataset_${report.setup.datasetId}_live`,datasetId:report.setup.datasetId,title:'Native shared Polygon boundaries',sourceType:'governed-dataset',sourceVersion:1,geometryType:'Polygon',bbox:[0,0,8,3],visible:true,opacity:0.9,order:800,style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}}];
      report.setup.savedMap=await request(`/projects/${project.id}/maps/${map.id}`,{method:'PATCH',data:{expected_version:map.version,definition:{...map.definition,layers},change_message:'Reference bounded shared-vertex fixture'}});report.setup.complete=true;checkpoint();
    }
    const {projectId,mapId,datasetId,initialFeatures,savedMap}=report.setup,base=`/projects/${projectId}/datasets/${datasetId}`;endpoint=`${base}/features/shared-vertex`;
    card=`[data-dataset-id="${datasetId}"]`;canvas=`${card} .project-feature-canvas`;record=id=>`${card} .project-feature-record[data-feature-id="${id}"]`;url=`${origin}/workspaces?project=${projectId}&map=${mapId}&manage=data#project-data`;
    assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),savedMap);
    const before=(await request(`${base}/features?limit=100`)).features;assert.equal(before.length,3);
    const existingMove=report.writeIntents.find(item=>item.kind==='topology');
    if(!existingMove){for(const feature of initialFeatures)assert.deepEqual(core(before.find(item=>item.id===feature.id)),{id:feature.id,version:1,geometry:feature.geometry,properties:feature.properties});}
    else{report.moveWire=existingMove.data;assert.ok(initialFeatures.slice(0,2).every(feature=>before.find(item=>item.id===feature.id)?.['opengeo:version']===2),'An attempted shared move cannot be replayed; require committed heads before readback-only continuation');}
    report.fixtureReadbackComplete=true;checkpoint();
    report.stage='launching-owned-chromium';checkpoint();driver=await chromiumDriver(state);let page=driver.page;activePage=page;
    const open=async page=>{await page.navigate(url);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===3`);};
    if(!existingMove){
      report.stage='native-shared-vertex-preview';checkpoint();await open(page);await ready(page);await page.click(`${canvas} button`,'Select feature');
      await page.clickPoint((await observeScene(page)).selection);await page.wait(`${q(`${card} form button`,'Save v2')}`);
      assert.match(await page.evalJSON(`document.querySelector(${json(`${canvas} .project-feature-canvas-status`)}).textContent`),new RegExp(`Selected ${initialFeatures[0].id} at v1`));
      await page.click(`${canvas} .project-feature-structure-controls > summary`);await page.click(`${canvas} button`,'Move shared vertex');
      await page.clickPoint((await observeScene(page)).from);await page.clickPoint((await observeScene(page)).to);
      await page.wait(`${q(`${canvas} button`,'Apply shared move')}&&!${q(`${canvas} button`,'Apply shared move')}.disabled`);
      report.previewStatus=await page.evalJSON(`document.querySelector(${json(`${canvas} .project-feature-canvas-status`)}).textContent`);assert.match(report.previewStatus,/2/);
      assert.equal(report.writeIntents.filter(item=>item.kind==='topology').length,0);assert.deepEqual((await request(`${base}/features?limit=100`)).features.map(core),before.map(core),'Preview must not persist either head');
      report.previewScreenshot=await screenshot(page,'preview');checkpoint();allowMutation=true;await page.click(`${canvas} button`,'Apply shared move');
      const mutation=await bounded(mutationResponse,Math.min(5000,deadline-Date.now()),'Shared move response observation deadline');
      assert.equal(mutation.operation,'move_shared_vertex');assert.equal(mutation.collection_generation,2);assert.equal(mutation.feature_count,3);assert.deepEqual(mutation.tombstoned_feature_ids,[]);
      assert.deepEqual(mutation.updated_features.map(item=>[item.id,item['opengeo:version']]).sort(),initialFeatures.slice(0,2).map(item=>[item.id,2]).sort());
    }
    report.stage='shared-vertex-persisted-heads-and-history';checkpoint();
    const collection=await request(`${base}/feature-collection`);assert.equal(collection.geometry_type,'Polygon');assert.equal(collection.generation,2);assert.equal(collection.feature_count,3);
    const heads=(await request(`${base}/features?limit=100`)).features;assert.equal(heads.length,3);const target=report.moveWire.to_position;
    const canonicalRing=ring=>{const open=ring.slice(0,-1),variants=[];for(const points of [open,[...open].reverse()])for(let i=0;i<points.length;i++)variants.push(json([...points.slice(i),...points.slice(0,i)]));return variants.sort()[0];};
    const canonical=geometry=>geometry.coordinates.map(canonicalRing);
    for(const [index,feature] of initialFeatures.entries()){
      const head=heads.find(item=>item.id===feature.id);assert.ok(head);assert.equal(head.geometry.type,'Polygon');assert.deepEqual(head.properties,feature.properties);assert.equal(head['opengeo:version'],index<2?2:1);
      const expected=structuredClone(feature.geometry);if(index<2)expected.coordinates=expected.coordinates.map(ring=>ring.map(position=>json(position)===json([3,1.5])?target:position));
      assert.deepEqual(canonical(head.geometry),canonical(expected));
      if(index===2)assert.deepEqual(core(head),core(before.find(item=>item.id===feature.id)),'The unrelated feature stays exact');
    }
    assert.ok(Math.abs(heads.slice().filter(item=>initialFeatures.slice(0,2).some(source=>source.id===item.id)).reduce((sum,item)=>sum+area(item.geometry),0)-17.5)<1e-7,'Matched shared boundaries retain the rectangle minus the original hole');
    const histories={};for(const [index,feature] of initialFeatures.entries()){
      const history=await request(`${base}/features/${feature.id}/history`);assert.deepEqual(history.revisions.map(item=>[item.version,item.operation]),index<2?[[2,'update'],[1,'create']]:[[1,'create']]);
      assert.deepEqual(history.revisions[0].geometry,heads.find(item=>item.id===feature.id).geometry);assert.deepEqual(canonical(history.revisions.at(-1).geometry),canonical(feature.geometry));histories[feature.id]=history;
    }
    report.persisted={heads,histories,intendedFrom:[3,1.5],intendedTo:[3.5,1.5],actualTo:target,unchangedUnionArea:17.5,unrelatedExact:true};report.writeIntents.find(item=>item.kind==='topology').state='persisted-heads-and-history-readback';checkpoint();
    report.stage='fresh-Project-shared-vertex-history';page=await driver.newPage();activePage=page;await open(page);assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),savedMap);
    for(const feature of initialFeatures){
      const head=heads.find(item=>item.id===feature.id),fresh=await page.evalJSON(`JSON.parse(document.querySelector(${json(`${record(feature.id)} pre`)}).textContent)`);assert.deepEqual(fresh,{geometry:head.geometry,properties:head.properties});
      await page.click(`${record(feature.id)} button`,'History');const revisions=histories[feature.id].revisions;await page.wait(`document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)}).length===${revisions.length}`);
      const snapshots=await page.evalJSON(`[...document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)})].map(item=>({heading:item.querySelector('.project-feature-history-heading').textContent,snapshot:JSON.parse(item.querySelector('details pre').textContent)}))`);
      for(const [index,revision] of revisions.entries()){assert.ok(snapshots[index].heading.startsWith(`v${revision.version} ${revision.operation}`));assert.deepEqual(snapshots[index].snapshot,{geometry:revision.geometry,properties:revision.properties});}
    }
    await ready(page);report.reopenedScreenshot=await screenshot(page,'reopened');report.freshMapAndFeatureHistory=true;
    await cleanup();report.status='pass';report.engines.chromium.status='pass';report.writeIntents.find(item=>item.kind==='topology').state='persisted-and-fresh-immutable-history-readback';checkpoint();return report;
  }catch(error){failure??=error;report.status='failed';report.error=failure.message;if(activePage)try{report.failureDOM=await bounded(activePage.inspectFailure(card),1000,'Bounded shared-move failure DOM');}catch{}checkpoint();throw failure;}
  finally{try{await cleanup();}catch(error){report.status='failed';report.cleanupError=error.message;checkpoint();if(!failure)throw error;}report.totalMilliseconds=Date.now()-started;checkpoint();}
}


async function runOpenLayersStructuralJourney({origin,work,organization,apiRequest,builtShell}) {
  for(const name of ['TREE','MANIFEST'])assert.match(process.env[`OPENGEO_OPENLAYERS_STRUCTURAL_${name}`]??'',/^[a-f0-9]{64}$/);
  assert.equal(builtShell.evidence.treeDigest,process.env.OPENGEO_OPENLAYERS_STRUCTURAL_TREE);
  assert.equal(builtShell.evidence.manifestSha256,process.env.OPENGEO_OPENLAYERS_STRUCTURAL_MANIFEST);
  const manifest=JSON.parse(readFileSync(new URL('../../.local-archives/ckan-recovery-20261023/openlayers-structural-local/manifest.json',import.meta.url)));
  const fixtureBytes=readFileSync(new URL('../../'+manifest.fixtureReceipt.path,import.meta.url));
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),manifest.fixtureReceipt.SHA256);
  const fixture=JSON.parse(fixtureBytes);assert.equal(fixture.status,'pass');assert.equal(fixture.persisted.unrelatedExact,true);
  const baseline=fixture.persisted.heads,participantIds=fixture.setup.initialFeatures.slice(0,2).map(feature=>feature.id),from=fixture.persisted.actualTo,to=[3.25,1.75];
  assert.deepEqual(baseline.map(feature=>[feature.id,feature['opengeo:version']]).sort(),fixture.setup.initialFeatures.map((feature,index)=>[feature.id,index<2?2:1]).sort());
  const {projectId,mapId,datasetId,savedMap}=fixture.setup,base=`/projects/${projectId}/datasets/${datasetId}`,endpoint=`${base}/features/shared-vertex`;
  const expectedBody={features:participantIds.map(feature_id=>({feature_id,expected_version:2})),from_position:from,to_position:to,change_message:'OpenLayers native Modify/Snap shared vertex'};
  const resumePath=process.env.OPENGEO_OPENLAYERS_STRUCTURAL_RESUME,resumeSha=process.env.OPENGEO_OPENLAYERS_STRUCTURAL_RESUME_SHA256;let prior;
  if(resumePath||resumeSha){
    assert.ok(resumePath&&resumeSha&&process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DIAGNOSIS);assert.match(resumeSha,/^[a-f0-9]{64}$/);
    const raw=readFileSync(resumePath);assert.equal(createHash('sha256').update(raw).digest('hex'),resumeSha);prior=JSON.parse(raw);
    assert.equal(prior.schemaVersion,'opengeo.openlayers-structural-browser.1');assert.equal(prior.status,'failed');assert.equal(prior.attempt,1);
    assert.deepEqual(prior.applicationShell,builtShell.evidence);assert.equal(prior.fixtureReceiptSHA256,manifest.fixtureReceipt.SHA256);
    if(prior.engines.chromium.pid){const c=prior.engines.chromium.cleanup;assert.ok(c?.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);}
    const stale=prior.writeIntents.find(intent=>intent.purpose==='stale');if(stale)assert.equal(stale.responseStatus,409,'An ambiguous stale request cannot be replayed');
  }
  const attempt=prior?2:1,prefix=`openlayers-structural-browser-attempt${attempt}`,path=join(work,`${prefix}.json`),started=Date.now(),deadline=Number(process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DEADLINE_MS);
  assert.ok(!existsSync(path)&&!existsSync(path+'.checkpoint'));assert.ok(Number.isSafeInteger(deadline)&&deadline>started&&deadline<=started+100000);
  const report={schemaVersion:'opengeo.openlayers-structural-browser.1',status:'running',attempt,scope:'independent-client-native-OpenLayers-10.10.0-Modify-Snap-governed-shared-vertex',
    applicationShell:builtShell.evidence,fixtureReceiptSHA256:manifest.fixtureReceipt.SHA256,fixture:{projectId,mapId,datasetId,participantIds,fromPosition:from,toPosition:to},
    source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),bundleSHA256:process.env.OPENGEO_OPENLAYERS_STRUCTURAL_BUNDLE_SHA256},
    limits:{outerMilliseconds:120000,apiRequests:60,browserRequests:800,responseAndScreenshotBytes:25*1024**2,setupWrites:0,successfulStructuralWrites:1,staleRequests:1,attempts:2},
    apiRequests:prior?.apiRequests??0,browserRequests:prior?.browserRequests??0,responseBytes:prior?.responseBytes??0,screenshotBytes:prior?.screenshotBytes??0,blockedExternal:prior?.blockedExternal??0,
    writeIntents:prior?structuredClone(prior.writeIntents):[],engines:{chromium:{dialogs:0,errors:[]}},
    ...(prior?{resume:{receiptPath:resumePath,receiptSHA256:resumeSha,diagnosis:process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DIAGNOSIS,setupWritesReplayed:0,acceptedWritesReplayed:0}}:{}),
    notProven:['Hosted identity or AWS transport','Other OpenLayers structural operations','Other rendering engines, browsers or physical devices','PWA/offline behavior','Full OpenLayers/API compatibility or general topology parity']};
  let failure,driver,page,allowedPost=null,activeCard;
  const waits={},resolvers={};for(const purpose of ['accepted','stale'])waits[purpose]=new Promise(resolve=>{resolvers[purpose]=resolve;});
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;writeFileSync(path+'.checkpoint',json(report,null,2)+'\n',{mode:0o600});renameSync(path+'.checkpoint',path);};
  const state={origin,organization,report,checkpoint,deadline,chromiumMilliseconds:100000,blockServiceWorkers:true,cdpDecodedBytes:true,closing:false,confirmExpected:false,fail:error=>{failure??=error;}};
  state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<deadline,'OpenLayers structural active deadline');
    assert.ok(report.apiRequests<=60&&report.browserRequests<=800&&report.responseBytes+report.screenshotBytes<=25*1024**2,'OpenLayers cumulative request/byte ceilings');
    assert.ok(report.writeIntents.filter(intent=>intent.purpose==='accepted').length<=1&&report.writeIntents.filter(intent=>intent.purpose==='stale').length<=1&&report.writeIntents.length<=2,'One accepted move and one stale rejection; zero setup');};
  const request=async url=>{state.guard();report.apiRequests++;state.guard();const response=await bounded(apiRequest(url,{headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization}}),deadline-Date.now(),'OpenLayers read deadline');
    report.responseBytes+=response.body.length;state.guard();assert.equal(response.status,200,`GET ${url}: ${response.body.toString().slice(0,180)}`);return JSON.parse(response.body);};
  state.beforeBrowserRequest=request=>{
    const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/')||['GET','HEAD'].includes(request.method()))return;
    assert.ok(allowedPost,'No browser write before explicit Apply or explicit stale test');assert.equal(request.method(),'POST');assert.equal(url.pathname,`/api${endpoint}`);
    assert.equal(request.headers()['x-opengeo-peer'],'openlayers-structural');assert.deepEqual(request.postDataJSON(),expectedBody);
    assert.ok(!report.writeIntents.some(intent=>intent.purpose===allowedPost),'Never replay an accepted or stale mutation request');
    report.writeIntents.push({purpose:allowedPost,method:'POST',endpoint,data:request.postDataJSON(),state:'attempted'});allowedPost=null;checkpoint();state.guard();
  };
  state.shouldReadBrowserBody=response=>new URL(response.url()).pathname===`/api${endpoint}`&&response.request().method()==='POST';
  state.observeBrowserResponse=(response,body)=>{if(!state.shouldReadBrowserBody(response))return;const intent=report.writeIntents.find(item=>item.state==='attempted');assert.ok(intent);assert.equal(response.status(),intent.purpose==='accepted'?200:409);
    intent.state='response-received';intent.responseStatus=response.status();report[intent.purpose+'Response']=JSON.parse(body);checkpoint();resolvers[intent.purpose](report[intent.purpose+'Response']);};
  const core=feature=>({id:feature.id,version:feature['opengeo:version'],geometry:feature.geometry,properties:feature.properties});
  const sorted=features=>features.map(core).sort((a,b)=>a.id.localeCompare(b.id));
  const canonicalRing=ring=>{const points=ring.slice(0,-1),variants=[];for(const direction of [points,[...points].reverse()])for(let i=0;i<points.length;i++)variants.push(json([...direction.slice(i),...direction.slice(0,i)]));return variants.sort()[0];};
  const canonical=geometry=>geometry.coordinates.map(canonicalRing);
  const expectedHeads=baseline.map(feature=>{const next=structuredClone(feature);if(participantIds.includes(feature.id)){next['opengeo:version']=3;next.geometry.coordinates=next.geometry.coordinates.map(ring=>ring.map(position=>json(position)===json(from)?to:position));}return next;});
  const proof=page=>page.evalJSON('JSON.parse(document.querySelector("#peer-proof").textContent)');
  const scene=(page,studio=false,selector)=>page.evalJSON(`(async()=>{const e=document.querySelector(${json(studio?selector+' .maplibregl-canvas':'#map .ol-viewport')});if(!e)throw Error('Rendered map unavailable');e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const first=e.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),merc=lat=>180/Math.PI*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360)),north=${studio?'merc(3)':'3'},scale=Math.min((r.width-80)/8,(r.height-80)/north),project=([x,y])=>({x:r.left+r.width/2+(x-4)*scale,y:r.top+r.height/2+(north/2-${studio?'merc(y)':'y'})*scale});return {stable:['left','top','width','height'].every(k=>Math.abs(first[k]-r[k])<0.25),from:project(${json(from)}),to:project(${json(to)}),samples:[[2,2],[4.5,2],[7.5,0.5],[1.25,0.75]].map(project),viewport:{width:innerWidth,height:innerHeight}};})()`);
  const screenshot=async(page,suffix)=>{const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();const name=`${prefix}-${suffix}.png`;writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  const ready=async(page,studio=false,selector)=>{
    const rendered={client:studio?'retained-built-Studio':'OpenLayers-10.10.0',attempts:[]};(report.renderedReadiness??=[]).push(rendered);const end=Math.min(deadline,Date.now()+5000);
    for(let i=0;i<3;i++){
      assert.ok(Date.now()<end);const before=await scene(page,studio,selector),png=await page.screenshot();assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();
      const pixels=await page.evalJSON(`(async()=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(${json(png.toString('base64'))}),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(bitmap,0,0);const pixels=${json(before.samples)}.map(p=>[...c.getImageData(Math.round(p.x*bitmap.width/${before.viewport.width}),Math.round(p.y*bitmap.height/${before.viewport.height}),1,1).data]);bitmap.close();return pixels;})()`);
      const bg=[16,35,51],fill=[66,183,168].map((value,j)=>Math.round(value*0.28+bg[j]*0.72)),matches=(pixel,value)=>pixel[3]>=250&&value.every((v,j)=>Math.abs(v-pixel[j])<=5);
      const visible=pixels.slice(0,3).every(pixel=>matches(pixel,fill))&&matches(pixels[3],bg);rendered.attempts.push({stable:before.stable,visible,pixels});checkpoint();if(before.stable&&visible){rendered.ready=true;return before;}
      await page.wait('new Promise(resolve=>setTimeout(()=>resolve(true),80))',Math.max(1,end-Date.now()));
    }throw Error('Actual three Polygon fills and preserved hole did not render');
  };
  const cleanup=async()=>{if(!driver)return;const current=driver;driver=null;report.engines.chromium.cleanup=await current.cleanup();const c=report.engines.chromium.cleanup;assert.ok(c.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);checkpoint();};
  checkpoint();
  try{
    assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),savedMap);
    const before=(await request(`${base}/features?limit=100`)).features;
    const accepted=report.writeIntents.find(intent=>intent.purpose==='accepted');assert.deepEqual(sorted(before),sorted(accepted?expectedHeads:baseline),'Retained fixture heads must match their exact admitted revision');
    report.stage='launching-owned-chromium';checkpoint();driver=await chromiumDriver(state);page=driver.page;
    const peerURL=`${origin}/__openlayers_structural/index.html`,openPeer=async()=>{await page.navigate(peerURL);await page.wait('Boolean(document.querySelector("#peer-proof")?.textContent)&&JSON.parse(document.querySelector("#peer-proof").textContent).rendered===true');const p=await proof(page);assert.ok(!p.error,p.error);assert.equal(p.version,'10.10.0');return p;};
    if(!accepted){
      report.stage='native-OpenLayers-Modify-Snap-preview';checkpoint();await openPeer();const position=await ready(page);report.nativePointer={from:position.from,targetGuide:position.to,released:{x:position.to.x+5,y:position.to.y-4},releaseOffsetPixels:[5,-4]};
      await page.drag(position.from,report.nativePointer.released);await page.wait('!document.querySelector("#apply").disabled');
      report.preview=await proof(page);assert.equal(report.preview.modifyStarts,1);assert.equal(report.preview.modifyEnds,1);assert.equal(report.preview.writes,0);assert.equal(report.preview.staleRequests,0);
      assert.deepEqual(report.preview.modifyEndIds,[...participantIds].sort());assert.equal(report.preview.exactSnappedTarget,true);assert.equal(report.preview.nativeSnapObserved,true);assert.deepEqual(report.preview.actualToPosition,to);
      for(const feature of report.preview.preview){const expected=expectedHeads.find(item=>item.id===feature.id);assert.deepEqual(feature.geometry,expected.geometry);assert.deepEqual(feature.properties,expected.properties);}
      assert.deepEqual(sorted((await request(`${base}/features?limit=100`)).features),sorted(baseline),'Native Modify/Snap preview must not persist');assert.equal(report.writeIntents.length,0);
      report.previewScreenshot=await screenshot(page,'preview');checkpoint();allowedPost='accepted';await page.click('#apply','Apply shared move');
      const mutation=await bounded(waits.accepted,Math.min(5000,deadline-Date.now()),'Observed accepted shared move response');assert.equal(mutation.operation,'move_shared_vertex');assert.equal(mutation.collection_generation,3);assert.equal(mutation.feature_count,3);assert.deepEqual(mutation.tombstoned_feature_ids,[]);
      assert.deepEqual(mutation.updated_features.map(feature=>[feature.id,feature['opengeo:version']]).sort(),participantIds.map(id=>[id,3]).sort());
      for(const feature of report.preview.preview){const returned=mutation.updated_features.find(item=>item.id===feature.id);assert.deepEqual(canonical(returned.geometry),canonical(feature.geometry));assert.deepEqual(returned.properties,feature.properties);}
    }else{report.preview=prior.preview;await openPeer();}
    if(!report.writeIntents.some(intent=>intent.purpose==='stale')){
      report.stage='native-stale-v2-descriptor';checkpoint();await page.wait('!document.querySelector("#stale").disabled');allowedPost='stale';await page.click('#stale','Try stale v2 descriptor');await bounded(waits.stale,Math.min(5000,deadline-Date.now()),'Observed stale-v2 conflict response');
    }
    report.stage='governed-heads-history-and-generation';checkpoint();
    const collection=await request(`${base}/feature-collection`);assert.equal(collection.geometry_type,'Polygon');assert.equal(collection.generation,3);assert.equal(collection.feature_count,3);
    const heads=(await request(`${base}/features?limit=100`)).features;assert.equal(heads.length,3);
    for(const expected of expectedHeads){const head=heads.find(item=>item.id===expected.id);assert.equal(head.geometry.type,'Polygon');assert.equal(head['opengeo:version'],expected['opengeo:version']);assert.deepEqual(head.properties,expected.properties);assert.deepEqual(canonical(head.geometry),canonical(expected.geometry));if(!participantIds.includes(head.id))assert.deepEqual(core(head),core(expected));}
    assert.ok(Math.abs(heads.filter(feature=>participantIds.includes(feature.id)).reduce((sum,feature)=>sum+area(feature.geometry),0)-17.5)<1e-7);
    const histories={};for(const feature of baseline){const history=await request(`${base}/features/${feature.id}/history`),participant=participantIds.includes(feature.id),old=fixture.persisted.histories[feature.id];assert.deepEqual(history.revisions.map(revision=>[revision.version,revision.operation]),participant?[[3,'update'],[2,'update'],[1,'create']]:[[1,'create']]);assert.deepEqual(history.revisions.slice(participant?1:0),old.revisions);assert.deepEqual(history.revisions[0].geometry,heads.find(head=>head.id===feature.id).geometry);histories[feature.id]=history;}
    report.persisted={heads,histories,collectionGeneration:3,featureCount:3,unionArea:17.5,leftHoleRetained:true,unrelatedExact:true,staleRejectedWithoutRevision:true};checkpoint();
    report.stage='fresh-OpenLayers-peer-readback';page=await driver.newPage();const fresh=await openPeer();assert.equal(fresh.readbackOnly,true);assert.equal(fresh.modifyActive,false);assert.equal(fresh.snapActive,false);assert.deepEqual(sorted(fresh.savedHeads),sorted(heads));assert.equal(await page.evalJSON('document.querySelector("#apply").disabled'),true);await ready(page);report.freshPeer=fresh;report.freshPeerScreenshot=await screenshot(page,'peer-reopened');
    report.stage='fresh-retained-Studio-Project-history';page=await driver.newPage();const card=`[data-dataset-id="${datasetId}"]`,canvas=`${card} .project-feature-canvas`,record=id=>`${card} .project-feature-record[data-feature-id="${id}"]`;activeCard=card;
    await page.navigate(`${origin}/workspaces?project=${projectId}&map=${mapId}&manage=data#project-data`);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===3`);assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),savedMap);
    for(const feature of heads){const fresh=await page.evalJSON(`JSON.parse(document.querySelector(${json(`${record(feature.id)} pre`)}).textContent)`);assert.deepEqual(fresh,{geometry:feature.geometry,properties:feature.properties});await page.click(`${record(feature.id)} button`,'History');const revisions=histories[feature.id].revisions;await page.wait(`document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)}).length===${revisions.length}`);const snapshots=await page.evalJSON(`[...document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)})].map(item=>({heading:item.querySelector('.project-feature-history-heading').textContent,snapshot:JSON.parse(item.querySelector('details pre').textContent)}))`);for(const [index,revision] of revisions.entries()){assert.ok(snapshots[index].heading.startsWith(`v${revision.version} ${revision.operation}`));assert.deepEqual(snapshots[index].snapshot,{geometry:revision.geometry,properties:revision.properties});}}
    await ready(page,true,canvas);report.reopenedScreenshot=await screenshot(page,'reopened');report.freshSameProjectMapAndHistory=true;report.stage='accepted';await cleanup();report.status='pass';report.engines.chromium.status='pass';checkpoint();return report;
  }catch(error){failure??=error;report.status='failed';report.error=failure.message;if(page)try{report.failureDOM=await bounded(page.inspectFailure(activeCard),1000,'Bounded independent peer failure DOM');report.failurePeer=await bounded(proof(page),500,'Bounded independent proof');}catch{}checkpoint();throw failure;}
  finally{try{await cleanup();}catch(error){report.status='failed';report.cleanupError=error.message;checkpoint();if(!failure)throw error;}report.totalMilliseconds=Date.now()-started;checkpoint();}
}


async function runOpenLayersCutDissolveJourney({origin,work,organization,apiRequest,builtShell}) {
  for(const name of ['TREE','MANIFEST'])assert.match(process.env[`OPENGEO_OPENLAYERS_STRUCTURAL_${name}`]??'',/^[a-f0-9]{64}$/);
  assert.equal(builtShell.evidence.treeDigest,process.env.OPENGEO_OPENLAYERS_STRUCTURAL_TREE);assert.equal(builtShell.evidence.manifestSha256,process.env.OPENGEO_OPENLAYERS_STRUCTURAL_MANIFEST);
  const manifest=JSON.parse(readFileSync(new URL('../../.local-archives/ckan-recovery-20261023/openlayers-cut-dissolve-local/manifest.json',import.meta.url)));
  const fixtureBytes=readFileSync(new URL('../../'+manifest.fixtureReceipt.path,import.meta.url));assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),manifest.fixtureReceipt.SHA256);
  const fixture=JSON.parse(fixtureBytes);assert.equal(fixture.status,'pass');
  const baseline=fixture.persisted.heads,{projectId,mapId,datasetId}=fixture.fixture,leftId=manifest.scenario.leftFeatureId,left=baseline.find(feature=>feature.id===leftId),base=`/projects/${projectId}/datasets/${datasetId}`;
  assert.deepEqual(baseline.map(feature=>[feature.id,feature['opengeo:version']]),manifest.scenario.initialHeads);assert.equal(left.geometry.type,'Polygon');assert.equal(left.geometry.coordinates.length,2);
  const resumePath=process.env.OPENGEO_OPENLAYERS_STRUCTURAL_RESUME,resumeSha=process.env.OPENGEO_OPENLAYERS_STRUCTURAL_RESUME_SHA256;let prior;
  if(resumePath||resumeSha){assert.ok(resumePath&&resumeSha&&process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DIAGNOSIS);assert.match(resumeSha,/^[a-f0-9]{64}$/);const raw=readFileSync(resumePath);assert.equal(createHash('sha256').update(raw).digest('hex'),resumeSha);prior=JSON.parse(raw);
    assert.equal(prior.schemaVersion,'opengeo.openlayers-cut-dissolve-browser.1');assert.equal(prior.status,'failed');assert.equal(prior.attempt,1);assert.deepEqual(prior.applicationShell,builtShell.evidence);assert.equal(prior.fixtureReceiptSHA256,manifest.fixtureReceipt.SHA256);
    assert.ok(Array.isArray(prior.writeIntents));
    if(prior.writeIntents.length&&!isRejectedCut(prior)){for(const purpose of ['cut','dissolve','stale'])assert.equal(prior.writeIntents.find(intent=>intent.purpose===purpose)?.responseStatus,purpose==='stale'?409:200,'Partial or ambiguous mutations stop; resume supports zero-intent retry or fully committed readback only');assert.ok(prior.donorId&&prior.cutDescriptor&&prior.cutResponse&&prior.dissolveResponse&&prior.staleResponse);}
    if(prior.engines.chromium.pid){const c=prior.engines.chromium.cleanup;assert.ok(c?.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);}}
  function isRejectedCut(receipt) {
    return receipt.writeIntents.length===1&&receipt.writeIntents[0].purpose==='cut'
      &&receipt.writeIntents[0].state==='attempted'&&receipt.error?.includes('422 !== 200')
      &&!receipt.cutResponse&&!receipt.donorId;
  }
  const rejectedCutRetry=Boolean(prior&&isRejectedCut(prior));
  if(rejectedCutRetry){
    const raw=readFileSync(new URL('../../.local-archives/ckan-recovery-20261023/openlayers-cut-dissolve-local/cut-readonly-diagnostic.json',import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'),'4fe3be2babf37f51fa893e5e20cc90dee7e8f2327264d58fd4202eada59500f3');
    const diagnosis=JSON.parse(raw);assert.equal(diagnosis.noMutationConfirmed,true);
    assert.equal(diagnosis.state,'read-only-diagnosis-complete');
  }
  const readbackOnly=Boolean(prior?.writeIntents.length&&!rejectedCutRetry);
  const attempt=prior?2:1,prefix=`openlayers-cut-dissolve-browser-attempt${attempt}`,path=join(work,`${prefix}.json`),started=Date.now(),deadline=Number(process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DEADLINE_MS);
  assert.ok(!existsSync(path)&&!existsSync(path+'.checkpoint'));assert.ok(Number.isSafeInteger(deadline)&&deadline>started&&deadline<=started+100000);
  const report={schemaVersion:'opengeo.openlayers-cut-dissolve-browser.1',status:'running',attempt,scope:'native-OpenLayers-10.10.0-Select-Draw-cancel-measure-Polygon-cut-dissolve',applicationShell:builtShell.evidence,fixtureReceiptSHA256:manifest.fixtureReceipt.SHA256,fixture:{projectId,mapId,datasetId,leftFeatureId:leftId},
    source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),bundleSHA256:process.env.OPENGEO_OPENLAYERS_STRUCTURAL_BUNDLE_SHA256},limits:{outerMilliseconds:120000,apiRequests:60,browserRequests:800,responseAndScreenshotBytes:manifest.limits.nativeResponseAndScreenshotsBytesMaximum,setupWrites:0,successfulStructuralWrites:2,staleRequests:1,attempts:2},
    apiRequests:prior?.apiRequests??0,browserRequests:prior?.browserRequests??0,responseBytes:prior?.responseBytes??0,screenshotBytes:prior?.screenshotBytes??0,blockedExternal:prior?.blockedExternal??0,writeIntents:prior&&!rejectedCutRetry?structuredClone(prior.writeIntents):[],previousRejectedWriteIntents:rejectedCutRetry?structuredClone(prior.writeIntents):[],engines:{chromium:{dialogs:0,errors:[]}},
    ...(prior?{resume:{receiptPath:resumePath,receiptSHA256:resumeSha,diagnosis:process.env.OPENGEO_OPENLAYERS_STRUCTURAL_DIAGNOSIS,readbackOnly,zeroIntentRetry:!readbackOnly&&!rejectedCutRetry,diagnosedRejectedCutRetry:rejectedCutRetry,partialMutationContinuationSupported:false,setupWritesReplayed:0,acceptedWritesReplayed:0},donorId:prior.donorId,cutDescriptor:prior.cutDescriptor,cutResponse:prior.cutResponse,dissolveResponse:prior.dissolveResponse,staleResponse:prior.staleResponse,drawProof:prior.drawProof,cancelProof:prior.cancelProof,measurement:prior.measurement}:{}),
    supportedContinuation:'One diagnosed zero-intent retry against exact v3 heads, or readback-only after observed cut+dissolve+stale outcomes. Partial or ambiguous mutation stages stop without replay.',
    notProven:['Hosted identity or AWS transport','General reshape or topology editing','Other browsers, rendering engines or physical devices','PWA/offline behavior','Full OpenLayers/API compatibility','Ellipsoid or survey-distance measurement']};
  let failure,driver,page,allowedPost=null,activeCard;const waits={},resolvers={};for(const purpose of ['cut','dissolve','stale'])waits[purpose]=new Promise(resolve=>{resolvers[purpose]=resolve;});
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;writeFileSync(path+'.checkpoint',json(report,null,2)+'\n',{mode:0o600});renameSync(path+'.checkpoint',path);};
  const state={origin,organization,report,checkpoint,deadline,chromiumMilliseconds:100000,blockServiceWorkers:true,cdpDecodedBytes:true,closing:false,confirmExpected:false,fail:error=>{failure??=error;}};
  state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<deadline,'OpenLayers cut/dissolve active deadline');assert.ok(report.apiRequests<=60&&report.browserRequests<=800&&report.responseBytes+report.screenshotBytes<=report.limits.responseAndScreenshotBytes,'Cumulative native request/byte limits');assert.ok(report.writeIntents.length<=3&&['cut','dissolve','stale'].every(purpose=>report.writeIntents.filter(intent=>intent.purpose===purpose).length<=1),'Two accepted structural writes, one stale descriptor and zero setup');};
  const request=async url=>{state.guard();report.apiRequests++;state.guard();const response=await bounded(apiRequest(url,{headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization}}),deadline-Date.now(),'Cut/dissolve read deadline');report.responseBytes+=response.body.length;state.guard();assert.equal(response.status,200,`GET ${url}: ${response.body.toString().slice(0,180)}`);return JSON.parse(response.body);};
  state.beforeBrowserRequest=request=>{const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/')||['GET','HEAD'].includes(request.method()))return;
    assert.ok(allowedPost&&!readbackOnly,'Only explicit actions after an exact zero-intent baseline may write');const purpose=allowedPost;assert.equal(request.method(),'POST');assert.equal(url.pathname,`/api${base}/features/${purpose==='dissolve'?'merge-parts':'cut-line'}`);assert.equal(request.headers()['x-opengeo-peer'],'openlayers-structural');assert.equal(request.headers()['x-opengeo-structural-action'],purpose);const body=request.postDataJSON();
    if(purpose==='cut'){assert.deepEqual(body,{feature_id:leftId,expected_version:3,part_index:0,cut_line:report.drawProof.cutter,change_message:'OpenLayers native drawn Polygon cut'});report.cutDescriptor=body;}
    else if(purpose==='dissolve'){assert.equal(body.retained_feature_id,leftId);assert.equal(body.geometry_operation,'dissolve');assert.equal(body.change_message,'OpenLayers native selected cut-piece dissolve');assert.deepEqual(body.features.map(feature=>[feature.feature_id,feature.expected_version]).sort(),[[leftId,4],[report.donorId,1]].sort());assert.deepEqual(Object.keys(body).sort(),['change_message','features','geometry_operation','retained_feature_id']);}
    else assert.deepEqual(body,report.cutDescriptor);
    assert.ok(!report.writeIntents.some(intent=>intent.purpose===purpose));report.writeIntents.push({purpose,endpoint:url.pathname.slice(4),method:'POST',data:body,state:'attempted'});allowedPost=null;checkpoint();state.guard();};
  state.shouldReadBrowserBody=response=>['cut-line','merge-parts'].some(operation=>new URL(response.url()).pathname===`/api${base}/features/${operation}`)&&response.request().method()==='POST';
  state.observeBrowserResponse=(response,body)=>{if(!state.shouldReadBrowserBody(response))return;const intent=report.writeIntents.find(item=>item.state==='attempted');assert.ok(intent);
    const status=response.status(),expected=intent.purpose==='stale'?409:200,maximumProblemBytes=8192;
    intent.responseStatus=status;intent.responseEvidence={bodyBytes:body.length,bodySHA256:createHash('sha256').update(body).digest('hex'),maximumRetainedProblemBytes:maximumProblemBytes};
    intent.state='response-received';
    if(status!==expected){
      intent.knownRejected=status>=400&&status<500;intent.state=intent.knownRejected?'known-rejected-response':'unexpected-response';
      const retained=body.subarray(0,maximumProblemBytes);intent.responseEvidence.retainedBytes=retained.length;intent.responseEvidence.truncated=retained.length<body.length;
      try{if(intent.responseEvidence.truncated)throw Error('Problem body exceeds retention bound');intent.responseEvidence.problem=JSON.parse(retained);}catch{intent.responseEvidence.bodyPreview=retained.toString('utf8');}
    }
    checkpoint();assert.equal(status,expected);
    const parsed=JSON.parse(body);report[intent.purpose+'Response']=parsed;
    if(intent.purpose==='cut'){assert.equal(parsed.created_features.length,1);report.donorId=parsed.created_features[0].id;assert.match(report.donorId,/^[a-f0-9-]{36}$/);}
    checkpoint();resolvers[intent.purpose](parsed);};
  const core=feature=>({id:feature.id,version:feature['opengeo:version'],geometry:feature.geometry,properties:feature.properties});const sorted=features=>features.map(core).sort((a,b)=>a.id.localeCompare(b.id));
  const close=(a,b)=>Math.abs(a-b)<=1e-6;
  const simpleRing=ring=>{let points=ring.slice(0,-1).map(point=>[...point]),changed=true;while(changed&&points.length>3){changed=false;for(let i=0;i<points.length;i++){const a=points[(i+points.length-1)%points.length],b=points[i],c=points[(i+1)%points.length],cross=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]),length=Math.hypot(c[0]-a[0],c[1]-a[1]);if(Math.abs(cross)<=1e-6*Math.max(1,length)&&(b[0]-a[0])*(b[0]-c[0])+(b[1]-a[1])*(b[1]-c[1])<=1e-6){points.splice(i,1);changed=true;break;}}}return points;};
  const sameRing=(a,b)=>{const first=simpleRing(a),second=simpleRing(b);return first.length===second.length&&[second,[...second].reverse()].some(direction=>direction.some((_,offset)=>first.every((point,index)=>point.every((value,dimension)=>close(value,direction[(index+offset)%direction.length][dimension])))));};
  const samePolygon=(actual,expected)=>{assert.equal(actual.type,'Polygon');assert.equal(actual.coordinates.length,expected.coordinates.length);for(let i=0;i<expected.coordinates.length;i++)assert.ok(sameRing(actual.coordinates[i],expected.coordinates[i]),'Footprint/ring must agree within 1e-6 degrees after removing collinear vertices');};
  const clipped=(ring,y,lower)=>{const inside=point=>lower?point[1]<=y:point[1]>=y,result=[];const points=ring.slice(0,-1);for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],ai=inside(a),bi=inside(b);if(ai)result.push(a);if(ai!==bi)result.push([a[0]+(b[0]-a[0])*(y-a[1])/(b[1]-a[1]),y]);}return [...result,result[0]];};
  const assertCut=()=>{const retained=report.cutResponse.retained_feature,created=report.cutResponse.created_features[0],y=report.cutDescriptor.cut_line.coordinates[0][1];assert.equal(retained.id,leftId);assert.equal(retained['opengeo:version'],4);assert.equal(created.id,report.donorId);assert.notEqual(created.id,leftId);assert.equal(created['opengeo:version'],1);assert.deepEqual(retained.properties,left.properties);assert.deepEqual(created.properties,left.properties);samePolygon(retained.geometry,{type:'Polygon',coordinates:[clipped(left.geometry.coordinates[0],y,true),...left.geometry.coordinates.slice(1)]});samePolygon(created.geometry,{type:'Polygon',coordinates:[clipped(left.geometry.coordinates[0],y,false)]});assert.ok(Math.abs(area(retained.geometry)+area(created.geometry)-area(left.geometry))<=1e-6);assert.equal(report.cutResponse.collection_generation,4);assert.equal(report.cutResponse.feature_count,4);assert.equal(report.cutResponse.operation,'cut_line');assert.deepEqual(report.cutResponse.deleted_features,[]);};
  const proof=page=>page.evalJSON('JSON.parse(document.querySelector("#peer-proof").textContent)');
  const scene=(page,studio=false,selector)=>page.evalJSON(`(async()=>{const e=document.querySelector(${json(studio?selector+' .maplibregl-canvas':'#map .ol-viewport')});if(!e)throw Error('Rendered map unavailable');e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const first=e.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),merc=lat=>180/Math.PI*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360)),north=${studio?'merc(3)':'3'},scale=Math.min((r.width-80)/8,(r.height-80)/north),project=([x,y])=>({x:r.left+r.width/2+(x-4)*scale,y:r.top+r.height/2+(north/2-${studio?'merc(y)':'y'})*scale});return {stable:['left','top','width','height'].every(k=>Math.abs(first[k]-r[k])<0.25),selection:project([2,1.6]),topPiece:project([2,2.75]),cutterFrom:project([-0.5,2.4]),cutterTo:project([3.75,2.4]),samples:[[2,2],[4.5,2],[7.5,0.5],[1.25,0.75]].map(project),viewport:{width:innerWidth,height:innerHeight}};})()`);
  const screenshot=async(page,suffix)=>{const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();const name=`${prefix}-${suffix}.png`;writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  const ready=async(page,studio=false,selector)=>{
    const rendered={client:studio?'retained-built-Studio':'OpenLayers-10.10.0',attempts:[]};(report.renderedReadiness??=[]).push(rendered);const end=Math.min(deadline,Date.now()+5000);
    for(let i=0;i<3;i++){
      assert.ok(Date.now()<end);const before=await scene(page,studio,selector),png=await page.screenshot();assert.ok(png.length<=2*1024**2);report.screenshotBytes+=png.length;state.guard();
      const pixels=await page.evalJSON(`(async()=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(${json(png.toString('base64'))}),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(bitmap,0,0);const pixels=${json(before.samples)}.map(p=>[...c.getImageData(Math.round(p.x*bitmap.width/${before.viewport.width}),Math.round(p.y*bitmap.height/${before.viewport.height}),1,1).data]);bitmap.close();return pixels;})()`);
      const bg=[16,35,51],fill=[66,183,168].map((value,j)=>Math.round(value*0.28+bg[j]*0.72)),matches=(pixel,value)=>pixel[3]>=250&&value.every((v,j)=>Math.abs(v-pixel[j])<=5);
      const visible=pixels.slice(0,3).every(pixel=>matches(pixel,fill))&&matches(pixels[3],bg);rendered.attempts.push({stable:before.stable,visible,pixels});checkpoint();if(before.stable&&visible){rendered.ready=true;return before;}
      await page.wait('new Promise(resolve=>setTimeout(()=>resolve(true),80))',Math.max(1,end-Date.now()));
    }throw Error('Actual three Polygon fills and preserved hole did not render');
  };
  const cleanup=async()=>{if(!driver)return;const current=driver;driver=null;report.engines.chromium.cleanup=await current.cleanup();const c=report.engines.chromium.cleanup;assert.ok(c.closed&&c.processExited&&c.processGroupAbsent&&c.profileRemoved);checkpoint();};
  checkpoint();
  try{
    const savedMap=await request(`/projects/${projectId}/maps/${mapId}`);report.savedMap=savedMap;const before=(await request(`${base}/features?limit=100`)).features;
    if(!readbackOnly)assert.deepEqual(sorted(before),sorted(baseline),'Exact retained v3/v3/v1 baseline required');else{assert.equal(before.length,3);assert.equal(before.find(feature=>feature.id===leftId)?.['opengeo:version'],5);}
    if(rejectedCutRetry){
      const collection=await request(`${base}/feature-collection`);
      assert.equal(collection.generation,3);assert.equal(collection.feature_count,3);
      for(const feature of baseline)assert.deepEqual(await request(`${base}/features/${feature.id}/history`),fixture.persisted.histories[feature.id]);
      report.rejectedCutRetryBaselineVerified=true;checkpoint();
    }
    report.stage='launching-owned-chromium';checkpoint();driver=await chromiumDriver(state);page=driver.page;
    const peerURL=`${origin}/__openlayers_structural/index.html`,openPeer=async()=>{await page.navigate(peerURL);await page.wait('Boolean(document.querySelector("#peer-proof")?.textContent)&&JSON.parse(document.querySelector("#peer-proof").textContent).rendered===true');const p=await proof(page);assert.ok(!p.error,p.error);assert.equal(p.case,'cut-dissolve');assert.equal(p.version,'10.10.0');return p;};
    if(!readbackOnly){
      report.stage='native-Select-and-cancel-unfinished-Draw';await openPeer();let position=await ready(page);await page.clickPoint(position.selection);await page.wait(`JSON.stringify(JSON.parse(document.querySelector('#peer-proof').textContent).selectedIds)===${json(json([leftId]))}`);
      await page.click('#draw-cutter','Draw cutter');position=await scene(page);await page.clickPoint(position.cutterFrom);await page.wait('JSON.parse(document.querySelector("#peer-proof").textContent).drawStarts===1');await page.click('#cancel-cutter','Cancel cutter');
      report.cancelProof=await proof(page);assert.equal(report.cancelProof.drawAborts,1);assert.equal(report.cancelProof.drawEnds,0);assert.equal(report.cancelProof.cutter,null);assert.equal(report.cancelProof.measurement,null);assert.equal(report.writeIntents.length,0);assert.deepEqual(sorted((await request(`${base}/features?limit=100`)).features),sorted(baseline));checkpoint();
      report.stage='native-two-point-Draw-measured-preview';await page.click('#draw-cutter','Draw cutter');position=await scene(page);await page.clickPoint(position.cutterFrom);position=await scene(page);await page.clickPoint(position.cutterTo);await page.wait('!document.querySelector("#apply-cut").disabled');
      report.drawProof=await proof(page);assert.equal(report.drawProof.drawStarts,2);assert.equal(report.drawProof.drawEnds,1);assert.equal(report.drawProof.drawAborts,1);assert.equal(report.drawProof.cutWrites,0);assert.equal(report.drawProof.dissolveWrites,0);assert.equal(report.drawProof.cutter.type,'LineString');const coordinates=report.drawProof.cutter.coordinates;assert.equal(coordinates.length,2);
      for(let i=0;i<2;i++)assert.ok(coordinates[i].length===2&&coordinates[i].every(Number.isFinite)&&coordinates[i].every((value,dimension)=>Math.abs(value-manifest.scenario.cutterIntent[i][dimension])<0.05));assert.ok(Math.abs(coordinates[0][1]-coordinates[1][1])<1e-8);
      const degrees=Math.hypot(coordinates[1][0]-coordinates[0][0],coordinates[1][1]-coordinates[0][1]),measurement=report.drawProof.measurement;assert.ok(Math.abs(measurement.planarDegrees-degrees)<1e-10);assert.ok(measurement.sphericalMetres>0&&measurement.sphericalMetres/degrees>100000&&measurement.sphericalMetres/degrees<112000);assert.match(await page.evalJSON('document.querySelector("#cutter-measurement").textContent'),/Spherical length \(approximate metres\).*CRS84 degrees.*not survey distance/);report.measurement=measurement;
      assert.equal(report.writeIntents.length,0);assert.deepEqual(sorted((await request(`${base}/features?limit=100`)).features),sorted(baseline));report.previewScreenshot=await screenshot(page,'preview');checkpoint();
      report.stage='explicit-native-cut';allowedPost='cut';await page.click('#apply-cut','Apply polygon cut');await bounded(waits.cut,Math.min(5000,deadline-Date.now()),'Observed native cut response');assertCut();checkpoint();
      const cutCollection=await request(`${base}/feature-collection`),cutHeads=(await request(`${base}/features?limit=100`)).features;assert.equal(cutCollection.generation,4);assert.equal(cutCollection.feature_count,4);assert.equal(cutHeads.length,4);for(const feature of baseline.filter(feature=>feature.id!==leftId))assert.deepEqual(cutHeads.find(head=>head.id===feature.id),feature);report.cutPersisted={heads:cutHeads,collectionGeneration:4,featureCount:4};checkpoint();
      await page.wait('JSON.parse(document.querySelector("#peer-proof").textContent).savedHeads.length===4');report.stage='native-Select-both-cut-pieces';position=await scene(page);await page.clickPoint(position.selection);await page.wait(`JSON.stringify(JSON.parse(document.querySelector('#peer-proof').textContent).selectedIds)===${json(json([leftId]))}`);position=await scene(page);await page.clickPoint(position.topPiece);await page.wait('!document.querySelector("#apply-dissolve").disabled');report.pieceSelection=await proof(page);assert.deepEqual([...report.pieceSelection.selectedIds].sort(),[leftId,report.donorId].sort());assert.ok(report.pieceSelection.selectEvents.length>=3);
      report.stage='explicit-native-connected-dissolve';allowedPost='dissolve';await page.click('#apply-dissolve','Dissolve selected pieces');const mutation=await bounded(waits.dissolve,Math.min(5000,deadline-Date.now()),'Observed selected-piece dissolve');assert.equal(mutation.operation,'merge_parts');assert.equal(mutation.geometry_operation,'dissolve');assert.equal(mutation.retained_feature.id,leftId);assert.equal(mutation.retained_feature['opengeo:version'],5);assert.equal(mutation.collection_generation,5);assert.equal(mutation.feature_count,3);assert.deepEqual(mutation.created_features,[]);assert.equal(mutation.deleted_features.length,1);assert.equal(mutation.deleted_features[0].feature_id,report.donorId);samePolygon(mutation.retained_feature.geometry,left.geometry);assert.deepEqual(mutation.retained_feature.properties,left.properties);checkpoint();
      report.stage='explicit-captured-stale-cut-v3';await page.wait('!document.querySelector("#stale-cut").disabled');allowedPost='stale';await page.click('#stale-cut','Try stale v3 cut');await bounded(waits.stale,Math.min(5000,deadline-Date.now()),'Observed stale captured cut rejection');
    }
    assertCut();report.stage='final-governed-roundtrip-heads-history';const collection=await request(`${base}/feature-collection`);assert.equal(collection.geometry_type,'Polygon');assert.equal(collection.generation,5);assert.equal(collection.feature_count,3);const heads=(await request(`${base}/features?limit=100`)).features;assert.equal(heads.length,3);
    for(const original of baseline){const head=heads.find(feature=>feature.id===original.id);assert.ok(head);if(original.id===leftId){assert.equal(head['opengeo:version'],5);assert.deepEqual(head.properties,original.properties);samePolygon(head.geometry,original.geometry);assert.ok(Math.abs(area(head.geometry)-area(original.geometry))<=1e-6);}else assert.deepEqual(head,original);}
    const histories={};for(const feature of baseline){const history=await request(`${base}/features/${feature.id}/history`),original=fixture.persisted.histories[feature.id];if(feature.id===leftId){assert.deepEqual(history.revisions.map(revision=>[revision.version,revision.operation]),[[5,'update'],[4,'update'],[3,'update'],[2,'update'],[1,'create']]);assert.deepEqual(history.revisions.slice(2),original.revisions);assert.deepEqual(history.revisions[1].geometry,report.cutResponse.retained_feature.geometry);assert.deepEqual(history.revisions[0].geometry,heads.find(head=>head.id===leftId).geometry);for(const revision of history.revisions)assert.deepEqual(revision.properties,left.properties);}else assert.deepEqual(history,original);histories[feature.id]=history;}
    const donorHistory=await request(`${base}/features/${report.donorId}/history`);assert.deepEqual(donorHistory.revisions.map(revision=>[revision.version,revision.operation]),[[2,'delete'],[1,'create']]);for(const revision of donorHistory.revisions){assert.deepEqual(revision.geometry,report.cutResponse.created_features[0].geometry);assert.deepEqual(revision.properties,left.properties);}histories[report.donorId]=donorHistory;
    report.persisted={heads,histories,collectionGeneration:5,featureCount:3,originalFootprintAndHoleRetained:true,otherHeadsAndHistoriesExact:true,donorTombstonedAtVersion:2,staleRejectedWithoutRevision:true,footprintToleranceDegrees:1e-6};checkpoint();
    report.stage='fresh-readonly-peer-roundtrip-history';page=await driver.newPage();const fresh=await openPeer();assert.equal(fresh.readbackOnly,true);assert.equal(fresh.drawActive,false);assert.equal(fresh.selectActive,false);assert.deepEqual(sorted(fresh.savedHeads),sorted(heads));assert.deepEqual(fresh.histories,histories);assert.equal(await page.evalJSON('[...document.querySelectorAll("#cut-controls button")].every(button=>button.disabled)'),true);await ready(page);report.freshPeer=fresh;report.freshPeerScreenshot=await screenshot(page,'peer-reopened');
    report.stage='fresh-retained-Studio-Project-history';page=await driver.newPage();const card=`[data-dataset-id="${datasetId}"]`,canvas=`${card} .project-feature-canvas`,record=id=>`${card} .project-feature-record[data-feature-id="${id}"]`;activeCard=card;
    await page.navigate(`${origin}/workspaces?project=${projectId}&map=${mapId}&manage=data#project-data`);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===3`);assert.deepEqual(await request(`/projects/${projectId}/maps/${mapId}`),savedMap);
    for(const feature of heads){const reopened=await page.evalJSON(`JSON.parse(document.querySelector(${json(`${record(feature.id)} pre`)}).textContent)`);assert.deepEqual(reopened,{geometry:feature.geometry,properties:feature.properties});await page.click(`${record(feature.id)} button`,'History');const revisions=histories[feature.id].revisions;await page.wait(`document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)}).length===${revisions.length}`);const snapshots=await page.evalJSON(`[...document.querySelectorAll(${json(`${record(feature.id)} .project-feature-history li`)})].map(item=>({heading:item.querySelector('.project-feature-history-heading').textContent,snapshot:JSON.parse(item.querySelector('details pre').textContent)}))`);for(const [index,revision] of revisions.entries()){assert.ok(snapshots[index].heading.startsWith(`v${revision.version} ${revision.operation}`));assert.deepEqual(snapshots[index].snapshot,{geometry:revision.geometry,properties:revision.properties});}}
    await ready(page,true,canvas);report.reopenedScreenshot=await screenshot(page,'reopened');report.freshSameProjectMapAndHistory=true;report.stage='accepted';await cleanup();report.status='pass';report.engines.chromium.status='pass';checkpoint();return report;
  }catch(error){failure??=error;report.status='failed';report.error=failure.message;if(page)try{report.failureDOM=await bounded(page.inspectFailure(activeCard),1000,'Bounded cut/dissolve failure DOM');report.failurePeer=await bounded(proof(page),500,'Bounded peer proof');}catch{}checkpoint();throw failure;}
  finally{try{await cleanup();}catch(error){report.status='failed';report.cleanupError=error.message;checkpoint();if(!failure)throw error;}report.totalMilliseconds=Date.now()-started;checkpoint();}
}

export async function runStructuralBrowserJourney({origin,work,organization,apiRequest,readApi,builtShell}) {
  assert.equal(new URL(origin).hostname,'127.0.0.1');assert.equal(new URL(origin).protocol,'http:');
  assert.equal(new URL(origin).origin,origin,'Exact origin only');
  assert.equal(organization,'10000000-0000-4000-8000-000000000001');assert.ok(builtShell?.evidence?.unchangedBuiltBytes);
  if(process.env.OPENGEO_OPENLAYERS_STRUCTURAL==='1'&&process.env.OPENGEO_OPENLAYERS_STRUCTURAL_CASE==='cut-dissolve')return runOpenLayersCutDissolveJourney({origin,work,organization,apiRequest,builtShell});
  if(process.env.OPENGEO_OPENLAYERS_STRUCTURAL==='1')return runOpenLayersStructuralJourney({origin,work,organization,apiRequest,builtShell});
  if(process.env.OPENGEO_SHARED_VERTEX==='1')return runSharedVertexJourney({origin,work,organization,apiRequest,builtShell});
  if(process.env.OPENGEO_POLYGON_DISSOLVE==='1')return runPolygonDissolveJourney({origin,work,organization,apiRequest,builtShell});
  if(process.env.OPENGEO_STRUCTURAL_BROWSER_CUT_ONLY==='1')return runCutOnlyJourney({origin,work,organization,apiRequest,builtShell});
  const path=join(work,'structural-browser.json');
  assert.ok([path,`${path}.checkpoint`,...['firefox','chromium'].flatMap(engine=>[join(work,`structural-browser-${engine}.png`),join(work,`structural-browser-${engine}-edit.png`)])].every(file=>!existsSync(file)),
    'Existing checkpoint or screenshot forbids setup or browser replay; reconcile its IDs first');
  const resumePath=process.env.OPENGEO_STRUCTURAL_BROWSER_RESUME,resumeSha=process.env.OPENGEO_STRUCTURAL_BROWSER_RESUME_SHA256;
  const priorUsage={activeMilliseconds:0,apiRequests:0,browserRequests:0,responseBytes:0,blockedExternal:0,firefoxCommands:0,firefoxActionCommands:0};
  let resume;
  if(resumePath||resumeSha){
    assert.ok(resumePath&&resumeSha,'Resume requires a read-only archived receipt path and its exact hash');
    assert.notEqual(resolve(resumePath),resolve(path),'Resume source must be archived separately from the new receipt');
    assert.equal(resumeSha,'3d999e70d7dd6691a5fa6236683fc6c17d6a7bbbaaeededac8e6227dd2ba53f9','Only the diagnosed unchanged fixture may resume');
    const bytes=readFileSync(resumePath);assert.equal(createHash('sha256').update(bytes).digest('hex'),resumeSha,'Archived receipt must be immutable');resume=JSON.parse(bytes);
    assert.equal(resume.schemaVersion,'opengeo.structural-browser.1');assert.equal(resume.status,'failed');assert.equal(resume.stage,'firefox-insert-undo-redo');
    assert.equal(resume.setup.complete,true);assert.equal(resume.writeIntents.length,7);
    assert.ok(resume.writeIntents.every(intent=>intent.state==='response-received'&&[200,201].includes(intent.status)),'No unknown or attempted UI writes may resume');
    assert.equal(resume.applicationShell.treeDigest,builtShell.evidence.treeDigest);assert.equal(resume.applicationShell.manifestSha256,builtShell.evidence.manifestSha256);
    // First failed attempt: 4119 ms, 1 browser request, 9 commands / 8 actions.
    // Diagnosed retry: 6929 ms, 7 API / 59 browser / 8804 bytes, 69 / 11.
    Object.assign(priorUsage,{activeMilliseconds:11048,apiRequests:7,browserRequests:60,responseBytes:8804,blockedExternal:1,firefoxCommands:78,firefoxActionCommands:19});
  }
  const started=Date.now(),report={schemaVersion:'opengeo.structural-browser.1',status:'running',startedAt:new Date().toISOString(),
    limits:{activeMilliseconds:130000,firefoxMilliseconds:80000,chromiumMilliseconds:60000,firefoxCommands:900,firefoxActionCommands:250,
      apiRequests:150,browserRequests:2000,responseBytes:40*1024**2,firefoxProfileBytes:64*1024**2,cleanupMilliseconds:10000},
    apiRequests:priorUsage.apiRequests,browserRequests:priorUsage.browserRequests,responseBytes:priorUsage.responseBytes,blockedExternal:priorUsage.blockedExternal,
    priorUsage,setup:{},writeIntents:[],engines:{firefox:{dialogs:0,errors:[]},chromium:{dialogs:0,errors:[]}},
    ...(resume?{resume:{receiptPath:resumePath,receiptSha256:resumeSha,changedMethod:'Observe BiDi events without request interception; owned loopback denial proxy with no direct failover; GET-validate and reuse committed fixture',setupWritesReplayed:0,readbackComplete:false}}:{}),
    applicationShell:builtShell.evidence,source:{journeySha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
      bidiSha256:createHash('sha256').update(readFileSync(new URL('./native-firefox-bidi.mjs',import.meta.url))).digest('hex')},
    byteAccounting:'Native JSON bytes; uncompressed BiDi content.size/bodySize; Chromium decoded response bodies',
    notProven:['All six geometry families','Other structural operations','Production identity or AWS transport','Full upstream product parity']};
  let failure,activeDriver;
  const checkpoint=()=>{report.elapsedMilliseconds=Date.now()-started;report.cumulativeActiveMilliseconds=priorUsage.activeMilliseconds+report.elapsedMilliseconds;
    writeFileSync(`${path}.checkpoint`,json(report,null,2)+'\n',{mode:0o600});renameSync(`${path}.checkpoint`,path);};
  const state={origin,organization,report,checkpoint,priorUsage,deadline:started+130000-priorUsage.activeMilliseconds,confirmExpected:false,closing:false};
  state.fail=error=>{failure??=error;};
  const guard=state.guard=()=>{if(failure)throw failure;assert.ok(Date.now()<state.deadline,'Shared 130-second active ceiling');
    assert.ok(report.apiRequests<=150&&report.browserRequests<=2000&&report.responseBytes<=40*1024**2,'Shared API/browser/response ceiling');};
  const request=async(endpoint,{method='GET',data,status=200}={})=>{
    guard();report.apiRequests++;guard();
    const intent=method==='GET'?null:{endpoint,method,state:'attempted',...(data?{data}:{}),atMilliseconds:Date.now()-started};
    if(intent){report.writeIntents.push(intent);checkpoint();}
    let response;
    try{response=await bounded(apiRequest(endpoint,{method,headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,
      ...(data?{'content-type':'application/json'}:{})},...(data?{body:Buffer.from(json(data))}:{})}),state.deadline-Date.now(),`Shared deadline awaiting ${method} ${endpoint}`);}
    catch(error){if(intent){intent.responseUnknown=true;intent.error=error.message;checkpoint();}throw error;}
    report.responseBytes+=response.body.length;guard();assert.equal(response.status,status,`${method} ${endpoint}: ${response.body.toString().slice(0,300)}`);
    const result=response.body.length?JSON.parse(response.body):null;
    if(intent){intent.state='response-received';intent.status=response.status;intent.resultId=result?.id??result?.dataset_id??result?.dataset?.id??null;checkpoint();}
    return result;
  };
  const savePng=async(page,name)=>{const png=await page.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.ok(png.length<32*1024**2,'Bounded screenshot');writeFileSync(join(work,name),png,{flag:'wx',mode:0o600});return {name,bytes:png.length};};
  const finishDriver=async(engine,driver)=>{
    const facts=report.engines[engine];facts.cleanup=await driver.cleanup();
    if(engine==='chromium')assert.ok(facts.cleanup.closed&&facts.cleanup.processExited&&facts.cleanup.processGroupAbsent&&facts.cleanup.profileRemoved,'Owned Chromium group and temporary profile must be absent');
    if(engine==='firefox'){facts.commands=driver.client.commands;facts.actionCommands=driver.client.actionCommands;
      facts.cumulativeCommands=priorUsage.firefoxCommands+facts.commands;facts.cumulativeActionCommands=priorUsage.firefoxActionCommands+facts.actionCommands;
      assert.ok(facts.cleanup.profileBytes<=report.limits.firefoxProfileBytes,'Firefox profile budget');checkpoint();
      assert.ok(facts.cleanup.processGroupAbsent);rmSync(driver.client.profilePath,{recursive:true});facts.profileRemoved=true;}
    facts.finishedMilliseconds=Date.now()-started;checkpoint();
  };
  checkpoint();
  try {
    report.stage='firefox-webgl-availability';checkpoint();activeDriver=await firefoxDriver(state);
    await activeDriver.page.navigate('data:text/html,'+encodeURIComponent('<!doctype html><title>OpenGeo Firefox WebGL gate</title><canvas width="32" height="32"></canvas>'));
    report.engines.firefox.webgl=await activeDriver.page.evalJSON('(()=>{const gl=document.querySelector("canvas").getContext("webgl2");if(!gl)return {supported:false};const result={supported:true,version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER)};gl.getExtension("WEBGL_lose_context")?.loseContext();return result;})()');
    if(!report.engines.firefox.webgl.supported){report.failureKind='native-firefox-webgl-unavailable';checkpoint();throw Error('Native Firefox WebGL2 unavailable; no fixture writes attempted');}
    let project,map;
    if(resume){
      report.stage='resume-fixture-readback';report.setup={...resume.setup};checkpoint();
      project=await request(`/projects/${resume.setup.projectId}`);assert.equal(project.id,resume.setup.projectId);assert.equal(project.name,resume.writeIntents[0].data.name);
      map=await request(`/projects/${project.id}/maps/${resume.setup.mapId}`);assert.equal(map.id,resume.setup.mapId);assert.equal(map.project_id,project.id);
      assert.equal(map.version,2);assert.deepEqual(map.definition,resume.writeIntents[6].data.definition,'Saved composition must exactly match the committed setup');
      for(const engine of ['firefox','chromium']){
        const previous=resume.engines[engine],facts=report.engines[engine];
        assert.equal(previous.collectionCreated,true);Object.assign(facts,{datasetId:previous.datasetId,featureIds:previous.featureIds,initialFeatures:previous.initialFeatures,collectionCreated:true});
        const base=`/projects/${project.id}/datasets/${facts.datasetId}`;
        const collection=await request(`${base}/feature-collection`);assert.equal(collection.dataset_id,facts.datasetId);assert.equal(collection.geometry_type,'MultiPolygon');
        assert.equal(collection.generation,1);assert.equal(collection.feature_count,2);
        const current=(await request(`${base}/features?limit=100`)).features;assert.equal(current.length,2);
        for(const expected of facts.initialFeatures){const feature=current.find(item=>item.id===expected.id);assert.ok(feature,'Exact initial feature identity must survive');
          assert.equal(feature['opengeo:version'],1);assert.deepEqual({type:feature.type,id:feature.id,geometry:feature.geometry,properties:feature.properties},expected);}
        facts.resumeInitialReadback=true;checkpoint();
      }
      report.resume.readbackComplete=true;checkpoint();
    }else{
    report.stage='fixture-setup';checkpoint();
    project=await request('/projects',{method:'POST',status:201,data:{name:'Rendered structural editing, Firefox and Chromium'}});report.setup.projectId=project.id;checkpoint();
    map=await request(`/projects/${project.id}/maps`,{method:'POST',status:201,data:{name:'Structural browser composition'}});report.setup.mapId=map.id;checkpoint();
    const layers=[];
    for(const engine of ['firefox','chromium']){
      const facts=report.engines[engine],ids=[randomUUID(),randomUUID()];facts.featureIds=ids;
      const features=ids.map((id,index)=>({type:'Feature',id,geometry:geometry(index),properties:{name:`${engine} ${index?'donor':'retained'}`}}));
      facts.initialFeatures=features;checkpoint();const bytes=Buffer.from(json({type:'FeatureCollection',features}));
      const ticket=await request(`/projects/${project.id}/uploads/request`,{method:'POST',status:201,data:{name:`${engine} structural polygons`,classification:'internal',format:'geojson',
        filename:`${engine}-structural.geojson`,content_type:'application/geo+json',size_bytes:bytes.length,checksum_sha256:createHash('sha256').update(bytes).digest('hex')}});
      facts.datasetId=ticket.dataset?.id??ticket.dataset_id;assert.match(facts.datasetId,/^[0-9a-f-]{36}$/);checkpoint();
      await request(`/projects/${project.id}/datasets/${facts.datasetId}/feature-collection`,{method:'POST',status:201,data:{geometry_type:'MultiPolygon',fields:[{name:'name',type:'string',required:true}],features}});
      facts.collectionCreated=true;checkpoint();
      layers.push({layerId:`dataset_${facts.datasetId}_live`,datasetId:facts.datasetId,title:`${engine} structural polygons`,sourceType:'governed-dataset',sourceVersion:1,
        geometryType:'MultiPolygon',bbox:[0,0,3,2],visible:true,opacity:0.9,order:800+layers.length,style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}});
    }
    await request(`/projects/${project.id}/maps/${map.id}`,{method:'PATCH',data:{expected_version:map.version,definition:{...map.definition,layers},change_message:'Reference the two bounded structural browser fixtures'}});
    report.setup.complete=true;checkpoint();
    }
    for(const engine of ['firefox','chromium']){
      if(engine==='chromium')activeDriver=await chromiumDriver(state);
      const facts=report.engines[engine],dataset=facts.datasetId,[retained,donor]=facts.featureIds,base=`/projects/${project.id}/datasets/${dataset}`;
      const card=`[data-dataset-id="${dataset}"]`,record=`${card} .project-feature-record[data-feature-id="${retained}"]`,canvas=`${card} .project-feature-canvas`;
      const url=`${origin}/workspaces?project=${project.id}&map=${map.id}&manage=data#project-data`;
      const open=async page=>{await page.navigate(url);await page.click(`${card} button`,'Edit features');await page.wait(`document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===2`);};
      const snapshot=page=>page.evalJSON(`(()=>{const record=document.querySelector(${json(record)});return {identity:record.querySelector('strong').textContent,...JSON.parse(record.querySelector('pre').textContent)};})()`);
      const draft=page=>page.evalJSON(`JSON.parse(document.querySelector(${json(`${card} textarea[aria-label="GeoJSON geometry"]`)}).value)`);
      report.stage=`${engine}-insert-undo-redo`;checkpoint();let page=activeDriver.page;await open(page);await page.click(`${record} button`,'Edit');
      await page.click(`${canvas} .project-feature-structure-controls > summary`);await page.click(`${canvas} button`,'Insert vertex');
      const before=await draft(page);assert.equal(pointCount(before),5);
      const point=await renderedSegmentReady(page,canvas,facts,state);
      await page.clickPoint(point);
      await page.wait(`(()=>{try{return JSON.parse(document.querySelector(${json(`${card} textarea[aria-label="GeoJSON geometry"]`)}).value).coordinates[0][0].length===6;}catch{return false;}})()`);
      const inserted=await draft(page);assert.equal(pointCount(inserted),6);assert.match(await page.evalJSON(`document.querySelector(${json(`${canvas} .project-feature-canvas-status`)}).textContent`),/Inserted a vertex/);
      await page.click(`${canvas} button`,'Undo');assert.deepEqual(await draft(page),before);
      await page.click(`${canvas} button`,'Redo');assert.deepEqual(await draft(page),inserted);
      facts.renderedSegment={target:'MapLibre WebGL hit layer',point,beforeCount:5,insertedCount:6,undoRestored:true,redoRestored:true};
      facts.editScreenshot=await savePng(page,`structural-browser-${engine}-edit.png`);checkpoint();
      const saveIntent={engine,method:'PUT',endpoint:`${base}/features/${retained}`,expectedVersion:1,state:'UI-save-attempted',geometry:inserted};report.writeIntents.push(saveIntent);checkpoint();
      await page.click(`${card} form button`,'Save v2');await page.wait(`${q(`${record} strong`)}?.textContent.endsWith(' · v2')`);
      const saved=(await request(`${base}/features?limit=100`)).features.find(feature=>feature.id===retained);
      assert.equal(saved['opengeo:version'],2);assert.deepEqual(saved.geometry,inserted);facts.savedVersion2=saved;saveIntent.state='persisted-version-2-readback';checkpoint();
      report.stage=`${engine}-fresh-v2-dissolve`;checkpoint();page=await activeDriver.newPage();await open(page);
      const reopened=await snapshot(page);assert.ok(reopened.identity.endsWith(' · v2'));assert.deepEqual(reopened.geometry,inserted);facts.freshVersion2=true;checkpoint();
      const structure=`${card} .project-feature-polygon-structure`;await page.click(`${structure} > summary`);
      for(const id of [retained,donor])await page.check(`${card} input[aria-label="Select feature ${id} for polygon merge"]`);
      await page.select(`${structure} select`,retained);await page.check(`${structure} input[aria-label="Dissolve boundaries"]`);
      const mergeIntent={engine,method:'POST',endpoint:`${base}/features/merge-parts`,state:'UI-dissolve-attempted',retainedFeatureId:retained,geometryOperation:'dissolve',expectedVersions:{[retained]:2,[donor]:1}};report.writeIntents.push(mergeIntent);checkpoint();
      state.confirmExpected=true;await page.click(`${structure} button`,'Merge selected');
      await page.wait(`${q(`${record} strong`)}?.textContent.endsWith(' · v3')&&document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===1`);
      assert.equal(state.confirmExpected,false);assert.equal(facts.dialogs,1);
      const merged=(await request(`${base}/features?limit=100`)).features;assert.equal(merged.length,1);assert.equal(merged[0].id,retained);
      assert.equal(merged[0]['opengeo:version'],3);assert.deepEqual(merged[0].properties,{name:`${engine} retained`});assert.equal(merged[0].geometry.type,'MultiPolygon');assert.ok(Math.abs(area(merged[0].geometry)-6)<1e-9);
      const donorHistory=await request(`${base}/features/${donor}/history`),retainedHistory=await request(`${base}/features/${retained}/history`);
      assert.deepEqual(donorHistory.revisions.map(revision=>revision.operation),['delete','create']);assert.deepEqual(retainedHistory.revisions.map(revision=>revision.operation),['update','update','create']);
      assert.deepEqual(retainedHistory.revisions[1].geometry,inserted);facts.dissolvedVersion3=merged[0];facts.donorHistory=donorHistory;facts.retainedHistory=retainedHistory;mergeIntent.state='persisted-version-3-and-donor-history-readback';checkpoint();
      report.stage=`${engine}-fresh-v3-history`;checkpoint();page=await activeDriver.newPage();await page.navigate(url);await page.click(`${card} button`,'Edit features');
      await page.wait(`${q(`${record} strong`)}?.textContent.endsWith(' · v3')&&document.querySelectorAll(${json(`${card} .project-feature-record`)}).length===1`);
      assert.deepEqual((await snapshot(page)).geometry,merged[0].geometry);await page.click(`${record} button`,'History');
      await page.wait(`document.querySelectorAll(${json(`${record} .project-feature-history li`)}).length===3`);
      const historyText=await page.evalJSON(`document.querySelector(${json(`${record} .project-feature-history`)}).textContent`);assert.match(historyText,/v3 update/);assert.match(historyText,/v2 update/);assert.match(historyText,/v1 create/);
      await page.evalJSON(`(async()=>{document.querySelector(${json(`${canvas} .project-feature-map`)}).scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true;})()`);
      facts.screenshot=await savePng(page,`structural-browser-${engine}.png`);facts.freshVersion3AndHistory=true;facts.status='pass';checkpoint();
      await finishDriver(engine,activeDriver);activeDriver=null;
    }
    guard();report.status='pass';report.result='Two browsers each completed rendered MultiPolygon insertion, undo/redo, normal v2 Save, fresh reopen, selected dissolve to v3 and fresh history reopen';checkpoint();return report;
  }catch(error){failure??=error;report.status='failed';report.error=failure.message;if(error.cleanup)report.startupCleanup=error.cleanup;checkpoint();throw failure;}
  finally {
    if(activeDriver)try{await finishDriver(report.stage.startsWith('chromium')?'chromium':'firefox',activeDriver);}catch(error){report.cleanupError=error.message;report.status='failed';}
    else if(state.firefox&&!report.engines.firefox.cleanup)try{report.engines.firefox.cleanup=await state.firefox.cleanup();checkpoint();
      if(report.engines.firefox.cleanup.processGroupAbsent){rmSync(state.firefox.profilePath,{recursive:true});report.engines.firefox.profileRemoved=true;}}catch(error){report.cleanupError=error.message;}
    if(report.startupCleanup?.processGroupAbsent&&report.firefoxProfile&&!report.engines.firefox.profileRemoved){checkpoint();rmSync(report.firefoxProfile,{recursive:true});report.engines.firefox.profileRemoved=true;}
    if(state.chromiumServer&&state.chromiumServer.process().exitCode===null&&state.chromiumServer.process().signalCode===null)
      try{await bounded(state.chromiumServer.kill(),5000,'Chromium final cleanup deadline');}catch(error){report.chromiumCleanupError=error.message;}
    report.totalMilliseconds=Date.now()-started;checkpoint();
  }
}
