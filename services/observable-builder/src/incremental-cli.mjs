// Invoked only with the verified, generated configuration by contract.mjs.
// This process has the same minimal environment and network boundary as a build.
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {incrementalPageRenderer, installIncrementalPageHook} from './incremental-pages.mjs';

const [modulePath,configPath,scope,inputHash] = process.argv.slice(2);
if (!modulePath || !configPath || !scope || !/^[a-f0-9]{64}$/.test(scope)) throw Error('Invalid incremental build context');
const buildUrl=pathToFileURL(resolve(modulePath));
const hook=installIncrementalPageHook(buildUrl);
const {build,FileBuildEffects}=await import(buildUrl.href);
hook.deregister();
const {readConfig}=await import(new URL('./config.js',buildUrl));
const {renderPage}=await import(new URL('./render.js',buildUrl));
const config=await readConfig(configPath);
const renderer=incrementalPageRenderer({scope,renderPage});
let restored=false;
if (inputHash) {
  try {restored=renderer.restore(await readFile('.opengeo-page-cache-input.json'),inputHash);}
  catch (error) {if(error.code!=='ENOENT')throw error;}
}
const effects=new FileBuildEffects(config.output,resolve(config.root,'.observablehq/cache'));
effects.renderPage=renderer.render;
await build({config},effects);
const snapshot=renderer.snapshot();
await writeFile('.opengeo-page-cache-output.json',snapshot.body,{flag:'wx',mode:0o600});
await writeFile('.opengeo-page-cache-result.json',JSON.stringify({restored,...renderer.stats,
  checksumSha256:snapshot.checksumSha256}),{flag:'wx',mode:0o600});
