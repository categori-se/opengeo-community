import {createView} from './portableMapView.js';

/** Insert a portable Studio map and a small importable viewer in the authored tree. */
export function publicationMapInsert({entryPath, name, blob, existingPaths = [], source, parser, manifest = null, notebookMapModule = false}) {
  if (!/\.(md|html)$/i.test(entryPath)) throw new TypeError('Open a Markdown or HTML page first');
  if (!(blob instanceof Blob) || !blob.size || blob.size > 4_194_304) throw new TypeError('Map HTML must be non-empty and at most 4 MiB');
  const stem = String(name).replace(/\.html?$/i, '').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'map';
  const localPath = `maps/${stem}.html`;
  const path = entryPath.slice(0, entryPath.lastIndexOf('/') + 1) + localPath;
  if (existingPaths.some(existing => existing.toLowerCase() === path.toLowerCase() ||
      existing.toLowerCase().startsWith(path.toLowerCase() + '/') || path.toLowerCase().startsWith(existing.toLowerCase() + '/'))) {
    throw new TypeError('A map with this file name already exists or conflicts with a source path; rename the export before inserting it');
  }
  const notebook = /\.html$/i.test(entryPath) && typeof source === 'string' && /<notebook(?:\s|>)/i.test(source);
  const modulePath = path.replace(/\.html$/, '.js');
  const moduleSpecifier = notebook ? 'opengeo:map' : './' + localPath.replace(/\.html$/, '.js');
  let alias = 'mapView', number = 1;
  while (new RegExp(`\\b${alias}(?:Node)?\\b`).test(source ?? '')) alias = `mapView${++number}`;
  // Current deployed Notebook compilers already bundle htl. Keep generated
  // sources publishable there until an upgraded compiler explicitly opts in.
  const code = notebook && !notebookMapModule
    ? `import {html as ${alias}} from "htl";\nconst ${alias}Node = ${alias}\`<iframe srcdoc=\${await FileAttachment(${JSON.stringify('./' + localPath)}).text()} title="${stem}" sandbox="allow-scripts" referrerpolicy="no-referrer" style="width:100%;height:560px;border:0"></iframe>\`;\ninvalidation.then(() => {${alias}Node.srcdoc = ""; ${alias}Node.remove();});\ndisplay(${alias}Node);`
    : `import {createView as ${alias}} from ${JSON.stringify(moduleSpecifier)};\ndisplay(${alias}({html: await FileAttachment(${JSON.stringify('./' + localPath)}).text(), title: ${JSON.stringify(stem)}, invalidation}));`;
  const file = {relativePath: path, blob, contentType: 'text/html'};
  const files = [file];
  if (manifest !== null) {
    const sidecarPath = `${path}.artifact.json`;
    if (existingPaths.some(existing => existing.toLowerCase() === sidecarPath.toLowerCase()
      || existing.toLowerCase().startsWith(sidecarPath.toLowerCase() + '/')
      || sidecarPath.toLowerCase().startsWith(existing.toLowerCase() + '/'))) {
      throw Error('The Artifact manifest path already exists or conflicts with the source tree.');
    }
    const encoded = JSON.stringify(manifest, null, 2);
    if (new TextEncoder().encode(encoded).length > 49_152) throw Error('The Artifact manifest exceeds 48 KiB.');
    files.push({relativePath: sidecarPath, blob: new Blob([encoded], {type: 'application/json'}), contentType: 'application/json'});
  }
  // Keep the HTML in one file. The leaf module is a small, closure-free viewer,
  // so it can also be imported outside Studio without copying the map runtime.
  if (!notebook) {
    if (existingPaths.some(existing => existing.toLowerCase() === modulePath.toLowerCase()
      || existing.toLowerCase().startsWith(modulePath.toLowerCase() + '/')
      || modulePath.toLowerCase().startsWith(existing.toLowerCase() + '/'))) {
      throw Error('The map module path already exists or conflicts with the source tree.');
    }
    files.push({relativePath: modulePath, blob: new Blob([`// OpenGeo portable map viewer.\nexport ${createView.toString()}\n`], {type: 'text/javascript'}), contentType: 'text/javascript'});
  }

  if (notebook) {
    if (new TextEncoder().encode(source).length > 4_194_304) throw Error('Notebook source must be at most 4 MiB.');
    const htmlParser = parser ?? new DOMParser();
    const document = htmlParser.parseFromString(source, 'text/html');
    if (document.querySelectorAll('notebook').length !== 1) throw Error('Open one complete Observable Notebook before inserting a map.');
    // Follow Notebook Kit's imported-cell numbering without rewriting existing cells.
    let maxId = 0; const ids = new Set();
    const cells = document.querySelectorAll('notebook script');
    if (cells.length >= 1000) throw Error('Notebook already has 1,000 cells.');
    for (const cell of cells) {
      let id = Math.floor(Number(cell.id));
      if (!Number.isFinite(id) || id <= 0 || ids.has(id)) id = ++maxId;
      else maxId = Math.max(maxId, id);
      ids.add(id);
    }
    if (!Number.isSafeInteger(maxId + 1)) throw Error('Notebook cell identifiers are out of range.');
    const snippet = `\n<script id="${maxId + 1}" type="module">\n${code}\n</script>\n`;
    // A closing-tag string can occur inside a cell or comment. Validate the
    // parsed result while leaving all original source bytes, including suffixes, intact.
    const endings = [];
    for (const closing of source.matchAll(/<\/notebook\s*>/gi)) {endings.push(closing); if (endings.length > 32) endings.shift();}
    for (const closing of endings.reverse()) {
      const updated = htmlParser.parseFromString(source.slice(0,closing.index) + snippet + source.slice(closing.index),'text/html');
      const next = [...updated.querySelectorAll('notebook script')];
      if (next.length !== cells.length + 1 || next.at(-1)?.id !== String(maxId + 1) || next.at(-1)?.textContent.trim() !== code) continue;
      if ([...cells].some((cell,index) => cell.outerHTML !== next[index].outerHTML)) continue;
      return {file, files, snippet, insertOffset: closing.index};
    }
    throw Error('Add a valid closing notebook element before inserting a map.');
  }
  const snippet = /\.md$/i.test(entryPath)
    ? `\n\n\`\`\`js\n${code}\n\`\`\`\n`
    : `\n<iframe src="./${localPath}" title="${stem}" sandbox="allow-scripts" style="width:100%;height:560px;border:0" loading="lazy"></iframe>\n`;
  return {file, files, snippet};
}
