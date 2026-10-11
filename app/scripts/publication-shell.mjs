import {createRequire} from 'node:module';
const {JSDOM} = createRequire(new URL('../package.json', import.meta.url))('jsdom');
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const normalized = path => path.replace(/^https:\/\/opengeo\.tools/, '').replace(/(?:index)?\.html$/, '').replace(/\/$/, '') || '/';

// Apply hosted navigation to compiled output without changing its cell runtime.
// Source authoring and standalone exports remain independent of the host shell.
export function integratePublication(html, {path, cssPath, scriptPath, primaryNav, siteMetadata, groups, publications, publicationSources = publications}) {
  const dom = new JSDOM(html), document = dom.window.document;
  const mains = document.querySelectorAll('main');
  if (mains.length !== 1 || document.querySelector('#site-navigation')) throw Error('Ambiguous publication layout: ' + path);
  const main = mains[0], notebook = !!document.querySelector('#notebook-payload');
  // Replace a compiler-resolved copy of the host client with the shared asset.
  for (const s of document.querySelectorAll('script[src]')) if (/\/components\/site-shell[.\/]/.test(s.src)) s.remove();
  const payload = document.querySelector('#notebook-payload')?.textContent;
  const runtime = [...document.querySelectorAll('script')].map(s => s.textContent);
  document.documentElement.classList.add('opengeo-site');
  document.documentElement.lang = 'en';
  document.documentElement.dataset.theme = 'light';
  document.body.classList.add('opengeo-site');
  document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1');
  if (notebook) main.classList.add('opengeo-notebook');
  if (!main.id) main.id = 'publication-content';
  main.setAttribute('tabindex', '-1');
  // Permit only same-origin host assets; the Notebook still cannot fetch data.
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  if (csp) csp.content = csp.content.replace(/\b(script-src|style-src|img-src|font-src) /g, "$1 'self' ");
  const script = document.createElement('script'); script.src = scriptPath;
  const headAnchor = csp ?? document.querySelector('meta[name=viewport]');
  if (headAnchor) headAnchor.after(script); else document.head.append(script);
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = cssPath;
  document.head.append(css);
  const active = href => normalized(href) === normalized(path) ? ' aria-current="page"' : '';
  const navLink = ({name, label, path: href, href: url}) => `<a href="${escape(href ?? url)}"${active(href ?? url)}>${escape(name ?? label)}</a>`;
  const publicationPages = publications.map(p => ({name:p.title,path:p.publicUrl}));
  const allGroups = groups.map(g => g.name === 'Projects' ? {...g,pages:[g.pages[0],...publicationPages,...g.pages.slice(1).filter(p=>!publicationPages.some(q=>normalized(q.path)===normalized(p.path)))]} : g);
  const primaryLinks = primaryNav.map(item => {
    const section = normalized(item.href), current = normalized(path);
    const selected = current===section || current.startsWith(section+'/') || allGroups.some(g=>g.name===item.label&&g.pages?.some(p=>normalized(p.path)===current)) || (section==='/projects' && publications.some(p=>current===normalized(p.publicUrl)||current.startsWith(normalized(p.publicUrl)+'/')));
    return `<a href="${escape(item.href)}"${selected?' aria-current="location"':''}>${escape(item.label)}</a>`;
  }).join('');
  const navigation = allGroups.map(group => group.pages
    ? `<details${group.pages.some(p => normalized(p.path) === normalized(path)) || group.name === 'Projects' ? ' open' : ''}><summary>${escape(group.name)}</summary>${group.pages.map(navLink).join('')}</details>`
    : navLink(group)).join('');
  const sourcePublication=publicationSources.find(p=>normalized(p.publicUrl)===normalized(path));
  const sourceLink=sourcePublication?.publicationId?`<a href="https://studio.opengeo.tools/workspaces?publication=${escape(sourcePublication.publicationId)}">Publication in Studio</a>`:'';
  const shell = document.createElement('div');
  shell.innerHTML = `<a class="site-skip" href="#${escape(main.id)}">Skip to content</a>
<header class="site-header"><div class="site-header-bar">
<button id="site-menu-toggle" type="button" aria-label="Toggle navigation sidebar" title="Toggle navigation sidebar (Alt+B)" aria-controls="site-navigation" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>
<a class="site-brand" href="/"><span class="site-brand-copy"><strong>${escape(siteMetadata.title)}</strong><span>${escape(siteMetadata.tagline)}</span></span></a>
<nav class="site-primary-nav" aria-label="Primary">${primaryLinks}</nav>
<a class="site-studio-link" href="https://studio.opengeo.tools/?entry=public">Studio</a>
<label class="site-appearance" for="site-appearance"><span>Appearance</span><select id="site-appearance" aria-label="Appearance"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
</div></header>
<button id="site-menu-backdrop" type="button" tabindex="-1" aria-label="Close site navigation"></button>
<div class="site-layout"><nav id="site-navigation" aria-label="Site navigation"><a class="site-studio-link" href="https://studio.opengeo.tools/?entry=public">Open Studio</a>${navigation}</nav><aside id="page-outline" aria-label="Page contents"><nav aria-label="Page contents"><h2>Contents</h2><ol></ol></nav></aside></div>
<footer class="site-footer"><p><strong>${escape(siteMetadata.title)}</strong> · ${escape(siteMetadata.description)}</p><nav aria-label="Footer">${sourceLink}<a href="/projects/">Projects</a><a href="/about/">About</a><a href="https://studio.opengeo.tools/?entry=public">Studio</a></nav></footer>`;
  const layout = shell.querySelector('.site-layout');
  const reading = document.createElement('div'); reading.className = 'site-reading'; reading.append(main);
  layout.insertBefore(reading, layout.querySelector('#page-outline'));
  // The compiler may retain native sidebar nodes for its initializer; keep them
  // hidden outside the new reading layout rather than breaking that initializer.
  document.body.prepend(...shell.childNodes);
  const section = allGroups.find(g => g.pages?.some(p => normalized(p.path) === normalized(path)));
  if (section) {
    const index = section.pages.findIndex(p => normalized(p.path) === normalized(path));
    const previous = section.pages[index-1], next = section.pages[index+1];
    if (previous || next) {
      const pager = document.createElement('nav'); pager.className = 'site-pager'; pager.setAttribute('aria-label','Related reading');
      pager.innerHTML = `${previous ? `<a rel="prev" href="${escape(previous.path)}">← ${escape(previous.name)}</a>` : '<span></span>'}${next ? `<a rel="next" href="${escape(next.path)}">${escape(next.name)} →</a>` : ''}`;
      reading.append(pager);
    }
  }
  if (notebook && document.querySelector('#notebook-payload').textContent !== payload) throw Error('Notebook payload changed during integration');
  const afterRuntime = [...document.querySelectorAll('script')].filter(s => s !== script).map(s => s.textContent);
  if (JSON.stringify(runtime) !== JSON.stringify(afterRuntime)) throw Error('Compiled runtime changed during integration');
  const output = dom.serialize(); dom.window.close(); return output;
}
