# Acknowledgements and references

The people who build and maintain open-source geospatial software make this
project possible. QGIS, GDAL and PostGIS establish foundations for analysis,
formats and spatial data; GeoServer and MapServer for services and cartography;
GeoNode, MapStore and GeoMoose for catalogs, sharing and configurable applications;
and OpenLayers and MapLibre for browser mapping. GeoLibre and GeoLens contribute
useful approaches to portable GIS and connected catalog-to-map workflows. These
projects, their contributors and the wider standards community shape both what
we build on and how practitioners expect the tools to work.

This recognition is retained from the original OpenGeo documentation. Keep it
alongside the [foundation inventory](docs/open-source-foundations.md),
[machine-readable license register](governance/open-source-foundations.json),
[NOTICE](NOTICE) and individual upstream notices. This is not a substitute for
their license terms or a claim of endorsement.

## Reference products

| Reference | Role in OpenGeo's development |
| --- | --- |
| [QGIS](https://qgis.org/) | GIS authoring, cartography and independent native-client interoperability |
| [Google Earth Pro](https://www.google.com/earth/about/versions/) | Proprietary behavioral reference for Places, KML, globe interaction and output |
| [GeoLibre](https://github.com/opengeos/GeoLibre) | Browser GIS, portable Projects and processing handoff |
| [GeoNode](https://geonode.org/) | Catalog, metadata, permissions, federation and publishing |
| [GeoLens](https://github.com/opengeos/GeoLens) | Catalog, custody and connected map workflows; see retained source locks |
| [GeoServer](https://geoserver.org/) | Spatial services, stores, Styles, caching and security |
| [MapServer](https://mapserver.org/) | Cartography, reprojection, rendering and services |
| [GeoMoose](https://geomoose.org/) | Configurable portals, query, annotation and print |
| [MapStore](https://mapstore.geosolutionsgroup.com/) | Maps, dashboards, stories and shared applications |
| [OpenLayers](https://openlayers.org/) | Independent browser clients, sources, projections and interchange |
| [MapLibre](https://maplibre.org/) | OpenGeo's primary browser renderer |
| [GDAL](https://gdal.org/), [PostGIS](https://postgis.net/) | Spatial formats, transforms and database foundations |
| [Observable](https://observablehq.com/framework/), [Jupyter](https://jupyter.org/) | Computation, notebooks and analytical explanation |
| [ArcGIS](https://www.esri.com/en-us/arcgis/about-arcgis/overview), [Mapbox Studio](https://www.mapbox.com/mapbox-studio), [Felt](https://felt.com/), [CARTO](https://carto.com/) | Design references for cartography and organizational sharing |

Reference versions and upstream licensing evidence are retained in
`parity/fixtures/*-source-lock.json` where available. Those are dated reference
identities, not current upstream parity or conformance claims. Runtime dependency
versions belong to their lockfiles and the foundation register.

## Standards and data

The resource model draws on [DCAT 3](https://www.w3.org/TR/vocab-dcat-3/),
[DCTERMS](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/),
[JSON-LD](https://www.w3.org/TR/json-ld11/), [OGC](https://www.ogc.org/standards/),
[STAC](https://stacspec.org/), [PROV-O](https://www.w3.org/TR/prov-o/) and
[ODRL](https://www.w3.org/TR/odrl-model/). Support is operation-specific;
referencing a standard does not assert tested conformance.

Software licensing does not license provider services or datasets. Preserve
per-distribution rights, source attribution and known uncertainty. Synthetic
demonstration data retains its stated terms; this repository does not redistribute
the private hosted archive or grant access to its contents.
