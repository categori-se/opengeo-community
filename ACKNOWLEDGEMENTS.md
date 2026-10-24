# Open source and credits

OpenGeo Studio exists because people share geographic software, research,
standards and data. We thank the authors, maintainers and contributors whose
work supports this workspace for geospatial analysis and publishing.

The application includes a public **Open Source & Credits** page at `/credits`,
with license information shipped in each installation. This document is the
community source edition's editorial record of recognition. Exact versions,
roles and licensing evidence belong to the [foundation inventory](docs/open-source-foundations.md)
and [machine-readable register](governance/open-source-foundations.json).
Required upstream copyright, LICENSE and NOTICE files remain authoritative.

## Software we build on

| Project and community | Contribution to OpenGeo Studio |
| --- | --- |
| [MapLibre GL JS](https://maplibre.org/) | The default interactive map renderer and a foundation for reusable map output. |
| [OpenLayers](https://openlayers.org/) | Geometry, projection and spatial exchange utilities; also an independent interoperability peer. |
| [Observable Framework](https://observablehq.com/framework/), [Observable Plot](https://observablehq.com/plot/), [D3](https://d3js.org/) and [Observable Runtime](https://github.com/observablehq/runtime) | Application pages, charts, analytical publishing and supported notebook output. |
| [PMTiles](https://github.com/protomaps/PMTiles), [GeoTIFF.js](https://geotiffjs.github.io/), [proj4js](https://github.com/proj4js/proj4js) and [Earcut](https://github.com/mapbox/earcut) | Portable tiles, browser raster reading, coordinate transformations and geometry triangulation. |
| [jsPDF](https://github.com/parallax/jsPDF) and [svg2pdf.js](https://github.com/yWorks/svg2pdf.js), including James Hall, yWorks GmbH, Vitaly Puzrin and contributors | Browser vector PDF output from the existing Print scene; their supplied MIT licenses and embedded upstream notices remain authoritative. |
| [MathJax](https://www.mathjax.org/), The MathJax Consortium, MathJax Inc. and Design Science Inc. | Local mathematical layout and original TeX equation glyphs. Software Apache 2.0 and font SIL OFL 1.1 terms, source copyright notices and the reserved font name remain separate and travel with equation output. |
| [CodeMirror](https://codemirror.net/) and [Monaco Editor](https://microsoft.github.io/monaco-editor/) | Source editing in supported authoring workflows. |
| [PostgreSQL](https://www.postgresql.org/), [PostGIS](https://postgis.net/), [GDAL](https://gdal.org/), [PROJ](https://proj.org/) and [GEOS](https://libgeos.org/) | Database and processing foundations in configured backend services. |
| [FastAPI](https://fastapi.tiangolo.com/), [Psycopg](https://www.psycopg.org/), [DuckDB](https://duckdb.org/), [GeoPandas](https://geopandas.org/), [Apache Arrow](https://arrow.apache.org/), [Rasterio](https://rasterio.readthedocs.io/) and [Shapely](https://shapely.readthedocs.io/) | API, spatial analysis and data interchange in configured services. |
| [Open Sans](https://www.opensans.com/), [Maki](https://github.com/mapbox/maki) and [OpenStreetMap Carto](https://github.com/gravitystorm/openstreetmap-carto) contributors | Retained font/glyph assets and cartographic symbols, with their own source pins and notices. |

These are selected foundations, not a complete dependency inventory. The register
also recognizes other direct packages, runtime tools and contributors. Browser
software, database extensions, processing tools and build dependencies have
different roles; a self-hosted installation may enable only some workflows.

### Optional engines and separately licensed software

[CesiumJS](https://cesium.com/platform/cesiumjs/) supplies the optional globe
engine under Apache-2.0. The optional [Mapbox GL JS](https://www.mapbox.com/mapbox-gljs)
SDK has separate proprietary terms and requires operator/user configuration;
it is not covered by OpenGeo Studio's Apache license. Preserve its notices and
provider terms when distributing or enabling it.

## Learning from the GIS community

We acknowledge the following projects as workflow, design and interoperability
references. Recognition does not imply that their code is bundled, that current
feature parity has been established, or that their maintainers endorse this work.

| Reference | Role in OpenGeo Studio's development |
| --- | --- |
| [QGIS](https://qgis.org/) | GIS authoring, cartography and independent native-client interoperability |
| [Google Earth Pro](https://www.google.com/earth/about/versions/) | Proprietary behavioral reference for Places, KML, globe interaction and output |
| [GeoLibre](https://github.com/opengeos/GeoLibre) | Browser GIS, portable Projects and processing handoff |
| [GeoNode](https://geonode.org/) | Catalog, metadata, permissions, federation and publishing |
| [GeoLens](https://github.com/geolens-io/geolens) | Catalog, custody and connected map workflows; see retained source locks |
| [GeoServer](https://geoserver.org/) | Spatial services, stores, Styles, caching and security |
| [MapServer](https://mapserver.org/) | Cartography, reprojection, rendering and services |
| [GeoMoose](https://geomoose.org/) | Configurable portals, query, annotation and print |
| [MapStore](https://mapstore.geosolutionsgroup.com/) | Maps, dashboards, stories and shared applications |
| [Jupyter](https://jupyter.org/) | Computation, notebooks and analytical explanation |
| [ArcGIS](https://www.esri.com/en-us/arcgis/about-arcgis/overview), [Mapbox Studio](https://www.mapbox.com/mapbox-studio), [Felt](https://felt.com/), [CARTO](https://carto.com/) | Design references for cartography and organizational sharing |

Reference versions and upstream licensing evidence are retained in
`parity/fixtures/*-source-lock.json` where available. Those are dated reference
identities, not current upstream parity or conformance claims. Runtime dependency
versions belong to their lockfiles and the foundation register.

## The people behind the maps

We thank [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[OpenMapTiles](https://openmaptiles.org/) and [OpenFreeMap](https://openfreemap.org/),
alongside public data communities including [NASA](https://www.earthdata.nasa.gov/),
[USGS](https://www.usgs.gov/) and [MassGIS](https://www.mass.gov/orgs/massgis-bureau-of-geographic-information).
Their data and services support selected maps and examples; actual sources vary
by Layer, basemap and installation. This recognition does not imply that every
installation contains their data or that those providers endorse OpenGeo Studio.

Each map and dataset must retain its own source credits, license, access rights
and conditions of use. General credits do not replace attribution beside a map
or in a print, image, embed or Publication. Follow the source's requirements,
including the [OpenStreetMap attribution guidance](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
for outputs using OSM data. Keep unknown rights explicit.

Synthetic demonstration data retains its stated terms. This repository does not
redistribute the private hosted archive or grant access to its contents.

## Standards

The resource model draws on [DCAT 3](https://www.w3.org/TR/vocab-dcat-3/),
[DCTERMS](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/),
[JSON-LD](https://www.w3.org/TR/json-ld11/), [OGC](https://www.ogc.org/standards/),
[STAC](https://stacspec.org/), [PROV-O](https://www.w3.org/TR/prov-o/) and
[ODRL](https://www.w3.org/TR/odrl-model/). Support is operation-specific;
referencing a standard does not assert tested conformance.

## Contributors, operators and infrastructure

OpenGeo Studio is developed and maintained by Aaron Kyle Dennis for categori.se
and OpenGeo.Tools. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution and
historical authorship information. First-party community source uses
[Apache-2.0](LICENSE); separately licensed components retain their original terms.

Our hosted service uses Amazon Web Services for cloud infrastructure and managed
services. Hosting infrastructure is distinct from the open-source foundations
and from each independent operator's installation and data responsibilities.

Self-hosting operators may add installation-specific credits alongside this
record while preserving upstream and project attribution. Please submit credit
corrections through the [community contribution process](CONTRIBUTING.md).
Project names and trademarks belong to their respective owners; acknowledgment
does not imply affiliation, sponsorship or endorsement.

See [NOTICE](NOTICE), the [licensing guide](docs/community-licensing.md) and the
individual upstream notices for distribution scope and remaining review limits.

## Historical acknowledgment

The original OpenGeo.Tools recognition is retained below.

The people who build and maintain open-source geospatial software make this
project possible. QGIS, GDAL and PostGIS establish foundations for analysis,
formats and spatial data; GeoServer and MapServer for services and cartography;
GeoNode, MapStore and GeoMoose for catalogs, sharing and configurable applications;
and OpenLayers and MapLibre for browser mapping. GeoLibre and GeoLens contribute
useful approaches to portable GIS and connected catalog-to-map workflows. These
projects, their contributors and the wider standards community shape both what
we build on and how practitioners expect the tools to work.
