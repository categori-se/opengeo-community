import {publicationSourceRoot} from './publicationSourceRoot.js';
const safe = value => typeof value === 'string' && value.length <= 512 && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..');
export function artifactSourceLayout(revision) {
  if (!revision || !safe(revision.entryPath) || !Array.isArray(revision.files)) throw Error('Saved source layout is unavailable');
  const paths = revision.files.map(file => file.relativePath);
  if (!paths.every(safe)) throw Error('Invalid saved source path');
  return {entryPath:revision.entryPath, paths, root:publicationSourceRoot(revision.entryPath,paths)};
}
export function nextArtifactPath(layout, references) {
  const prefix = layout?.root ? layout.root+'/' : '';
  const paths = [...(layout?.paths ?? []), ...references.map(item=>item.path)].map(path=>path.toLowerCase());
  let number=1;
  while (paths.some(path=>path===`${prefix}maps/artifact-${number}.html`.toLowerCase())) number++;
  return `${prefix}maps/artifact-${number}.html`;
}
export function publicationArtifactEmbed(layout, artifactPath, pagePath=layout?.entryPath) {
  if (!layout || !safe(artifactPath) || !safe(pagePath) || !/\.(md|html)$/i.test(pagePath)) throw Error('Choose a saved HTML or Markdown page');
  const prefix=layout.root?layout.root+'/':'';
  if (!artifactPath.startsWith(prefix)||!pagePath.startsWith(prefix)||!artifactPath.endsWith('.html')) throw Error('Artifact and page must be inside the saved source root');
  const base=pagePath.slice(prefix.length).split('/').slice(0,-1), target=artifactPath.slice(prefix.length).split('/');
  while(base.length&&target.length&&base[0]===target[0]){base.shift();target.shift();}
  const url='../'.repeat(base.length)+target.join('/');
  return `<iframe src="${url}" title="Project Artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:480px;border:0"></iframe>`;
}

/** A public release stays an external, revocable reference in the saved source. */
export function publicArtifactEmbed({url, title = 'Project Artifact'}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^\/public\/organizations\/[0-9a-f-]{36}\/artifact-releases\/[0-9a-f-]{36}\/view$/.test(parsed.pathname)) {
    throw Error('Choose a public Artifact release URL');
  }
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // The viewer isolates its map itself. An outer opaque sandbox would prevent
  // that viewer's self-only policy from opening the nested map.
  return `<iframe src="${escape(parsed.href)}" title="${escape(title)}" referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:560px;border:0"></iframe>`;
}

export function insertPublicArtifact({path, source, url, title}) {
  if (!/\.(md|html)$/i.test(path ?? '') || typeof source !== 'string') throw Error('Open an HTML or Markdown page first');
  if (/<notebook(?:\s|>)/i.test(source)) throw Error('Use an HTML or Markdown page for this release embed');
  const snippet = `\n${publicArtifactEmbed({url,title})}\n`;
  const bodyEnd = /\.html$/i.test(path) ? source.search(/<\/body\s*>/i) : -1;
  return {snippet, insertOffset:bodyEnd < 0 ? source.length : bodyEnd};
}
