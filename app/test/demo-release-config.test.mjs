import assert from 'node:assert/strict';
import {it} from 'node:test';
import {demoSurface, assertBrowserDemoRelease, assertDemoRollbackDistribution, BROWSER_DEMO_LIMITS} from '../scripts/demo-release-config.mjs';
import {sealManifest, sha256, digestFileRecords} from '../scripts/release-utils.mjs';
import {RENDERER_FRAME_PATH} from '../scripts/studio-edge-boundary.mjs';
function manifest(paths=['index.html'], bytes=4) {
 const files=[...paths].sort().map(path=>({path,bytes,sha256:sha256('demo')}));
 return sealManifest({schemaVersion:'opengeo.demo-build.1.0.0',demoOrigin:'https://demo.studio.opengeo.tools',artifactTree:{algorithm:'sha256',digest:digestFileRecords(files),files},routes:[{path:'/'}],aliases:[]});
}
it('includes public credits while retaining the historical anonymous one-page release',()=>{
 const reseal=({manifestSha256,...payload})=>sealManifest(payload);
 const previous=manifest();
 assertBrowserDemoRelease(previous);
 const current=manifest(['index.html','credits.html']);
 current.routes.push({path:'/credits',htmlPath:'credits.html'});
 const file=current.artifactTree.files.find(file=>file.path==='credits.html');
 current.aliases.push({key:'credits',sourcePath:'credits.html',bytes:file.bytes,sha256:file.sha256,contentType:'text/html; charset=utf-8'});
 assertBrowserDemoRelease(reseal(current));
 const missing=manifest();missing.routes.push({path:'/credits',htmlPath:'credits.html'});
 assert.throws(()=>assertBrowserDemoRelease(reseal(missing)));
 const unexpected=manifest(['index.html','credits.html']);
 unexpected.routes.push({path:'/admin',htmlPath:'credits.html'});
 assert.throws(()=>assertBrowserDemoRelease(reseal(unexpected)));
});
it('keeps historical defaults and requires explicit production browser selection',()=>{
 assert.equal(demoSurface('production'),'managed');assert.equal(demoSurface('dev'),'browser');assert.equal(demoSurface('production','browser'),'browser');
 for(const args of [['dev','managed'],['production','invalid'],['unknown','browser']])assert.throws(()=>demoSurface(...args));
});
it('keeps core growth bounded independently of the optional renderer allowance',()=>{
 const paths=Array.from({length:BROWSER_DEMO_LIMITS.coreFiles-1},(_,i)=>`_import/module-${i}.js`);
 assertBrowserDemoRelease(manifest(['index.html',...paths]));
 assert.throws(()=>assertBrowserDemoRelease(manifest(['index.html',...paths,'_import/extra.js'])));
});
it('rejects unknown or incomplete SDK files rather than exempting a whole directory',()=>{
 for(const path of ['renderer-runtime/unreviewed/index.js',
   'renderer-runtime/cesium-1.145.0/index.js','renderer-runtime/mapbox-3.30.0/mapbox-gl.js']) {
   assert.throws(()=>assertBrowserDemoRelease(manifest(['index.html',path])),/pinned SDKs/);
 }
});
it('accepts only bounded anonymous Demo artifacts',()=>{
 assertBrowserDemoRelease(manifest());
 for(const privatePath of ['auth-config.json','workspaces.html','login.html','admin.html'])assert.throws(()=>assertBrowserDemoRelease(manifest(['index.html',privatePath])));
 assert.throws(()=>assertBrowserDemoRelease(manifest(['index.html'],21*1024*1024)));
 assert.throws(()=>assertBrowserDemoRelease({...manifest(),authConfig:{path:'auth-config.json'}}));
 assert.throws(()=>assertBrowserDemoRelease({...manifest(),routes:[{path:'/workspaces'}]}));
});
it('allows rollback with the reviewed renderer frame while rejecting wider or writable routes',()=>{
 const staticOrigin={Id:'demo-static'};
 const frame={PathPattern:RENDERER_FRAME_PATH,TargetOriginId:staticOrigin.Id,
   CachePolicyId:'4135ea2d-6df8-44a3-9df3-4b5a84be39ad',ViewerProtocolPolicy:'redirect-to-https',
   ResponseHeadersPolicyId:'isolated-frame',AllowedMethods:{Items:['GET','HEAD'],CachedMethods:{Items:['GET','HEAD']}}};
 const config={Origins:{Items:[staticOrigin]},DefaultCacheBehavior:{TargetOriginId:staticOrigin.Id},CacheBehaviors:{Items:[frame]}};
 assert.doesNotThrow(()=>assertDemoRollbackDistribution({config,staticOrigin}));
 for(const patch of [{PathPattern:'renderer-runtime/*'},{TargetOriginId:'unreviewed-origin'},
   {AllowedMethods:{Items:['GET','HEAD','POST'],CachedMethods:{Items:['GET','HEAD']}}}]) {
  const invalid=structuredClone(config);Object.assign(invalid.CacheBehaviors.Items[0],patch);
  assert.throws(()=>assertDemoRollbackDistribution({config:invalid,staticOrigin}));
 }
 const unexpected=structuredClone(config);unexpected.CacheBehaviors.Items.push({...frame,PathPattern:'admin/*'});
 assert.throws(()=>assertDemoRollbackDistribution({config:unexpected,staticOrigin}));
 const apiOriginDomain='abcdefghij.execute-api.us-east-1.amazonaws.com';
 const managed=structuredClone(config);managed.Origins.Items.push({Id:'api',DomainName:apiOriginDomain});
 managed.CacheBehaviors.Items.push({PathPattern:'auth-config.json',TargetOriginId:staticOrigin.Id},{PathPattern:'api/*',TargetOriginId:'api'});
 assert.doesNotThrow(()=>assertDemoRollbackDistribution({config:managed,staticOrigin,managed:true,apiOriginDomain}));
 assert.throws(()=>assertDemoRollbackDistribution({config:managed,staticOrigin}));
 for(const changed of ['https://attacker.example','other12345.execute-api.us-east-1.amazonaws.com']) {
  assert.throws(()=>assertDemoRollbackDistribution({config:managed,staticOrigin,managed:true,apiOriginDomain:changed}));
 }
 managed.CacheBehaviors.Items.at(-1).TargetOriginId=staticOrigin.Id;
 assert.throws(()=>assertDemoRollbackDistribution({config:managed,staticOrigin,managed:true,apiOriginDomain}));
});
