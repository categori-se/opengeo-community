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
| [GeoLibre](https://github.com/opengeos/GeoLibre) 2.6.0 baseline; 3.0.0 native portable acceptance | Browser GIS, portable projects, source inspection, analysis and layouts | All five original scoped comparisons pass. Exact 2.6.0 core exchange and accepted 3.0.0 native portable/hosted workflows retain their version boundaries; broader compatibility remains disclosed. |
| [GeoNode](https://github.com/GeoNode/geonode) 5.1.0 | Governed resources, catalog discovery, metadata, sharing, harvesting and publishing | All seven original scoped comparisons pass, including supported version/access/Style migration and native publishing. Broader migration and independent installation retain their disclosed limits. |
| [GeoServer](https://github.com/geoserver/geoserver) 3.0.1 | Stores, layer groups, styles, OGC services, service security and caching | Versioned service administration, governed stores/styles, private service controls and bounded cache management. Protocol operation/version coverage continues. |
| [MapServer](https://github.com/MapServer/MapServer) 8.6.5 | Cartography, raster/vector formats, reprojection, OGC publication and tile delivery | Representative render/format peers, bounded Mapfile cartography translation and controlled tile generations. Twelve bounded OGC application profiles pass programmatic evaluation. |
| [GeoMoose](https://github.com/geomoose/gm3) 3.15.2 | Configurable web portals, mapbooks, catalog layers, query, annotation and print | All six original scoped comparisons pass, including governed GML intake and explicit public/private native service handoff. Deployed identity, routing and browser CORS remain separate acceptance work. |
| [OpenLayers](https://github.com/openlayers/openlayers) 10.10.0 | Map/view/layer model, interactions, formats, projections and browser service clients | All five original scoped comparisons pass: accessible native controls, governed editing and source peers join retained map/layer, format and browser-platform evidence. Broader adapters and deployment remain separate. |
| [GeoLens](https://github.com/geolens-io/geolens) 1.20.0 | Connected catalog discovery, source custody, reusable maps and governed publication | All eight pinned scoped families pass, including reusable map composition/styling. Broader portrayal and observed upstream drift remain outside those accepted criteria. |
| Google Earth Pro 7.3.7.1327 | Discoverable Places/layer organization, globe navigation, KML/KMZ and annotated output | Seven original scoped comparisons pass; history/panoramas, tours/media and exact overlay interoperability remain incomplete. Its proprietary application remains a behavioral reference. |

## Relative parity by capability

The November 11 maintainer matrix records **45 Pass / 4 Partial across 49
planned comparisons**. These results apply to the declared version and workflow
profiles. They are not a product-completion percentage, full application parity,
standards certification or a statement that every accepted increment is deployed.
Some new implementations and acceptance records remain local pending reviewed
source publication and production rollout.

All five GeoLibre comparisons and the declared Print profile pass. Print's
[production closure](https://github.com/categori-se/opengeo-community/issues/14#issuecomment-6787394066)
includes versioned layouts, atlas PDF, story/dashboard content, Save/reopen and
attributed output. Broader publishing delivery [#15](https://github.com/categori-se/opengeo-community/issues/15)
and source acceptance [#10](https://github.com/categori-se/opengeo-community/issues/10)
remain open despite their accepted local comparator profiles.

The old conditional GeoServer extension decision selected no implementation and
is excluded from the planned count. Required core services and their failed
conformance fixtures remain in scope.

| Reference | Capability | Recorded status |
| --- | --- | --- |
| GeoLibre | Portable projects and views | Pass — pinned 2.6.0 core exchange, accepted 3.0.0 native portability and governed Save/reopen |
| GeoLibre | Source and layer inventory | Pass — finite inventory, including explicitly preserved source definitions |
| GeoLibre | GIS authoring and inspection | Pass — declared authoring, durable CAS/history and saved-state reopen |
| GeoLibre | Analysis and automation | Pass — count, bounds, bbox, centroids, vector-to-PMTiles and raster-to-COG scope |
| GeoLibre | Layout, story, dashboard and print | Pass — versioned mixed-content layouts and attributed PNG/PDF |
| GeoNode | Governed resource types | Pass — native kinds plus supported version/asset/identity/access migration |
| GeoNode | Catalog and discovery | Pass — bounded authorized/public search, previews and identity migration |
| GeoNode | Metadata management | Pass — curated profiles, revision preservation and supported 5.1.0 exchange |
| GeoNode | Sharing and community | Pass — governed activity and explicit source-to-member access conversion |
| GeoNode | Upload, create, edit, style, version and download | Pass — exact originals, native versions and bounded Style conversion/preservation |
| GeoNode | Federation and harvesting | Pass — anonymous 5.1.0 catalog metadata, manual activation |
| GeoNode | Publishing and administration | Pass — native editorial publishing/admin, same-host recovery and accepted GeoStory title/text migration |
| GeoServer | Catalog administration | Pass — versioned stores, layer groups, styles and render profiles |
| GeoServer | Data services | Partial — native WCS subsets pass; declared official conformance qualification unfinished |
| GeoServer | Service security and caching | Pass — private administered service and bounded generation controls |
| MapServer | Rendering and cartography | Pass — representative finite cartography peers |
| MapServer | Formats and reprojection | Pass — selected audited format/CRS operations |
| MapServer | OGC publication | Pass — twelve programmatically evaluated application profiles |
| MapServer | Configuration and automation | Pass — bounded Mapfile cartography translation |
| MapServer | Tile caching | Pass — private KVP WMTS, PNG/WebMercatorQuad, explicit seed/invalidation |
| GeoMoose | Configurable portal and mapbook | Pass — governed mapbook 3.0 adapter |
| GeoMoose | Catalog and layers | Pass — selected direct sources and governed bindings |
| GeoMoose | Identify, search and query | Pass — bounded geometry selection and result handoff |
| GeoMoose | Temporary work and annotation | Pass — local point, line and single-ring polygon editing |
| GeoMoose | Print and responsive delivery | Pass — declared responsive controls, outputs and conversion losses |
| GeoMoose | Distributed interoperability | Pass — governed inputs, explicit public/private native service handoff, withdrawal and CORS |
| OpenLayers | Map, view and layer model | Pass — pinned Chromium peer and finite layer set |
| OpenLayers | Controls and interactions | Pass — native accessible controls and retained governed edits |
| OpenLayers | Sources and protocols | Pass — declared 15-family native codec/service-client profile |
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
| Google Earth Pro | Virtual globe, terrain and 3D | Pass — declared native NVIDIA scene and emulated-mobile limits |
| Google Earth Pro | Places and KML/KMZ authoring | Pass — durable bounded Model/PhotoOverlay authoring and independent normalized KML/resource round trips |
| Google Earth Pro | Historical imagery, sunlight and panoramas | Partial — local acquisition, reviewed panorama and native exact-time terrain lighting pass; wider required evidence and release remain open |
| Google Earth Pro | GIS/GPS import and export | Pass — bounded formats, explicit address/style/height wizard and deterministic vector/raster regionation |
| Google Earth Pro | Measurement, elevation and viewshed | Pass — six editable families, saved profiles and bounded LOS/viewshed |
| Google Earth Pro | Tours, narration and movie output | Partial — native compound tours, narration, JSON exchange, replay, cancellation and personal Save/fresh pass; wider required evidence and release remain |
| Google Earth Pro | Print and save image | Pass — declared annotated outputs, scene framing and visual comparison |
| Google Earth Pro | Search, navigation, Places and Layers | Pass — scoped coordinate/Plus Code and governed place/address search, hierarchy, named views and native touch/controller navigation |
| Google Earth Pro | Network links, overlays, WMS and regionation | Partial — local resource/overlay generation implemented; exact Google Earth activates but native interoperability remains unfinished |
| Google Earth Pro | Flight simulator | Pass — versioned two-profile model, controls, HUD and authority bounds |


## Remaining comparison work

| Comparison | Next completion work |
| --- | --- |
| [GeoServer data services #25](https://github.com/categori-se/opengeo-community/issues/25) | Qualify the current native service image and security inventory; finish unchanged official WCS Core/WMS fixtures and the declared client/service acceptance. Local subsets and schema checks already pass. |
| [Historical imagery, sunlight and panoramas #5](https://github.com/categori-se/opengeo-community/issues/5) | Finish the recorded archive/provider, device and release requirements. Local acquisition, panorama and native exact-time terrain-lighting outcomes are accepted. |
| [Tours, narration and movie capture #16](https://github.com/categori-se/opengeo-community/issues/16) | Finish the recorded media/interoperability, device and release requirements. Local compound replay, narration, export, cancellation and personal Save/fresh reopen are accepted. |
| [Network links, overlays, WMS and regionation #32](https://github.com/categori-se/opengeo-community/issues/32) | Complete exact Google Earth desktop interoperability and the remaining recorded remote/raster, device and release requirements. Local generation and bounded native browser behavior do not establish that comparison. |

Keep the original criteria and required missing-evidence inventories intact.
Reuse accepted outcomes; run checks only for the remaining behavior and required
release gates. A closed comparison and a broader open delivery issue can coexist.

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

