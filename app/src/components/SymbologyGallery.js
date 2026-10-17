import {SYMBOLOGY_REFERENCES} from '../lib/symbologyReferences.js';

let gallerySequence = 0;
const PAGE_SIZE = 48;
const labelFor = value => String(value ?? '').replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
const geometryFor = value => /point/i.test(value) ? 'Point' : /polygon|area|fill/i.test(value) ? 'Polygon'
  : /line/i.test(value) ? 'Line' : String(value);
const searchable = value => String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Browse owned, trusted previews. The caller owns draft changes and persistence. */
export function SymbologyGallery({entries, preview, onChoose, selectedId = null}) {
  const node = (tag, text = '', className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const catalog = [...entries];
  const root = node('section', '', 'symbology-gallery');
  root.setAttribute('aria-label', 'Symbology library');
  const heading = node('h2', 'Symbology library');
  const introduction = node('p', 'Browse symbols, lines, areas, patterns and color palettes. Choose an item to inspect its source and customize a Style.');
  const overview = node('p', '', 'symbology-gallery-overview');
  const counts = new Map();
  for (const entry of catalog) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  overview.textContent = [...counts].map(([kind, count]) => `${labelFor(kind)}: ${count}`).join(' · ');
  const filters = node('div', '', 'symbology-gallery-filters');
  const search = node('input');
  search.type = 'search'; search.placeholder = 'Search symbols, features or sources';
  search.setAttribute('aria-label', 'Search symbology');
  const gridId = `symbology-gallery-grid-${++gallerySequence}`;
  search.setAttribute('aria-controls', gridId);
  const field = (title, control) => {
    const label = node('label', title); label.append(control); return label;
  };
  const option = (title, value) => {const item = node('option', title); item.value = value; return item;};
  const select = (title, values) => {
    const control = node('select'); control.setAttribute('aria-label', title);
    control.setAttribute('aria-controls', gridId);
    control.append(option(`All ${title.toLowerCase()}`, ''));
    for (const [value, count] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      control.append(option(`${labelFor(value)} (${count})`, value));
    }
    return control;
  };
  const countValues = accessor => {
    const values = new Map();
    for (const entry of catalog) for (const value of new Set(accessor(entry).filter(Boolean))) {
      values.set(value, (values.get(value) ?? 0) + 1);
    }
    return values;
  };
  const kinds = select('Kinds', counts);
  const geometries = select('Geometries', countValues(entry => (entry.geometryKinds ?? []).map(geometryFor)));
  const categories = select('Categories', countValues(entry => [entry.category]));
  const collections = select('Collections', countValues(entry => [entry.collection]));
  const collectionShortcuts = node('nav', '', 'symbology-gallery-collections');
  collectionShortcuts.setAttribute('aria-label', 'Browse symbology collections');
  const browseCollection = value => {
    search.value = kinds.value = geometries.value = categories.value = '';
    collections.value = value;filter();
    count.scrollIntoView?.({block: 'nearest'});
  };
  const collectionButtons = [];
  for (const [collection, total] of [['', catalog.length], ...countValues(entry => [entry.collection])]) {
    const button = node('button', `${collection || 'All collections'} · ${total}`);button.type = 'button';
    button.setAttribute('aria-pressed', String(!collection));
    button.onclick = () => browseCollection(collection);collectionButtons.push([collection, button]);collectionShortcuts.append(button);
  }
  const references = node('section', '', 'symbology-gallery-references');
  references.id = `${gridId}-guides`;
  references.setAttribute('aria-label', 'Symbology guides and sources');
  references.append(node('h3', 'Guides and sources'));
  const guideLink = node('a', 'Guides and sources');guideLink.href = `#${references.id}`;
  overview.append(document.createTextNode(' · '), guideLink);
  const referenceGrid = node('div', '', 'symbology-gallery-reference-grid');
  for (const guide of SYMBOLOGY_REFERENCES) {
    const card = node('article');card.append(node('h4', guide.title), node('p', guide.description));
    const links = node('ul');
    for (const [title, href] of guide.links) {
      const row = node('li'), link = node('a', title);link.href = href;
      link.target = '_blank';link.rel = 'noopener noreferrer';row.append(link);links.append(row);
    }
    card.append(links, node('p', guide.note, 'symbology-gallery-reference-note'));
    const total = catalog.filter(entry => entry.collection === guide.collection).length;
    if (guide.collection && total) {
      const browse = node('button', `Browse ${guide.title} · ${total}`);browse.type = 'button';
      browse.onclick = () => {browseCollection(guide.collection);collections.focus();};card.append(browse);
    }
    referenceGrid.append(card);
  }
  references.append(referenceGrid);
  const clear = node('button', 'Clear filters', 'symbology-gallery-clear'); clear.type = 'button';
  filters.append(field('Search', search), field('Kind', kinds), field('Geometry', geometries),
    field('Category', categories), field('Collection', collections), clear);
  const count = node('p', '', 'symbology-gallery-count'); count.setAttribute('role', 'status');
  const workspace = node('div', '', 'symbology-gallery-workspace');
  const results = node('div', '', 'symbology-gallery-results');
  const grid = node('div', '', 'symbology-gallery-grid'); grid.id = gridId;
  const empty = node('p', 'No matching symbols or Styles. Try a different search or clear the filters.'); empty.hidden = true;
  const pagination = node('div', '', 'symbology-gallery-pagination');
  const previous = node('button', 'Previous'), next = node('button', 'Next');
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', 'Previous symbology page'); next.setAttribute('aria-label', 'Next symbology page');
  const pageNumber = node('span');
  pagination.append(previous, pageNumber, next);
  const detail = node('section', '', 'symbology-gallery-detail');
  detail.setAttribute('aria-label', 'Selected symbology');
  const status = node('p', '', 'symbology-gallery-status'); status.setAttribute('role', 'status');
  results.append(grid, empty, pagination);
  workspace.append(results, detail);
  root.append(heading, introduction, overview, collectionShortcuts, filters, count, workspace, status, references);
  let page = 0, filtered = catalog, choosing = false, disposed = false;
  let selected = catalog.find(entry => entry.id === selectedId) ?? null;
  const index = new Map(catalog.map(entry => [entry.id, searchable([
    entry.id, entry.title, entry.kind, entry.category, entry.collection, ...(entry.tags ?? []),
    ...(entry.geometryKinds ?? []), entry.source?.title, entry.source?.license
  ].join(' '))]));
  function makePreview(entry, className) {
    const container = node('div', '', className);
    try {
      const content = preview(entry);
      if (!content || !['img', 'svg'].includes(content.localName) || content.ownerDocument !== document) throw Error('Preview unavailable');
      container.append(content);
    } catch {container.append(node('span', 'Preview unavailable'));}
    return container;
  }
  function renderDetail() {
    detail.dataset.empty = String(!selected);
    if (!selected) {
      detail.replaceChildren(node('h3', 'Choose a symbol or Style'), node('p', 'Select a card to see a larger preview, collection and source.'));
      return;
    }
    const title = node('h3', selected.title);
    const image = makePreview(selected, 'symbology-gallery-detail-preview');
    const metadata = node('dl');
    const add = (label, value) => {if (value) metadata.append(node('dt', label), node('dd', value));};
    add('Kind', labelFor(selected.kind));
    add('Geometry', [...new Set((selected.geometryKinds ?? []).map(geometryFor))].join(', '));
    add('Collection', selected.collection); add('Category', selected.category);
    add('Tags', (selected.tags ?? []).join(', '));
    add('Source', selected.source?.title); add('Version', selected.source?.version);
    add('License', selected.source?.license || 'Terms not recorded');
    detail.replaceChildren(title, image, metadata);
    try {
      const url = new URL(selected.source?.url);
      if (['http:', 'https:'].includes(url.protocol)) {
        const source = node('a', 'View source and terms'); source.href = url.href;
        source.target = '_blank'; source.rel = 'noopener noreferrer'; detail.append(source);
      }
    } catch {/* A missing source address never fabricates provenance. */}
    if (selected.recipe?.kind === 'reference') {
      detail.append(node('p', 'Reference artwork. Its original styling is preserved; it is not an editable map Style.'));
    }
    if (selected.recipe?.downloadUrl) {
      try {
        const url = new URL(selected.recipe.downloadUrl, document.baseURI);
        if (url.origin === document.location.origin || url.protocol === 'blob:' || /^data:image\/svg\+xml[;,]/.test(url.href)) {
          const download = node('a', 'Download original artwork'); download.href = url.href;
          download.download = selected.recipe.downloadName ?? `${selected.id.replace(/[^a-z0-9_-]/gi, '-')}.svg`;
          detail.append(download);
        }
      } catch {/* Only an available local asset gets a download action. */}
    }
  }
  function setChoosing(value) {
    choosing = value; root.setAttribute('aria-busy', String(value));
    for (const card of grid.querySelectorAll('button')) card.disabled = value;
  }
  async function choose(entry) {
    if (choosing || disposed) return;
    setChoosing(true); status.textContent = '';
    try {
      const accepted = await onChoose(entry);
      if (disposed) return;
      if (accepted === false) {status.textContent = 'Your current Style is unchanged. Save or discard its draft before choosing another item.'; return;}
      selected = entry; renderDetail();
      for (const card of grid.querySelectorAll('button')) card.setAttribute('aria-pressed', String(card.dataset.entryId === entry.id));
      status.textContent = `${entry.title} selected.`;
    } catch {if (!disposed) status.textContent = 'This item could not be selected. Your current Style is unchanged.';}
    finally {if (!disposed) setChoosing(false);}
  }
  function renderResults() {
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const start = page * PAGE_SIZE, visible = filtered.slice(start, start + PAGE_SIZE);
    grid.replaceChildren(...visible.map(entry => {
      const card = node('button', '', 'symbology-gallery-card'); card.type = 'button';
      card.dataset.entryId = entry.id; card.disabled = choosing;
      card.setAttribute('aria-label', `${entry.title} · ${labelFor(entry.kind)}`);
      card.setAttribute('aria-pressed', String(selected?.id === entry.id));
      const image = makePreview(entry, 'symbology-gallery-card-preview'); image.setAttribute('aria-hidden', 'true');
      card.append(image, node('strong', entry.title), node('span', entry.collection));
      card.addEventListener('click', () => void choose(entry)); return card;
    }));
    empty.hidden = filtered.length > 0;
    count.textContent = filtered.length ? `${start + 1}–${start + visible.length} of ${filtered.length} results · ${catalog.length} in library`
      : `0 results · ${catalog.length} in library`;
    pageNumber.textContent = `Page ${page + 1} of ${pages}`;
    previous.disabled = page === 0; next.disabled = page + 1 >= pages;
    pagination.hidden = filtered.length <= PAGE_SIZE;
  }
  function filter() {
    const terms = searchable(search.value).trim().split(/\s+/).filter(Boolean);
    filtered = catalog.filter(entry => (!kinds.value || entry.kind === kinds.value)
      && (!geometries.value || (entry.geometryKinds ?? []).some(value => geometryFor(value) === geometries.value))
      && (!categories.value || entry.category === categories.value)
      && (!collections.value || entry.collection === collections.value)
      && terms.every(term => index.get(entry.id).includes(term)));
    for (const [collection, button] of collectionButtons) button.setAttribute('aria-pressed', String(collection === collections.value));
    page = 0; renderResults();
  }
  search.addEventListener('input', filter);
  for (const control of [kinds, geometries, categories, collections]) control.addEventListener('change', filter);
  clear.addEventListener('click', () => {search.value = kinds.value = geometries.value = categories.value = collections.value = ''; filter(); search.focus();});
  previous.addEventListener('click', () => {page--; renderResults(); grid.querySelector('button')?.focus();});
  next.addEventListener('click', () => {page++; renderResults(); grid.querySelector('button')?.focus();});
  root.dispose = () => {disposed = true;};
  renderResults(); renderDetail();
  return root;
}
