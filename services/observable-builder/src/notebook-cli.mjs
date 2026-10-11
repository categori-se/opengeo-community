import {createRequire} from 'node:module';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileObservableNotebook, notebookAttachmentPath, notebookNoticeFiles, observableNotebookDocument} from './observable-notebook.mjs';

// No user configuration, package installation, or submitted cell is executed.
const [frameworkCli, planPath, assetsPath] = process.argv.slice(2);
const require = createRequire(frameworkCli);
const kitRoot = dirname(dirname(require.resolve('@observablehq/notebook-kit/index.css')));
const kit = await import(pathToFileURL(join(kitRoot, 'index.js')).href);
const {JSDOM} = require('jsdom');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const {runtime, styles} = JSON.parse(readFileSync(assetsPath, 'utf8'));
if (typeof runtime !== 'string' || typeof styles !== 'string') throw Error('Notebook runtime assets are missing');
const dom = new JSDOM('');
try {
  const compiled = compileObservableNotebook(readFileSync(plan.source, 'utf8'), {kit, parser: new dom.window.DOMParser()});
  const files = new Map(plan.files.map(file => [file.path, file]));
  let total = 0;
  const attachments = compiled.files.map(name => {
    const file = files.get(notebookAttachmentPath(plan.entryPath, name));
    if (!file) throw Error(`Notebook attachment is not in the saved revision: ${name}`);
    if (file.sizeBytes > 4_194_304 || (total += file.sizeBytes) > 16_777_216) throw Error('Notebook attachments exceed the supported publication limits');
    return {name, type: file.contentType, checksum: file.checksumSha256, bytes: readFileSync(file.source).toString('base64')};
  });
  const notices = notebookNoticeFiles(plan.entryPath, plan.files).map(file => ({name: file.noticeName, text: readFileSync(file.source, 'utf8')}));
  const html = observableNotebookDocument({runtime, styles, title: compiled.title, notices,
    payload: {title: compiled.title, cells: compiled.cells, attachments, revision: 1,
      ...(compiled.legacyModules ? {legacyModules: compiled.legacyModules} : {})}});
  mkdirSync(dirname(plan.output), {recursive: true, mode: 0o700});
  writeFileSync(plan.output, html, {flag: 'wx', mode: 0o600});
} finally {dom.window.close();}
