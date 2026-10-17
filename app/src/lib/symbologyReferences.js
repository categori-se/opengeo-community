// Primary cartographic guides. Artwork/version attribution stays on each item.
export const SYMBOLOGY_REFERENCES = Object.freeze([
  {title: 'USGS · US Topo', description: 'Official guides to structures, transport, water, terrain, land cover and boundaries.',
    links: [
      ['Page 1 · structures, transport and water', 'https://www.usgs.gov/media/images/us-topo-map-symbol-guide-page-1-structures-transportation-hydrography'],
      ['Page 2 · terrain, land cover and boundaries', 'https://www.usgs.gov/media/images/us-topo-map-symbol-guide-page-2-hydrography-terrain-land-cover-image-boundaries-public'],
      ['Symbol file sample', 'https://www.usgs.gov/media/images/us-topo-map-symbol-file-sample'],
      ['OnDemand Topo guide', 'https://www.usgs.gov/ngp-standards-and-specifications/75-minute-ondemand-topo-cartographic-specifications-map-symbol']
    ], note: 'Public-domain reference guides. OpenGeo’s editable presets are identified separately.'},
  {title: 'OpenStreetMap Carto', collection: 'OpenStreetMap Carto', description: 'The complete pinned artwork collection, including points of interest, route shields and pattern references.',
    links: [
      ['Point symbols and feature tags', 'https://wiki.openstreetmap.org/wiki/OpenStreetMap_Carto/Symbols'],
      ['Lines', 'https://wiki.openstreetmap.org/wiki/OpenStreetMap_Carto/Lines'],
      ['Areas', 'https://wiki.openstreetmap.org/wiki/OpenStreetMap_Carto/Areas']
    ], note: 'CC0 artwork. Each item records its source version; reference artwork is labelled.'},
  {title: 'Maki', collection: 'Maki', description: 'The complete Maki 8.2.0 collection of map icons for amenities, transport, recreation and services.',
    links: [['Source, icons and terms', 'https://github.com/mapbox/maki/tree/6ab50f392294aeb20b3af83e8a10067151876eb9']],
    note: '215 icons · CC0-1.0.'},
  {title: 'MassGIS · MassEnviroScreen', collection: 'MassGIS · MassEnviroScreen', description: 'All 33 indicator examples from the supplied MassEnviroScreen maps, with their numeric fields and color ramps.',
    links: [['MassGIS source and indicator guidance', 'https://www.mass.gov/info-details/cumulative-impact-analysis']],
    note: 'Editable thematic examples; choose a field appropriate to your data.'}
].map(item => Object.freeze({...item, links: Object.freeze(item.links.map(link => Object.freeze(link)))})));
