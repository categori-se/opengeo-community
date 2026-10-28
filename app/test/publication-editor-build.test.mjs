import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {editorSanitizerRemedy,findEditorEntryOutput} from '../scripts/build-publication-editor.mjs';

test('editor entry selection supports staged builds sharing installed dependencies',async()=>{
  const root=await mkdtemp(join(tmpdir(),'opengeo-editor-entry-'));
  await mkdir(join(root,'dependencies'));
  await writeFile(join(root,'dependencies/worker.js'),'// fixture');
  await symlink(join(root,'dependencies'),join(root,'node_modules'),'dir');
  const expected={entryPoint:'dependencies/worker.js'};
  const result=await findEditorEntryOutput({'worker-123.js':expected},'node_modules/worker.js',root);
  assert.equal(result[0],'worker-123.js');
  assert.equal(result[1],expected);
  await assert.rejects(findEditorEntryOutput({},'node_modules/worker.js',root),/output missing/);
});

test('editor sanitizer build replaces Monaco vendor code, preserves safe markup and records original notices',async t=>{
  const appRoot=fileURLToPath(new URL('..',import.meta.url)),sanitizer=await editorSanitizerRemedy(appRoot);
  const options={absWorkingDir:appRoot,stdin:{resolveDir:appRoot,sourcefile:'editor-sanitizer-contract.mjs',
    contents:`import purify from './node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js';export default purify;`},
    bundle:true,write:false,format:'esm',platform:'browser',metafile:true};
  const patched=await build({...options,plugins:[sanitizer.plugin]});
  const provenance=await sanitizer.verify(patched.metafile);
  assert.equal(provenance.version,'3.4.17');assert.equal(provenance.replaces.version,'0.56.0');
  assert.equal(provenance.replaces.embeddedVersion,'3.4.8');
  const unpatched=await build(options);
  await assert.rejects(sanitizer.verify(unpatched.metafile),/retained the vendored Monaco sanitizer/);
  await assert.rejects(sanitizer.verify({inputs:{}}),/replacement is missing/);
  const {default:createPurifier}=await import('data:text/javascript;base64,'+Buffer.from(patched.outputFiles[0].contents).toString('base64'));
  const dom=new JSDOM('<!doctype html><body></body>');t.after(()=>dom.window.close());
  const purifier=createPurifier(dom.window);assert.equal(purifier.version,'3.4.17');
  const output=dom.window.document.createElement('div');
  output.innerHTML=purifier.sanitize('<p onclick="evil()"><strong>Retained</strong><a href="javascript:evil()">link</a><script>evil()</script></p>');
  assert.equal(output.querySelector('strong').textContent,'Retained');assert.equal(output.querySelector('a').textContent,'link');
  assert.equal(output.querySelector('script,[onclick],[href]'),null);
  assert.deepEqual(provenance.notices.map(item=>item.output),['LICENSE.txt','monaco-ThirdPartyNotices.NOTICE.txt','DOMPurify.LICENSE.txt']);
  for(const notice of provenance.notices){
    const original=await readFile(resolve(appRoot,notice.path));
    assert.equal(createHash('sha256').update(original).digest('hex'),notice.sha256);
  }
});
