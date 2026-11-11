# Reference applications and feature comparison

OpenGeo Studio builds on established GIS software and open standards. The
comparisons below cover selected capabilities at the listed versions; they help
contributors identify useful patterns and remaining work. For current community
installation and workflow limits, see the
[capability guide](community-capabilities.md).

We build on open-source libraries and compare selected behavior with these
applications. The
[foundation register](../governance/open-source-foundations.json) and pinned
source fixtures preserve source references, audited versions and license evidence.

| Reference | Capabilities that guide OpenGeo Studio | OpenGeo Studio implementation and continuing work |
| --- | --- | --- |
| [QGIS](https://qgis.org/) 3.44.12 | Desktop cartography, editing, processing, formats and service clients | Governed Layers/Styles, spatial jobs, common-format ingestion and service exchange; QGIS is an independent WFS/WMTS interoperability client in the retained fixtures. Desktop workflow breadth remains a continuing comparison. |
| [GeoLibre](https://github.com/opengeos/GeoLibre) 2.6.0 baseline; 3.0.0 native portable acceptance | Browser GIS, portable projects, source inspection, analysis and layouts | Portable/native exchange and print families meet their declared criteria. GIS authoring/inspection remains partial; conversion losses stay explicit. |
| [GeoNode](https://github.com/GeoNode/geonode) 5.1.0 | Governed resources, catalog discovery, metadata, sharing, harvesting and publishing | Persistent resources, scoped permissions, catalog/metadata mappings and a bounded anonymous catalog federation adapter. Community workflows, migration and publishing breadth continue. |
| [GeoServer](https://github.com/geoserver/geoserver) 3.0.1 | Stores, layer groups, styles, OGC services, service security and caching | Versioned service administration, governed stores/styles, private service controls and bounded cache management. Protocol operation/version coverage continues. |
| [MapServer](https://github.com/MapServer/MapServer) 8.6.5 | Cartography, raster/vector formats, reprojection, OGC publication and tile delivery | Representative render/format peers, bounded Mapfile cartography translation and controlled tile generations. OGC publication coverage continues. |
| [GeoMoose](https://github.com/geomoose/gm3) 3.15.2 | Configurable web portals, mapbooks, catalog layers, query, annotation and print | Mapbook, selected layer/query workflows and temporary annotations; print/responsive acceptance covers the declared desktop/mobile profiles. Distributed interoperability remains partial. |
| [OpenLayers](https://github.com/openlayers/openlayers) 10.10.0 | Map/view/layer model, interactions, formats, projections and browser service clients | Independent browser peers exercise map/layer, geometry-format and browser-platform behavior. Interaction and source/protocol breadth continue. |
| [GeoLens](https://github.com/geolens-io/geolens) 1.20.0 | Connected catalog discovery, source custody, reusable maps and governed publication | All eight pinned scoped families pass, including reusable map composition/styling. Broader portrayal and observed upstream drift remain outside those accepted criteria. |
| Google Earth Pro 7.3.7.1327 | Discoverable Places/layer organization, globe navigation, KML/KMZ and annotated output | An interaction and exchange reference across ten continuing comparison families; its proprietary application remains a behavioral reference. |

## Relative parity by capability

These are recorded results for the version-pinned comparisons. **Pass** means
the named comparison passed its checks; **Partial** means work remains within
that scope. Production readiness and standards conformance require separate
verification.

The November 11, 2026 checkpoint records **31 passed, 18 partial and one
conditional exclusion across 50 families**. Counts follow the retained
criterion-level acceptance records; they are not a product-completion percentage. These scoped results
do not establish full parity with the reference applications or cover the full
QGIS workflow scope.

| Reference | Capability | Recorded status |
| --- | --- | --- |
| GeoLibre | Portable projects and views | Pass — native 3.0.0 / format 0.2.0 and hosted persistence; [accepted criteria](https://github.com/categori-se/opengeo-community/issues/17) |
| GeoLibre | Source and layer inventory | Pass — finite inventory, including explicitly preserved source definitions |
| GeoLibre | GIS authoring and inspection | Partial |
| GeoLibre | Analysis and automation | Pass — count, bounds, bbox, centroids, vector-to-PMTiles and raster-to-COG scope |
| GeoLibre | Layout, story, dashboard and print | Pass — original C01–C03, including published output; [accepted criteria](https://github.com/categori-se/opengeo-community/issues/14) |
| GeoNode | Governed resource types | Partial |
| GeoNode | Catalog and discovery | Pass — [declared local and published profiles](../parity/reports/geonode-catalog-discovery.json) |
| GeoNode | Metadata management | Partial |
| GeoNode | Sharing and community | Partial |
| GeoNode | Upload, create, edit, style, version and download | Partial |
| GeoNode | Federation and harvesting | Pass — anonymous 5.1.0 catalog metadata, manual activation |
| GeoNode | Publishing and administration | Partial |
| GeoServer | Catalog administration | Pass — versioned stores, layer groups, styles and render profiles |
| GeoServer | Data services | Partial |
| GeoServer | Service security and caching | Pass — private administered service and bounded generation controls |
| GeoServer | Selected extensions | Conditional exclusion — optional integration scope; retained baseline review |
| MapServer | Rendering and cartography | Pass — representative finite cartography peers |
| MapServer | Formats and reprojection | Pass — selected audited format/CRS operations |
| MapServer | OGC publication | Partial |
| MapServer | Configuration and automation | Pass — bounded Mapfile cartography translation |
| MapServer | Tile caching | Pass — private KVP WMTS, PNG/WebMercatorQuad, explicit seed/invalidation |
| GeoMoose | Configurable portal and mapbook | Pass — governed mapbook 3.0 adapter |
| GeoMoose | Catalog and layers | Pass — selected direct sources and governed bindings |
| GeoMoose | Identify, search and query | Pass — bounded geometry selection and result handoff |
| GeoMoose | Temporary work and annotation | Pass — local point, line and single-ring polygon editing |
| GeoMoose | Print and responsive delivery | Pass — [desktop and 390px emulated-touch profiles](../parity/reports/geomoose-print-responsive.json) |
| GeoMoose | Distributed interoperability | Partial |
| OpenLayers | Map, view and layer model | Pass — pinned Chromium peer and finite layer set |
| OpenLayers | Controls and interactions | Partial |
| OpenLayers | Sources and protocols | Partial |
| OpenLayers | Formats, projections and filters | Pass — GeoJSON/WKT/WKB/EWKB and bounded XML filters |
| OpenLayers | Browser platform features | Pass — bounded workbench/browser peer |
| GeoLens | Catalog discovery and search | Pass — scoped catalog workflows |
| GeoLens | Source custody and data exchange | Pass — explicit custody and exchange operations |
| GeoLens | Metadata, provenance and verified refresh | Pass — scoped evidence and refresh behavior |
| GeoLens | Reusable map composition and styling | Pass — pinned LineString/Style reuse in two saved maps; broader portrayal remains unverified |
| GeoLens | Open services and independent clients | Pass — selected service/client peers |
| GeoLens | Analysis and derived resources | Pass — bounded processing operations |
| GeoLens | Sharing, permissions and publication | Pass — scoped governed workflows |
| GeoLens | Automation and operational control | Pass — selected automation interfaces |
| Google Earth Pro | Virtual globe, imagery, terrain, and 3D scene | Pass — [declared criterion report](../parity/reports/google-earth-pro-002-globe-camera.json) |
| Google Earth Pro | Places tree and KML/KMZ authoring | Partial |
| Google Earth Pro | Historical imagery, sunlight, and immersive panoramas | Partial |
| Google Earth Pro | GIS, spreadsheet, imagery, GeoJSON, and GPS exchange | Partial |
| Google Earth Pro | 2D/3D measurement, elevation profiles, and viewshed | Pass — [declared criterion report](../parity/reports/google-earth-pro-006-path-measurement-profile.json) |
| Google Earth Pro | Tours, narration, and movie capture | Partial |
| Google Earth Pro | Annotated print and saved map images | Pass — [declared criterion report](../parity/reports/google-earth-pro-008-print-save-image.json) |
| Google Earth Pro | Place search, fly-to navigation, layers, and saved views | Partial |
| Google Earth Pro | Network links, overlays, WMS, and regionated content | Partial |
| Google Earth Pro | Terrain-aware flight simulator | Partial |

QGIS is tracked as an independent workflow and interoperability reference rather
than an aggregate application-parity score. Selected GeoServer extensions are
tracked individually as optional integration work.

GeoLibre's historical comparison retains its 2.6.0 source lock. The accepted
portable/native workflow uses 3.0.0 / format 0.2.0, with scoped hosted Save,
fresh reopen, conflict and history acceptance recorded in [#17](https://github.com/categori-se/opengeo-community/issues/17).
The later retained 3.6.1 Save As attempt failed; compatibility with that version
is not claimed. GeoLens's retained comparison also records 1.21.1
drift beyond its 1.20.0 baseline. Full reference scope and those version differences
remain open; new engines, formats and integrations follow specific user workflows
and version-specific checks. See the standalone [renderer guide](community-renderers.md)
for the supported Community workflow. Private operational receipts are not
distributed with this source tree.

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
