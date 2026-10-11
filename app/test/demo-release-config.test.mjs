import assert from 'node:assert/strict';
import {it} from 'node:test';
import {demoSurface, assertBrowserDemoRelease, BROWSER_DEMO_LIMITS} from '../scripts/demo-release-config.mjs';
import {sealManifest, sha256, digestFileRecords} from '../scripts/release-utils.mjs';
import {readFile} from 'node:fs/promises';
import {RENDERER_FRAME_PATH, withoutRendererFrameBehavior} from '../scripts/studio-edge-boundary.mjs';
function manifest(paths=['index.html'], bytes=4) {
 const files=[...paths].sort().map(path=>({path,bytes,sha256:sha256('demo')}));
 return sealManifest({schemaVersion:'opengeo.demo-build.1.0.0',demoOrigin:'https://demo.studio.opengeo.tools',artifactTree:{algorithm:'sha256',digest:digestFileRecords(files),files},routes:[{path:'/'}],aliases:[]});
}
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
it('allows rollback with the reviewed renderer frame while rejecting wider or writable routes',async()=>{
 const source=await readFile(new URL('../scripts/rollback-demo-site.mjs',import.meta.url),'utf8');
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 let options;
 await new AsyncFunction('demoSurface','assertBrowserDemoRelease','rollbackStaticRelease','withoutRendererFrameBehavior','process',
   source.replace(/^import .*;\n/gm,''))(demoSurface,assertBrowserDemoRelease,async value=>{options=value;},withoutRendererFrameBehavior,
   {env:{OPEN_GEO_DEMO_ENVIRONMENT:'production',OPEN_GEO_DEMO_SURFACE:'browser'}});
 const staticOrigin={Id:'demo-static'};
 const frame={PathPattern:RENDERER_FRAME_PATH,TargetOriginId:staticOrigin.Id,
   CachePolicyId:'4135ea2d-6df8-44a3-9df3-4b5a84be39ad',ViewerProtocolPolicy:'redirect-to-https',
   ResponseHeadersPolicyId:'isolated-frame',AllowedMethods:{Items:['GET','HEAD'],CachedMethods:{Items:['GET','HEAD']}}};
 const config={Origins:{Items:[staticOrigin]},DefaultCacheBehavior:{TargetOriginId:staticOrigin.Id},CacheBehaviors:{Items:[frame]}};
 assert.doesNotThrow(()=>options.validateDistribution({config,staticOrigin}));
 for(const patch of [{PathPattern:'renderer-runtime/*'},{TargetOriginId:'unreviewed-origin'},
   {AllowedMethods:{Items:['GET','HEAD','POST'],CachedMethods:{Items:['GET','HEAD']}}}]) {
  const invalid=structuredClone(config);Object.assign(invalid.CacheBehaviors.Items[0],patch);
  assert.throws(()=>options.validateDistribution({config:invalid,staticOrigin}));
 }
 const unexpected=structuredClone(config);unexpected.CacheBehaviors.Items.push({...frame,PathPattern:'admin/*'});
 assert.throws(()=>options.validateDistribution({config:unexpected,staticOrigin}));
});
