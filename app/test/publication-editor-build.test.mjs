import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {findEditorEntryOutput} from '../scripts/build-publication-editor.mjs';

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
