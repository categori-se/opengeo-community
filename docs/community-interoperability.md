# Exchange metadata, spatial data and Projects

OpenGeo Studio helps you inspect a source, keep its identity and terms, and move
supported information between tools. Choose the operation first: importing a
catalog record, reading features, displaying a map and preserving original bytes
are different actions. Registration does not copy remote data or grant access.

The tables below describe supported operations and their limits, with links to
implementations and tests. They do not claim formal standards conformance or
compatibility with every provider. See the
[capability matrix](community-capabilities.md) and
[release notes](../RELEASE_NOTES.md) for current release status.

## Import and export descriptive metadata

The [import adapters](../services/api/src/opengeo_api/metadata_adapters.py)
preserve the submitted source document, checksum, format/version and conversion
report separately from normalized metadata. The
[export adapters](../services/api/src/opengeo_api/metadata_profiles.py) report
mapped fields, defaults, preserved extensions and unmapped information. Import
checks the declared checksum; XML uses exact UTF-8 bytes and JSON uses canonical
JSON. Conversion preserves supported semantics; exported bytes can differ from
the original document.

| Format and pinned profile | Implemented documents and operations | Example and conversion limits |
| --- | --- | --- |
| DCAT 3, W3C Recommendation 2024-08-22 | Import supported JSON-LD `dcat:Dataset`, `dcat:DataService` or `dcat:Resource`; export mapped DCAT resource metadata. | [DCAT round-trip test](../services/api/tests/test_metadata_adapters.py) preserves source and supported semantics. Selected DCAT/DCT contexts and rectangular extents are admitted; arbitrary RDF graphs are not. |
| STAC 1.1.0 | Import and export Collection metadata for dataset resources. | [STAC Collection and partition tests](../services/api/tests/test_metadata_adapters.py) retain source and report extent unions/defaults. External Items and arbitrary asset execution are not implied. Exports can default missing world/open extents or license `other`, with explicit reports. |
| ISO 19115-3:2023 | Import bounded `mdb:MD_Metadata` XML in the `mdb/2.0` namespace; export a semantic XML representation. | [Exact XML import/export test](../services/api/tests/test_metadata_adapters.py) checks supported metadata and rejected older roots. Export reports unmapped content and contact/encoding defaults; schema and Schematron validation are explicitly false. |
| schema.org 30.0 | Import/export JSON-LD Dataset descriptions, including supported multilingual and distribution fields. | [schema.org Dataset test](../services/api/tests/test_metadata_adapters.py) exercises supported multilingual semantics. This is a Dataset adapter, not a general schema.org graph processor; unsupported content remains reported. |
| DataCite 4.7 | Import one JSON API `data` object of type `dois`, with a valid DOI and kernel-4 declaration; export DataCite JSON and XML. | [DataCite citation/extent test](../services/api/tests/test_metadata_adapters.py) and [extended export tests](../services/api/tests/test_metadata_profiles.py) cover mapped fields and required-field refusal. This does not register or mint a DOI; XML import is not advertised. |
| GeoDCAT-AP 3.1.0 | Import/export the supported JSON-LD DCAT profile with the declared `930` namespace. | [GeoDCAT round-trip/catalog tests](../services/api/tests/test_metadata_adapters.py) cover selected contact, provenance, quality and distribution semantics without a conformance claim. Controlled-vocabulary and other unmapped values remain explicit. |

All six families use the import/export implementations linked above. Resource
content, provenance, relationships or translations may lack a target mapping;
inspect the conversion report before sharing an export. A `not_applicable`
result is possible for the wrong resource kind. Unknown terms stay unknown:
dataset-level licenses do not automatically become distribution licenses.

## Discover a public CKAN dataset

The [CKAN adapter](../services/api/src/opengeo_api/ckan.py) uses public Action
API v3 `package_search`, `package_show` and selected `datastore_search` reads.
Search pages contain at most 20 summaries; DataStore previews return at most
20 rows and 64 fields. Responses have byte/time limits, and private or inactive
packages are refused. The [route implementation](../services/api/src/opengeo_api/ckan_routes.py)
checks local authority before inspection or registration.

For example, search a public portal for facilities, inspect one package, preview
one admitted DataStore resource, then deliberately register its metadata through
the DCAT mapping. The [client examples](../services/api/tests/test_ckan.py) and
[route examples](../services/api/tests/test_ckan_routes.py) cover this bounded path.
Original CKAN JSON is retained in the source record. Organizations/groups do not
create local Accounts/Collections; upstream publication flags and permissions do
not grant local access. Resource URLs remain references, not verified downloads
or map-ready Layers. Private CKAN authentication and write-back are unsupported.

## Read the workspace through catalog and feature APIs

| Surface | Useful operation | Boundary and representative check |
| --- | --- | --- |
| Project-scoped OGC API Records 1.0.0 surface | Discover authorized metadata records, query/paginate and select a language. | [Records implementation](../services/api/src/opengeo_api/ogc_records.py); [record/language/paging checks](../services/api/tests/test_ogc_records.py). Bounding rectangles describe metadata extent, not measured footprints. |
| Dataset-scoped OGC API Features 1.0.0 surface | Read a collection, advertised queryables, a feature page or one feature. | [Routes](../services/api/src/opengeo_api/ogc_feature_routes.py); [route examples](../services/api/tests/test_feature_routes.py). Authenticated, read-only GeoJSON/CRS84; pages have 1–100 features. `expected_generation` is an OpenGeo Studio extension that returns conflict if the collection changed. Editing uses separate version-checked operations. |
| Selected CQL2 text/JSON filters | Filter advertised scalar fields or admitted spatial geometry. | [Filter compiler](../services/api/src/opengeo_api/cql2_features.py); [equivalent text/JSON examples](../services/api/tests/test_cql2_features.py). Comparisons, Boolean logic, null checks, `LIKE`, `IN`, `BETWEEN` and selected topological predicates are bounded and parameter-bound; unknown fields/operators are refused. No arbitrary query execution. |
| Authenticated STAC discovery/search | Discover eligible Collections, request a versioned Item or search current metadata revisions. | [Routes](../services/api/src/opengeo_api/stac_routes.py), [Item builder](../services/api/src/opengeo_api/stac.py); [Item time/rights examples](../services/api/tests/test_metadata_profiles.py). STAC 1.1.0 Items require known time/interval metadata; absent time is not invented. Item geometry derived from a metadata rectangle is not a measured footprint. Search is bounded to 20 per page. |

For example, read a feature page with its reported generation, then include that
generation on the next read to detect intervening edits. Metadata discovery and
feature access each apply current authorization. Internal STAC discovery reads
the workspace's governed metadata; importing an external STAC Collection is the
separate metadata operation above. Neither route enables unrestricted remote
asset ingestion.

## Consume an external service or publish a spatial service

| Family | External consumption | OpenGeo Studio output and existing example |
| --- | --- | --- |
| WMS | Register credential-free HTTPS WMS 1.3.0/1.1.1 settings; display current-view PNG/JPEG in EPSG:3857. No upstream editing or complete archive. | [WMS parser](../services/api/src/opengeo_api/wms.py), [render routes](../services/api/src/opengeo_api/render_routes.py): selected GetCapabilities/GetMap, PNG or SVG, configured Styles and bounded layers. 1.3 uses CRS:84/EPSG:3857; 1.1.1 uses EPSG:4326/EPSG:3857. [Parser examples](../services/api/tests/test_wms.py) and [Project publication controls](../app/test/project-wms-publications.test.mjs). Explicit public WMS publication has separate input rights/release authority. |
| WFS | Register one public WFS 2.0 feature type for current-extent GeoJSON; at most 1,000 features per page. External locks, WFS-T writes and complete crawling are absent. | [WFS routes](../services/api/src/opengeo_api/wfs_routes.py): authenticated WFS 2.0 discovery, typed feature reads/stored queries and bounded single-operation transactions. CRS84/GML 3.2 or GeoJSON; selected 1.1.0 GeoMoose compatibility uses EPSG:4326/3857 and GML 2.1.2/GeoJSON. [OpenLayers request and versioned-transaction tests](../services/api/tests/test_wfs_routes.py). This does not confer upstream write authority. |
| WCS | No general external WCS client is advertised. | [Coverage routes](../services/api/src/opengeo_api/coverage_routes.py) implement authenticated WCS 2.0.1 GetCapabilities, DescribeCoverage and GetCoverage for sealed coverages. Exact GeoTIFF reads or bounded multipart metadata+raster; nontrivial subsets require an explicitly prepared derivative. Unprepared subsets return unavailable instead of queuing work. [Exact read/subset examples](../services/api/tests/test_coverage_routes.py). |
| WMTS | External GeoLibre WMTS definitions are preserved inertly; arbitrary capabilities, matrices and templates are not an executable registration adapter. | [Tile-cache routes](../services/api/src/opengeo_api/tile_cache_routes.py) implement authenticated WMTS 1.0.0 GetCapabilities/GetTile for explicit, versioned PNG caches in WebMercatorQuad. Reads do not generate missing tiles. [Seeded exact-cache tests](../services/api/tests/test_spatial_service_routes.py). |

External WMS/WFS operations are defined by the
[source catalog](../app/src/lib/sourceCapabilityCatalog.js),
[registration routes](../services/api/src/opengeo_api/external_source_routes.py)
and [registration examples](../services/api/tests/test_external_source_routes.py).
Preserving a configuration, explicitly capturing a reviewed view/page and
publishing a new service are separate operations. The table describes selected
profiles rather than complete service implementations. Publishing a spatial
service is
separate from [deploying an analytical website](community-publication-destinations.md).

## Keep originals and choose working/display formats

| Path | What is retained or produced | Source and representative existing example |
| --- | --- | --- |
| Managed vector files | Exact GeoJSON, zipped Shapefile, GeoPackage or GeoParquet originals; bounded working representations and previews. Only governed GeoJSON collections support durable feature editing. | [Inspector](../services/worker/src/opengeo_worker/inspector.py); [format/geometry checks](../services/worker/tests/test_inspector.py), [browser managed reads](../app/test/managed-vector-read.test.mjs). Normalization and preview limits do not establish a lossless conversion for every schema/geometry. |
| Managed COG | Exact versioned cloud-optimized GeoTIFF, bounded inspection/PNG preview, explicit subset/band/scale/reprojection derivatives. Pixel edits do not overwrite the original. | [Coverage derivatives](../services/worker/src/opengeo_worker/coverage_derivatives.py); [derivative checks](../services/worker/tests/test_coverage_derivatives.py), [browser COG reads](../app/test/cog-reference.test.mjs). Generic TIFF drivers and arbitrary rasters are not implied by the COG profile. |
| PMTiles | Browser archive reading and deliberate worker-generated map display derivatives, separate from working vectors and originals. | [Source profiles](../app/src/lib/sourceCapabilityCatalog.js), [derivative writer](../services/worker/src/opengeo_worker/pmtiles_derivatives.py); [PMTiles checks](../services/worker/tests/test_pmtiles_derivatives.py). Tile display can simplify/repair representation and is not an authoritative feature archive. Mapbox/Cesium cannot automatically replace MapLibre archive protocols. |

## Exchange a Project with GeoLibre

The [GeoLibre adapter](../app/src/lib/geolibreProject.js) imports project documents
0.1.0/0.2.0 and exports 0.2.0, with supported camera, Layer identity, visibility, opacity,
basic styles, source references and selected shared definitions. Its source pins
GeoLibre 2.6.0 for the baseline and 3.0.0 for renderer-aware definitions; these
identify the supported exchange definitions rather than current upstream parity.
The
[round-trip examples](../app/test/geolibre-project.test.mjs) and
[import-flow checks](../app/test/geolibre-import.test.mjs) show bounded conversion.

Imports are limited to 1 MiB and 200 Layers and perform no network fetch.
Safe unknown extensions and unsupported source/plugin/processing definitions
remain retained with conversion reports; inclusion does not execute them.
Review mapped fields, disclosed losses and preserved definitions before using an
imported Project. See [renderer compatibility](community-renderers.md) before
trying a different engine, and preserve source identity, custody and permissions
when adding an exchange operation.
