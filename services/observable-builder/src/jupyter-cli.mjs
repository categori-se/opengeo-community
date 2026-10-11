import {createRequire} from 'node:module';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {renderJupyterNotebookWithFiles} from './jupyter-notebook.mjs';

// Both packages are already pinned within the compiler's Framework lockfile.
// No notebook-supplied dependencies, kernel, hooks or configuration are loaded.
const [frameworkCli, planPath] = process.argv.slice(2);
const require = createRequire(frameworkCli);
const {JSDOM} = require('jsdom');
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({html: false, linkify: false});
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const files = new Map(plan.files.map(file => [file.path, file]));
const dom = new JSDOM(''); // No scripts or external resource loading.
try {
  for (const {source, output, path} of plan.pages) {
    const html = await renderJupyterNotebookWithFiles(readFileSync(resolve(source), 'utf8'), {
      document: dom.window.document, renderMarkdown: value => markdown.render(value), path, sourceRoot: plan.sourceRoot,
      readFile: async path => {
        const file = files.get(path);
        if (!file) throw Error(`Notebook image is not in the saved revision: ${path}`);
        if (file.sizeBytes > 4_194_304) throw Error('Notebook image exceeds 4 MiB.');
        return new Blob([readFileSync(file.source)], {type:file.contentType});
      }
    });
    mkdirSync(dirname(resolve(output)), {recursive: true, mode: 0o700});
    writeFileSync(resolve(output), html, {flag: 'wx', mode: 0o600});
  }
} finally {dom.window.close();}
