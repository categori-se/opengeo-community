---
title: Open source & credits
toc: false
---

<nav aria-label="Credits navigation"><a href="/">Return to the workspace</a></nav>

# Open source & credits

OpenGeo Studio builds on decades of shared work by software authors, maintainers,
researchers, public agencies and geographic data contributors. Thank you for making
geospatial analysis and publishing possible.

## Software we build on

- [MapLibre GL JS](https://maplibre.org/) provides the default interactive map renderer.
- [Observable Framework](https://observablehq.com/framework/),
  [Observable Plot](https://observablehq.com/plot/),
  [Notebook Kit](https://github.com/observablehq/notebook-kit) and
  [D3](https://d3js.org/) support applications, analytical publishing and visualization.
- [OpenLayers](https://openlayers.org/) supplies geometry, projection and interchange
  utilities. [PMTiles](https://github.com/protomaps/PMTiles),
  [GeoTIFF.js](https://github.com/geotiffjs/geotiff.js) and
  [Proj4js](https://github.com/proj4js/proj4js) support geographic formats and coordinates.
- [Open Sans](https://src.fedoraproject.org/rpms/open-sans-fonts),
  [Maki](https://github.com/mapbox/maki) and
  [OpenStreetMap Carto](https://github.com/openstreetmap-carto/openstreetmap-carto) contribute
  map fonts and symbols. Their notices remain with the supplied assets.

The [distribution notices](/third-party-notices.txt) and
[dependency inventory](/third-party-inventory.json) identify additional packages
and their supplied license information. These projects retain their own terms.

## Processing and database foundations

Configured server workflows use [PostgreSQL](https://www.postgresql.org/),
[PostGIS](https://postgis.net/), [GDAL/OGR](https://gdal.org/),
[PROJ](https://proj.org/) and [GEOS](https://libgeos.org/), alongside other tools
recorded in the [foundation inventory](/notices/open-source-foundations.md).
The anonymous browser demo does not run these server services.

## Optional renderers and services

[CesiumJS](https://cesium.com/platform/cesiumjs/) supplies optional globe rendering.
[Mapbox GL JS](https://github.com/mapbox/mapbox-gl-js) is an optional proprietary
renderer under its own license and service terms. Availability depends on the
installation and selected content; provider tokens and hosted services have separate
requirements. OpenLayers utilities do not make it a selectable renderer.

## Learning from the GIS community

We recognize [QGIS](https://qgis.org/),
[GeoLibre](https://github.com/opengeos/GeoLibre),
[GeoLens](https://github.com/geolens-io/geolens), [GeoNode](https://geonode.org/),
[GeoServer](https://geoserver.org/), [MapServer](https://mapserver.org/),
[GeoMoose](https://geomoose.org/) and [MapStore](https://mapstore.geosolutionsgroup.com/)
as workflow, design and interoperability references. This recognition does not claim
their code is bundled with Studio or establish upstream parity.

The [full acknowledgments](/notices/ACKNOWLEDGEMENTS.md) preserve the wider history,
including proprietary reference products and the standards community.

## People, data and cartography

We thank [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and
the maintainers of [OpenMapTiles](https://openmaptiles.org/),
[OpenFreeMap](https://openfreemap.org/) and the public datasets available through
Studio. Selected examples may draw on MassGIS, NOAA, NASA, USGS and other providers.
Sources vary by map and installation.

Review each Layer, basemap and Publication for its source credits, rights and
conditions of use. Keep unknown rights explicit. Software notices do not grant
data or service rights. Keep the
selected map's attribution when sharing it, and review its terms before reuse.
Synthetic examples remain identified as synthetic.

## Project and infrastructure

OpenGeo Studio is developed by Aaron Kyle Dennis for categori.se and OpenGeo.Tools.
The [community source](https://github.com/categori-se/opengeo-community) is available
under [Apache License 2.0](/notices/LICENSE), subject to the separate terms of
included components. The managed service uses Amazon Web Services for cloud
infrastructure; AWS services are distinct from the open-source software credited here.
Independent installations retain their own operator and infrastructure choices.

This page and the linked notices ship with Studio and its anonymous demo.
Consult the [project NOTICE](/notices/NOTICE),
[structured foundation register](/notices/open-source-foundations.json) and
[distribution review](/notices/community-licensing.md) for scope and outstanding
review limits. Release-specific container inventories remain separate from browser
notices. Operators can add installation-specific recognition while preserving
upstream credits.

Corrections are welcome through the
[community repository](https://github.com/categori-se/opengeo-community/issues).
Names and trademarks belong to their respective owners. Recognition does not imply
affiliation, sponsorship or endorsement.
