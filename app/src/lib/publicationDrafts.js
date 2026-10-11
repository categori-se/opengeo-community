// Migration 0098, API admission and the reviewed HTML builder are deployed;
// September 15 publisher-check HTML/map receipts verify the complete path.
// Keep activation in source so ordinary Studio builds retain this capability.
export const staticHtmlPublishingEnabled = true;
// Native admission/compiler and the exact draft preview edge were deployed in
// September. Retain their activation here; the earlier disposable release copy
// left these source flags disabled and later ordinary builds regressed them.
// Source rights, exact-build review and preview isolation remain separate checks.
export const jupyterPublishingEnabled = true;
export const observableNotebookPublishingEnabled = true;
export const frameworkDraftPreviewEnabled = true;
export const publicationFormatEnabled = format => format === 'framework'
  || (['html', 'map'].includes(format) && staticHtmlPublishingEnabled)
  || (format === 'jupyter' && jupyterPublishingEnabled)
  || (format === 'notebook' && observableNotebookPublishingEnabled);
export const publicationFormats = Object.freeze([
  ['framework', 'Observable Framework'],
  ['html', 'HTML / static files'],
  ['map', 'Map · portable HTML'],
  ['notebook', 'Observable Notebook'],
  ['jupyter', 'Jupyter / IPython notebook']
]);

/** A private editable starting point, not a build or a publication. */
export function publicationStarter({format, title, sourceProject}) {
  if (!publicationFormats.some(([value]) => value === format)) throw new TypeError('Unsupported publication format');
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const markdown = format === 'framework';
  const jupyter = format === 'jupyter';
  const notebook = format === 'notebook';
  // A new draft is a flat source tree, without a package/lockfile. Its homepage
  // must be at the root. Imported complete Framework projects retain src/.
  const entryPath = markdown ? 'index.md' : jupyter ? 'index.ipynb' : 'index.html';
  const content = notebook
    ? `<!doctype html>\n<notebook>\n<title>${escape(title)}</title>\n<script id="1" type="text/markdown"># ${escape(title).replace(/[\r\n]/g, ' ')}</script>\n<script id="2" type="module">const value = view(Inputs.range([0, 100], {label: "Value", value: 50}));</script>\n<script id="3" type="text/markdown">Value: \${value}</script>\n</notebook>\n`
    : jupyter ? JSON.stringify({nbformat: 4, nbformat_minor: 5,
    metadata: {language_info: {name: 'python'}, kernelspec: {display_name: 'Python 3', language: 'python', name: 'python3'}},
    cells: [{id: 'introduction', cell_type: 'markdown', metadata: {}, source: `# ${String(title).replace(/[\r\n]/g, ' ').replace(/[\\\x60*_{}\[\]<>()#!|]/g, '\\$&')}\n`},
      {id: 'analysis', cell_type: 'code', metadata: {}, source: '', execution_count: null, outputs: []}]}, null, 2) + '\n' : markdown
    ? `---\ntitle: ${JSON.stringify(title)}\n---\n\n# ${String(title).replace(/[\r\n]/g, ' ').replace(/[\\\x60*_{}\[\]<>()#!|]/g, '\\$&')}\n\n`
    : `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escape(title)}</title>\n<style>body{font:16px/1.6 system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem;color-scheme:light dark}iframe{width:100%;min-height:560px;border:0}</style>\n<body>\n<h1>${escape(title)}</h1>\n${format === 'map' ? '<!-- Use Insert map in Studio to add a portable map here. -->\n' : ''}</body>\n</html>\n`;
  const contentType = markdown ? 'text/markdown' : jupyter ? 'application/x-ipynb+json' : 'text/html';
  const prefix = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
  const formatRecord = JSON.stringify({schema: 'opengeo.publication.1', format, entry: entryPath.slice(prefix.length)}, null, 2) + '\n';
  return {expectedRevision: sourceProject.currentRevisionNumber ?? 0, title,
    rightsStatus: sourceProject.rightsStatus ?? 'unreviewed', entryPath, lockfilePath: null,
    changeSummary: `Create ${format} publication`, files: [{relativePath: entryPath, contentType, blob: new Blob([content], {type: contentType})},
      {relativePath: prefix + 'opengeo.publication.json', contentType: 'application/json', blob: new Blob([formatRecord], {type: 'application/json'})}], dataAttachments: []};
}
