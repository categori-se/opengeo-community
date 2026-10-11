# Reference applications and feature comparison

OpenGeo Studio is being developed for researchers, planners, and environmental and
social practitioners who need to retain sources, explain methods and share work
that others can inspect and reuse. Reusable spatial resources, explicit source
custody, separate producer facts and interpretations, and analytical publications
are its focus. Established GIS applications overlap substantially with that work;
reproducibility, catalogs, browser access and sharing are shared foundations.

The community edition includes the full suite of tools. It is a prerelease source
edition: local Project/map save–restart–reopen and a bounded processing/publication
pilot have passed, while clean-machine installation, independent-account AWS
acceptance and the complete native publication journey remain open. The
[capability and maturity guide](community-capabilities.md) distinguishes source
implementation, connected checks and planned or unaccepted workflows.

We build on open-source libraries and compare selected behavior with these
applications. The
[foundation register](../governance/open-source-foundations.json) and pinned
source fixtures preserve source references, audited versions and license evidence.

| Reference | Capabilities that guide OpenGeo Studio | OpenGeo Studio implementation and continuing work |
| --- | --- | --- |
| [QGIS](https://qgis.org/) 3.44.12 | Desktop cartography, editing, processing, formats and service clients | Governed Layers/Styles, spatial jobs, common-format ingestion and service exchange; QGIS is an independent WFS/WMTS interoperability client in the retained fixtures. Desktop workflow breadth remains a continuing comparison. |
| [GeoLibre](https://github.com/opengeos/GeoLibre) 2.6.0 | Browser GIS, portable projects, source inspection, analysis and layouts | Portable project/view adapters, source inventory and selected browser/server operations. Authoring, renderer round trips and layout breadth continue. |
| [GeoNode](https://github.com/GeoNode/geonode) 5.1.0 | Governed resources, catalog discovery, metadata, sharing, harvesting and publishing | Persistent resources, scoped permissions, catalog/metadata mappings and a bounded anonymous catalog federation adapter. Community workflows, migration and publishing breadth continue. |
| [GeoServer](https://github.com/geoserver/geoserver) 3.0.1 | Stores, layer groups, styles, OGC services, service security and caching | Versioned service administration, governed stores/styles, private service controls and bounded cache management. Protocol operation/version coverage continues. |
| [MapServer](https://github.com/MapServer/MapServer) 8.6.5 | Cartography, raster/vector formats, reprojection, OGC publication and tile delivery | Representative render/format peers, bounded Mapfile cartography translation and controlled tile generations. OGC publication coverage continues. |
| [GeoMoose](https://github.com/geomoose/gm3) 3.15.2 | Configurable web portals, mapbooks, catalog layers, query, annotation and print | Mapbook adapter, selected layer/query workflows and temporary annotations. Print breadth and distributed-service behavior continue. |
| [OpenLayers](https://github.com/openlayers/openlayers) 10.10.0 | Map/view/layer model, interactions, formats, projections and browser service clients | Independent browser peers exercise map/layer, geometry-format and browser-platform behavior. Interaction and source/protocol breadth continue. |
| [GeoLens](https://github.com/geolens-io/geolens) 1.20.0 | Connected catalog discovery, source custody, reusable maps and governed publication | Catalog, custody, metadata refresh, services, processing and publication comparisons pass their finite rows; map composition/styling breadth continues. |
| Google Earth Pro 7.3.7.1327 | Discoverable Places/layer organization, globe navigation, KML/KMZ and annotated output | An interaction and exchange reference across ten continuing comparison families; its proprietary application remains a behavioral reference. |

## Relative parity by capability

The table below preserves the status of the maintained, version-pinned comparison
rows when the Community edition was prepared on October 11, 2026. **Pass** means
the row's finite comparison passed its retained checks. **Partial** means some of
that row's acceptance scope remains open. These statuses describe selected
behavior; release acceptance and protocol conformance have their own checks.

| Reference | Capability | Recorded status |
| --- | --- | --- |
| GeoLibre | Portable projects and views | Partial |
| GeoLibre | Source and layer inventory | Pass — finite inventory, including explicitly preserved source definitions |
| GeoLibre | GIS authoring and inspection | Partial |
| GeoLibre | Analysis and automation | Pass — count, bounds, bbox, centroids, vector-to-PMTiles and raster-to-COG scope |
| GeoLibre | Layout, story, dashboard and print | Partial |
| GeoNode | Governed resource types | Partial |
| GeoNode | Catalog and discovery | Partial |
| GeoNode | Metadata management | Partial |
| GeoNode | Sharing and community | Partial |
| GeoNode | Upload, create, edit, style, version and download | Partial |
| GeoNode | Federation and harvesting | Pass — anonymous 5.1.0 catalog metadata, manual activation |
| GeoNode | Publishing and administration | Partial |
| GeoServer | Catalog administration | Pass — versioned stores, layer groups, styles and render profiles |
| GeoServer | Data services | Partial |
| GeoServer | Service security and caching | Pass — private administered service and bounded generation controls |
| MapServer | Rendering and cartography | Pass — representative finite cartography peers |
| MapServer | Formats and reprojection | Pass — selected audited format/CRS operations |
| MapServer | OGC publication | Partial |
| MapServer | Configuration and automation | Pass — bounded Mapfile cartography translation |
| MapServer | Tile caching | Pass — private KVP WMTS, PNG/WebMercatorQuad, explicit seed/invalidation |
| GeoMoose | Configurable portal and mapbook | Pass — governed mapbook 3.0 adapter |
| GeoMoose | Catalog and layers | Pass — selected direct sources and governed bindings |
| GeoMoose | Identify, search and query | Pass — bounded geometry selection and result handoff |
| GeoMoose | Temporary work and annotation | Pass — local point, line and single-ring polygon editing |
| GeoMoose | Print and responsive delivery | Partial |
| GeoMoose | Distributed interoperability | Partial |
| OpenLayers | Map, view and layer model | Pass — pinned Chromium peer and finite layer set |
| OpenLayers | Controls and interactions | Partial |
| OpenLayers | Sources and protocols | Partial |
| OpenLayers | Formats, projections and filters | Pass — GeoJSON/WKT/WKB/EWKB and bounded XML filters |
| OpenLayers | Browser platform features | Pass — bounded workbench/browser peer |
| GeoLens | Catalog discovery and search | Pass — scoped catalog workflows |
| GeoLens | Source custody and data exchange | Pass — explicit custody and exchange operations |
| GeoLens | Metadata, provenance and verified refresh | Pass — scoped evidence and refresh behavior |
| GeoLens | Reusable map composition and styling | Partial |
| GeoLens | Open services and independent clients | Pass — selected service/client peers |
| GeoLens | Analysis and derived resources | Pass — bounded processing operations |
| GeoLens | Sharing, permissions and publication | Pass — scoped governed workflows |
| GeoLens | Automation and operational control | Pass — selected automation interfaces |
| Google Earth Pro | Globe/terrain, Places/KML, time/imagery, exchange, measurement, tours, output, search/navigation, network/overlay and flight workflows | Partial — ten comparison families |

QGIS is tracked as an independent workflow and interoperability reference rather
than an aggregate application-parity score. Selected GeoServer extensions are
tracked individually as optional integration work.

The retained checks span August–October 2026. GeoLibre's comparison is pinned to
2.6.0; reviewing the subsequently identified 3.0.0 source and documentation is a
roadmap item. Additional engines, data formats and provider integrations progress
from named user workflows and version-specific acceptance.

Source/version evidence: [QGIS](../parity/fixtures/qgis/qgis-3.44.12-source-lock.json),
[GeoLibre](../parity/fixtures/geolibre/geolibre-2.6.0-source-lock.json),
[GeoNode](../parity/fixtures/geonode/geonode-5.1.0-source-lock.json),
[GeoServer](../parity/fixtures/geoserver/geoserver-3.0.1-source-lock.json),
[MapServer](../parity/fixtures/mapserver/mapserver-8.6.5-source-lock.json),
[GeoMoose](../parity/fixtures/geomoose/geomoose-3.15.2-source-lock.json),
[OpenLayers](../parity/fixtures/openlayers/openlayers-10.10.0-source-lock.json),
[GeoLens](../parity/fixtures/geolens-003/source-lock.json), and
[Google Earth Pro](../parity/fixtures/google-earth-pro-7.3.7-package-baseline.json).

## The workflow OpenGeo Studio aims to make useful

For an environmental screening or a socioeconomic comparison, a practitioner
needs to know which data version supported a finding, whether the source was
preserved, what assumptions entered processing, and what a recipient can inspect.
Our goal is to keep those answers connected through source inspection, map
composition and analytical publication. Concrete examples and completed user
journeys must demonstrate the benefit; the resource model alone does not prove it.

A Layer keeps its identity across Projects. Styles are reusable resources.
Projects compose those resources; Publications combine analytical and narrative
work with versioned outputs. Catalog inspection opens the selected Layer, while
Project persistence is a separate deliberate action.

Source, normalized, curated and inferred metadata remain distinct. Referenced, hosted,
cached, mirrored and derived data retain explicit custody. Provenance, rights and
contributor credit accumulate through the workflow.

AWS infrastructure connects the browser, spatial database, API, queues and
publication components. Request-driven execution, reusable artifacts, automatic
database pause and deliberate processing are intended to reduce idle compute and
repeated processing. Low operating cost remains a design goal; it needs a
reproducible workload and observed cost breakdown. Storage, requests, encryption,
networking and optional worker infrastructure still incur charges, as described in
the [AWS deployment guide](community-aws.md).
