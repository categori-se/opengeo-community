# OpenGeo Studio capabilities and limits

The community edition includes the full suite of OpenGeo Studio tools. This guide
owns the supported operations and their limits. Enabled services, credentials,
source rights and verification depend on the installation.

| Workflow | Available operation | Boundary |
| --- | --- | --- |
| Inspect sources | Catalog search, registration, metadata review and temporary inspection of one Layer. | Inspection does not create a Project, copy remote data or grant access. Source-specific operations are listed below. |
| Reuse maps | Persistent Layers, versioned Styles, saved Project compositions, device saves and editable backups. | Account and browser storage are separate. Download backups of important device work; browser storage can be cleared. |
| Edit and curate | Governed authoring with conflict/history and Style persistence; administrator-defined metadata profiles and revision-preserving GeoNode 5.1.0 exchange with a 40-field report and idempotent reimport. | Declared profiles do not establish full GeoNode migration or ISO/OGC certification. [Authoring #11](https://github.com/categori-se/opengeo-community/issues/11) and [metadata #20](https://github.com/categori-se/opengeo-community/issues/20) record their scope. |
| Retain evidence | Original versions, checksums, lineage and separate source, normalized, curated and inferred metadata. | A URL does not preserve remote bytes. Metadata and license declarations do not establish access or redistribution rights. |
| Analyze a question | Bounded browser/PostGIS operations, Baseline review tools and requested worker derivatives. | Limits, input versions and assumptions accompany results. A preview or inferred review is not a saved Layer or a validated finding. |
| Compose a page | Saved Print layouts, reusable templates, main/inset capture, text, tables, charts and declared output formats. | Raster source detail, unsupported content, fonts and representation limits remain explicit. |
| Explain and publish | Versioned source editing, native compiler components, private preview, Artifacts and reviewed release destinations. | Requires configured compilation/delivery and authority for the exact inputs. A build or private preview is not publication. |
| Collaborate | Account membership, resource roles, review authority and publication audiences. | Collections and geographic tags never grant access to their members. Identity/provider acceptance is installation-specific. |

Use the [workflow guide](community-workflow.md) and [examples](community-examples.md)
for a first task. [Deployment choices](community-deployments.md) distinguish the
Demo, local development, self-hosted installations and operated services.

## Source operations

Registration, reading, preview, editing and preservation are separate operations.
The maintained [source capability catalog](../app/src/lib/sourceCapabilityCatalog.js)
records their profiles. Remote access remains subject to source terms and availability.

| Source family | Registration, read and preview | Editing, derivatives and preservation |
| --- | --- | --- |
| GeoJSON, zipped Shapefile, GeoPackage and GeoParquet | Managed upload, authorized exact-version download and normalized vector preview of at most 5,000 features. Preview geometry is normalized to CRS84. | Durable feature editing is limited to governed GeoJSON. Declared GeoJSON, GeoParquet, PMTiles and SVG derivatives use explicit paths; arbitrary OGR drivers and remote Parquet queries are not implied. Exact original bytes and checksums are retained. |
| Local GPX 1.0/1.1 | Shared browser file opening for waypoints, routes and separate track segments; UTF-8, 256 KiB, 5,000 positions and 1,000 working features. Source fields, supplied elevation/time and original bytes/checksum are retained. | Original GPX/working GeoJSON downloads, browser Project files and device saves retain the imported work. Account-map additions remain temporary and excluded from account Save. Imported GPX URLs remain inert. No device transfer, managed conversion or edited GPX writer. |
| Cloud-optimized GeoTIFF (COG) | Managed COG upload, isolated inspection, bounded PNG thumbnail, authorized exact download and bounded range-aware reads. | Explicit subset, band, scale and reprojection derivatives create new immutable outputs. Pixel editing and generic raster-driver support are unavailable. Exact original bytes and checksums are retained. |
| Delimited text | Managed nonspatial CSV table upload/preview/Parquet remains available. A local CSV/TSV/TXT wizard explicitly maps columns, EPSG:4326/3857 and optional elevation/labels; 256 KiB, 5,000 records and 30,000 values. | Exact original bytes, source strings and omission reports survive. Account-map points remain temporary (1,000 points), excluded from account Save. No geocoding, arbitrary CRS, WKT-field interpretation or automatic managed spatial conversion. |
| NMEA observations | Local RMC/GGA Points with explicit WGS 84/rejection review; 256 KiB, 2,000 records and 1,000 Points. | Original and working exports and device saves preserve the input. No device/stream/track reconstruction. |
| PNG/JPEG media | Managed nonspatial image upload up to 16 MiB and 40 million pixels, exact download and normalized preview. | A metadata-stripped PNG derivative can support publication. No EXIF point generation or feature editing. Exact original bytes and checksum are retained. |
| Public HTTPS XYZ tiles | Syntax-checked tile template and zoom limits; current-view browser tile reads/preview. | Versioned credential-free configuration is retained. No complete tile archive, upstream editing or availability guarantee. |
| Public WMS 1.3.0/1.1.1 | Declared layers/styles and EPSG:3857 PNG/JPEG GetMap preview for the current extent. | Versioned configuration and a separately requested protected PNG capture; no complete archive, upstream editing, private upstream credentials or arbitrary CRS/dimensions. |
| Public ArcGIS ImageServer / MapServer | Credential-free display references; Web Mercator image tiles at 256 or 512 pixels. ImageServer supports provider default or one/three explicit bands; MapServer uses explicit layer IDs. | Configuration is versioned; registration does not archive pixels. No private credentials, arbitrary raster/render rules or original-file mirroring. Syntax validation is not a health check. |
| WFS 2.0 | Declared endpoint/schema; one current-extent GeoJSON page of at most 1,000 features. Reads are capped at four concurrent requests, 20 seconds and 8 MiB per request. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete collection, WFS-T, joins, locks or broad filter/CRS support. |
| ArcGIS REST features | Declared layer/fields/geometry; one current-extent GeoJSON page of at most 2,000 features, with the same request bounds as WFS. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete service snapshot, private authentication, upstream edits, attachments or relationship/domain conversion. |
| PMTiles | Public HTTPS archive reference or managed immutable archive, declared raster/vector rendering and browser range reads. | Explicit vector-to-PMTiles jobs create derivatives. No feature editing inside archives. Exact copies require the preservation action; registering a URL alone does not create a copy. |
| STAC 1.1 Collection | **Metadata import only:** one bounded Collection document, including identity, extents, license, keywords, providers and links. | Exact source representation/checksum and metadata provenance are retained. No Item search, asset reads, streaming, rendering or automatic raster/vector Layer creation. |
| External STAC Item search | Separate Catalog control for explicit anonymous HTTPS GET searches, bounded manual paging, original Item/query/response evidence and selected analytical TIFF registration. | Reuses referenced COG inspection and deliberate Project composition. Asset rights/access stay unverified; unsupported assets remain references. This does not extend Collection metadata import or assert general STAC conformance. |
| External PostgreSQL/PostGIS | Opt-in owner-scoped TLS profiles, read-only verification, relation discovery, live Layer registration and bounded feature preview. Credentials are write-only/encrypted. | Defaults off. Initial profile: ordinary table, at most 64 columns, one supported 2D EPSG:4326 geometry, stable unique key and supported primitive attributes. Preview discloses truncation and preserves bigint/decimal text. No arbitrary SQL, upstream editing or managed feature copy. Configured-provider/cloud transport acceptance remains separate. |

External PostGIS checks use local substitutes for identity, secrets and external
DNS/TLS/cloud transport. They do not verify an independently configured connection.

### Definitions without an executable Catalog adapter

GeoLibre conversion can preserve the following definitions for future handoff.
Preservation does not load a source or retain its remote bytes.

| Retained definition | Unavailable operations |
| --- | --- |
| CAD, FileGDB, MBTiles and OSM PBF | Opening/converting their geometry, databases or tile archives; associated domains, relationships and styling. MBTiles is not treated as PMTiles. |
| Upstream WMTS, OGC API Features, OGC API Tiles and GeoRSS | External discovery, protocol negotiation, paging, feeds, rendering and edits. OpenGeo Studio service-publication implementations do not supply these external-source clients. |
| FlatGeobuf, Zarr and NetCDF/HDF | Managed ingest/range streaming, array chunks, dimensions, codecs, calendars and multidimensional rendering. Independent format-peer evidence does not make an ingest adapter available. |
| LiDAR/COPC, Gaussian splats, 3D Tiles and glTF | Point/model loading, hierarchy traversal, streaming, rendering and analysis. |
| Video and deck.gl visualization | Frame loading/transcoding, playback, imported JavaScript, shaders and visualization execution. |
| DuckDB project query definitions | Imported SQL, extensions, attached databases/files, secrets and query execution. This is distinct from the separately implemented browser SQL workspace. |

## Processing

The [browser processing registry](../app/src/lib/processingRegistry.js) includes
feature counts, bounds, bounding-box Layers, vertex-mean centers, planar centroids
and view filters. Its limits are 50,000 features, 1,000,000 coordinates and 16 model
steps, in CRS84 with networking disabled. A view filter is not a durable dataset.

The [PostGIS analysis implementation](../services/api/src/opengeo_api/vector_analysis.py)
provides bounded buffer, centroid, clip, dissolve, spatial join, location selection,
measurement and intersection previews. Inputs are generation-pinned and
read-authorized. A preview is not a saved Layer; reviewed registration is separate.

Vector-to-PMTiles and raster-to-COG jobs require deliberate activation and a
configured worker. Merely inspecting a source or importing a processing model
does not execute a job. An assistant operation plan does not execute processing.



The [Baseline guide](community-baseline.md) covers source suitability,
categorical inventory/comparison/patches, stratified reference review with
conditional class-area uncertainty, mapped-field/confidence review, declared
surface-minus-terrain comparison, building agreement and footprint/receptor
screening. Its declared JRC TMF 2025 interpretation has a specific legend and
scope. These tools do not establish complete source coverage or ecological,
crop or change findings.

## Print and output

| Profile | Supported scope and limits |
| --- | --- |
| Layouts/templates | Named paper/furniture/frame settings, main/inset maps and source-bound tables/charts. Templates transfer source-free design; destination data slots require explicit visible Layer/field bindings. Cameras, source pins, attributes and captures do not travel in templates. Reopening requires fresh capture. |
| Map capture | Loaded MapLibre scene at 96/150/300 DPI within its physical frame, preserving aspect ratio and source/Style pins. DPI/dimension changes require recapture. Raster imagery and tile geometry retain their source detail. 3D/globe/terrain views use raster output and omit measured scale, compass and grid. |
| Raster output | Paper SVG with raster map captures, PNG, self-contained HTML, browser Print and a figure/print ZIP. A raster PDF does not supply vector map geometry or selectable map text. The browser controls PDF completion. |
| Loaded-vector output | Vector SVG/browser Print, direct vector PDF and separate main/inset geographic registration for supported flat Earth Mercator captures. Complete loaded GeoJSON with admitted fill/line/circle passes is required. Unsupported visible content keeps its raster route. Mixed imagery, labels and complex Styles have separate limits. |
| Text/equations | Up to eight positioned multiline text blocks, 6–48 pt, literal wrapping, opaque hex colors or transparent background and left/center/right alignment. Packaged Open Sans faces and bounded local MathJax support their declared glyph/expression profiles. Custom families, complex shaping, rich text and bidirectional layout remain limited. |
| Tables/charts | Selected loaded-source fields/rows, source-version pins, scope and missing-data notices. Settings save with layouts; row snapshots require capture. Live/view-bound, tiled/raster and incomplete sources are outside this loaded-source path. |
| Legends | Supported graduated Polygon/Line classes and linear continuous scales with separate missing/nonnumeric values. Continuous scales: 2–22 opaque stops within ±10¹⁵. Continuous Point paint and other interpolations remain unsupported. Explicit one-band COG ranges support grayscale bars; RGB/automatic ranges/transformed paints disclose unavailable bars. |
| QGIS exchange | Source-free `.qpt` page/map, label, linked legend/scale and editable unbound attribute-table items. Import requires review and rebinding. Chart slots and equations use JSON. Full native layouts, linked north rotation and typography remain limited; importing XML does not start QGIS. |

Direct vector PDF embeds packaged Open Sans and its license/NOTICE attachments;
the declared Latin/Greek/Cyrillic/symbol coverage does not include every script.
Review unsupported glyphs and select an appropriate output route.
[Print Studio](print-studio.md) describes output/conversion profiles. Governed
document and layout additions require matching API, worker and schema versions;
including source does not enable them on an older installation.

## Renderer profiles

MapLibre GL JS **6.4.1** is the default. Mapbox GL JS **3.30.0** requires a
session public token and provider terms; CesiumJS **1.145.0** admits its declared
loaded-vector globe profile. OpenLayers **10.10.0** supplies utilities and
reference checks in this source revision. See [renderer roles](community-renderers.md)
for actual controls and per-engine refusals; a globe projection is not a renderer switch.

## GeoLibre project handoffs

The maintained [project adapter](../app/src/lib/geolibreProject.js) accepts
GeoLibre project JSON versions **0.1.0 and 0.2.0**, and exports **0.2.0**. Import is
offline, capped at **1 MiB and 200 Layers**, and does not fetch sources or load
plugins. The portable parser/serializer comparison is pinned to GeoLibre **2.6.0**;
selected renderer fields use a separate **3.0.0** reference. Neither establishes
compatibility with every current GeoLibre release or feature.

- **Mapped:** primary/secondary cameras, Layer identities and presentation,
  supported basic styles/labels, metadata and selected Project state. Eligible
  XYZ/WMS/PMTiles references become governed registration candidates; embedded
  GeoJSON becomes a managed-ingest candidate. Parsing alone commits neither.
- **Preserved:** advanced styles, safe unknown fields, plugins, story/layout/widget
  configuration and unsupported processing content remain in the compatibility
  envelope. Preservation does not establish an editor, player, renderer or
  executable adapter. Some source URLs map to typed records without being read.
- **Reported or removed:** credentials are removed and affected sources remain
  inactive. The field-level conversion report distinguishes mapped, preserved,
  defaulted, unsupported and rejected-sensitive fields. An unmappable export may
  use a hidden empty placeholder while retaining the OpenGeo Studio Layer record
  in metadata, with the loss recorded.

Review the conversion report before relying on a handoff. Source preservation,
semantic preservation and equivalent rendering are separate claims. The
[reference comparison](reference-applications.md) describes version-specific verification profiles.


GeoMoose **3.15.2** layout conversion and GeoNode **5.1** discovery/migration
cover their declared profiles. GeoStory title/text import does not convert every
map, media or interactive section. [Reference comparisons](reference-applications.md)
do not establish whole-product parity or current-upstream API compatibility.

## Accessibility and installation status

Whole-application accessibility, Section 508/WCAG conformance and PDF/UA
conformance are not established. Supported generated documents can retain authored
text and selected semantic structures, but tags, captions and legend labels do
not automatically explain every spatial relationship. Review outputs with their
intended readers and assistive technology. Browser/device profiles and the
actual configured interface require their own assessment.

Selected local connected checks cover Project save/reopen after database restart,
GIS processing, permissions, native Framework compilation, private preview and
reviewed publication. Synthetic identity and local transports do not establish
real sign-in or an independent provider connection. Complete independent
installation, general Notebook execution and configured identity/HTTPS/CDN
delivery remain separate acceptance work. [COMMUNITY-RELEASE.json](../COMMUNITY-RELEASE.json)
records the source offering's scoped verification.

The Demo, operated Studio and self-hosted installations use the same core with
separate data, accounts, configuration and operating policies. Receiving source
does not transfer the main instance, hosted datasets, credentials, domains or
provider agreements. Self-hosting does not require buying OpenGeo services;
infrastructure and optional providers retain their own costs and terms.
Assign operator responsibilities and verify the actual installation using the
[handover guide](community-deployments.md#accept-and-hand-over-an-independent-installation),
[local development guide](community-development.md) and [AWS guide](community-aws.md).
See [support](../SUPPORT.md) and [contribution guidance](../CONTRIBUTING.md).
