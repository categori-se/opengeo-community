import {upgradeMapDefinition} from './mapDefinition.js';
import {placesForSave} from './kmlPlaces.js';
import {projectPrintLayouts} from './printLayouts.js';
import {publicItemUrl} from './staticItemSearch.js';

export const BROWSER_PROJECT_FILE_BYTES = 2_000_000;

// Reading a file never fetches sources or changes browser storage.
export function readBrowserProjectFile(text, {catalog = []} = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > BROWSER_PROJECT_FILE_BYTES) throw Error('Project file exceeds the 2 MB browser limit.');
  const raw = JSON.parse(text);
  if (!['browser-only-demo', 'browser-draft', 'browser-personal'].includes(raw?.persistence?.mode)) throw Error('Choose a browser Project file. Managed Projects must be opened in Studio.');
  const pending = [[raw, 0]]; let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 100_000 || depth > 40) throw Error('Project file is too complex for this browser.');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Project file contains an unsupported object key.');
      pending.push([child, depth + 1]);
    }
  }
  const definition = upgradeMapDefinition(raw);
  const layouts = definition.extensions?.opengeoPrintLayouts;
  if (layouts !== undefined) projectPrintLayouts({id: layouts?.projectId, definition});
  if (!Array.isArray(definition.layers) || definition.layers.length > 64) throw Error('A browser Project can contain at most 64 Layers.');
  const ids = new Set();
  for (const layer of definition.layers) {
    if (!layer || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(layer.layerId ?? '') || ids.has(layer.layerId)) throw Error('Project Layer identities must be valid and unique.');
    ids.add(layer.layerId);
    if (typeof layer.title !== 'string' || !layer.title.trim() || layer.title.length > 240) throw Error('A Layer title is missing or too long.');
    if (layer.styleReference) throw Error('This Project requires a managed Style. Open it in Studio.');
    if (layer.sourceType === 'kml-places') {
      const document = layer.kmlDocument ?? (layer.layerId === 'kml-places' ? definition.kmlPlaces : null);
      if (!document) throw Error(`The KML document for ${layer.title} is missing.`);
      if (!layer.kmlDocument && layer.layerId === 'kml-places') {
        layer.kmlInterchangeReport ??= definition.kmlInterchangeReport;
        layer.kmlNetworkLinkState ??= definition.kmlNetworkLinkState;
      }
      layer.kmlDocument = placesForSave(document);
    } else if (layer.geojson?.type === 'FeatureCollection' && Array.isArray(layer.geojson.features)) {
      if (!['geojson-object', 'geojson-archive', 'geojson-inline', 'arcgis-feature-layer-snapshot'].includes(layer.sourceType)) throw Error(`The local source type for ${layer.title} is not supported.`);
    } else if (layer.browserCatalogId) {
      if (!catalog.some(entry => entry.id === layer.browserCatalogId)) throw Error(`The catalog source for ${layer.title} is unavailable.`);
    } else if (layer.sourceType === 'cog-raster') {
      // Match the public raster reader's admission without reading its source or
      // replacing the original URL, custody, rights or reference configuration.
      const url = new URL(publicItemUrl(layer.sourceUrl));
      if (url.search || !/\.tiff?$/i.test(url.pathname)) throw Error(`The source for ${layer.title} must be a query-free public TIFF reference.`);
    } else if (['xyz-raster', 'wms-raster', 'pmtiles-vector', 'pmtiles-raster'].includes(layer.sourceType)) {
      for (const value of [layer.sourceUrl, layer.tileUrl].filter(Boolean)) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:api[-_]?key|access[-_]?token|token|password|signature|credential)$/i.test(key))) throw Error(`The source for ${layer.title} must use credential-free HTTPS.`);
      }
      if (!layer.sourceUrl && !layer.tileUrl) throw Error(`The source for ${layer.title} is missing.`);
    } else throw Error(`The data for ${layer.title} is not included or available in the Demo catalog.`);
  }
  definition.kmlLayerDocuments = true;
  definition.persistence = {mode: raw.persistence.mode, uploaded: false, published: false};
  return definition;
}
