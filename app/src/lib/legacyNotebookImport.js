import {normalizeObservableSourceFiles, normalizeObservableRevisionAttachments} from './apiClient.js';

const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const pathParts = path => typeof path === 'string' && path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const noticeName = path => /^(?:LICENSE|NOTICE|COPYING)(?:\.(?:txt|md))?$/i.test(path.split('/').at(-1));

/** Local conversion only. Keep the original export and mapped attachment bytes. */
export async function prepareLegacyNotebookImport({file, attachments = [], convert}) {
  if (!(file instanceof Blob) || !file.size || file.size > 4_194_304 || !/\.(?:js|mjs|json)$/i.test(file.name ?? '')) {
    throw new TypeError('Choose a JavaScript or JSON Observable export of at most 4 MiB.');
  }
  if (!Array.isArray(attachments) || attachments.length > 128) throw new TypeError('Choose at most 128 export-folder files.');
  const supplied = new Map(), names = new Set();
  let selectedBytes = 0;
  for (const entry of attachments) {
    if (!pathParts(entry.relativePath) || !(entry.blob instanceof Blob) || entry.blob.size > 4_194_304
      || (selectedBytes += entry.blob.size) > 16_777_216) throw new TypeError('Export-folder files require safe relative paths, 4 MiB per file and 16 MiB total.');
    const key = entry.relativePath.toLowerCase();
    if (names.has(key)) throw new TypeError('Export-folder paths must be unique.');
    names.add(key); supplied.set(entry.relativePath, entry.blob);
  }
  const source = await file.text();
  const moduleSources = [];
  for (const [path, blob] of supplied) if (/\.(?:js|mjs)$/i.test(path)) moduleSources.push({path, source: await blob.text()});
  const converted = await convert({source, path: file.name, title: file.name.replace(/\.(?:js|mjs|json)$/i, ''),
    availablePaths: [...supplied.keys()], moduleSources});
  if (typeof converted?.html !== 'string' || !Array.isArray(converted.attachments) || converted.attachments.length > 128) {
    throw new TypeError('The converter did not return a complete source plan.');
  }
  const originalPath = /\.json$/i.test(file.name) ? 'original/observable-export.json' : 'original/observable-export.js.txt';
  const files = [{relativePath: 'index.html', blob: new Blob([converted.html], {type: 'text/html'})},
    {relativePath: 'opengeo.publication.json', blob: new Blob([JSON.stringify({schema: 'opengeo.publication.1',
      format: 'notebook', entry: 'index.html'}, null, 2) + '\n'], {type: 'application/json'})},
    {relativePath: originalPath, blob: new Blob([file], {type: /\.json$/i.test(file.name) ? 'application/json' : 'text/plain'})}];
  const used = new Set(), mapped = [];
  const modules = [];
  for (const module of converted.modules ?? []) {
    if (module.path === file.name) {
      if (module.source !== source) throw new TypeError('The retained root notebook scope differs from the original export.');
      // The lexical descriptor can refer to the root without retaining its
      // exact original a second time or calling it an imported child notebook.
      continue;
    }
    const blob = supplied.get(module.path);
    if (!blob || !pathParts(module.path) || !/\.(?:js|mjs)$/i.test(module.path)) throw new TypeError('A converted notebook module is missing from the selected export folder.');
    // Observable names generated modules with @revision; source storage keeps
    // its existing path rules. The report retains the exact original filename.
    const retainedPath = module.path.includes('@')
      ? `original/modules/import-${await digest(new Blob([module.path]))}.js.txt`
      : `original/modules/${module.path}.txt`;
    files.push({relativePath: retainedPath, blob: new Blob([blob], {type: 'text/plain'})});
    used.add(module.path);
    modules.push({path: module.path, retainedPath, checksumSha256: await digest(blob), sizeBytes: blob.size});
  }
  for (const attachment of converted.attachments) {
    const blob = supplied.get(attachment.path);
    if (!blob) throw new TypeError(`Missing exported attachment: ${attachment.name}. Choose its original export folder before converting.`);
    // Browser or provider MIME labels remain in the original export/report. The
    // established source guard determines the stored media type from the path.
    files.push({relativePath: attachment.name, blob: new Blob([blob])});
    used.add(attachment.path);
    mapped.push({...attachment, checksumSha256: await digest(blob), sizeBytes: blob.size});
  }
  const notices = [];
  for (const [path, blob] of supplied) {
    if (!blob.size || !noticeName(path)) continue;
    const name = path.split('/').at(-1).replace(/\.(?:txt|md)$/i, '');
    const retainedPath = `original/notices/${name}-${await digest(new Blob([path]))}.txt`;
    files.push({relativePath: retainedPath, blob: new Blob([blob], {type: 'text/plain'})});
    used.add(path);
    notices.push({path, retainedPath, checksumSha256: await digest(blob), sizeBytes: blob.size});
  }
  const original = {name: file.name, retainedPath: originalPath, sizeBytes: file.size, checksumSha256: await digest(file)};
  // Only an identical folder copy is already retained with the primary export.
  if (supplied.has(file.name) && await digest(supplied.get(file.name)) === original.checksumSha256) used.add(file.name);
  const report = {...converted.report, original, attachments: mapped, retainedModules: modules, retainedNotices: notices,
    unusedSelectedFiles: [...supplied.keys()].filter(path => !used.has(path)),
    limits: ['Original exports, imported notebook modules, mapped attachments and nonempty LICENSE/NOTICE/COPYING texts are retained; other selected export-folder files are listed but not copied.',
      'Retained notices preserve supplied text and its original path; their scope is not inferred and they do not approve publication rights.',
      'Conversion does not transfer permissions, ownership, history or publication approval. Review the isolated preview before publishing.']};
  const reportText = JSON.stringify(report, null, 2) + '\n';
  if (new TextEncoder().encode(reportText).length > 262_144) throw new TypeError('The conversion report exceeds 256 KiB.');
  files.push({relativePath: 'original/observable-conversion.json', blob: new Blob([reportText], {type: 'application/json'})});
  const normalized = normalizeObservableSourceFiles(files);
  normalizeObservableRevisionAttachments([], normalized);
  return {files: normalized, conversionReport: report, manifest: {metadata: {title: String(converted.report?.title ?? file.name).slice(0, 300),
    entryPath: 'index.html', lockfilePath: null, legacyConversion: report},
    baseRevision: null, dataAttachments: [], artifactReferences: null}};
}
