# OpenGeo Studio capabilities

Connect sources, compose reusable maps, run spatial analysis and author
Publications. The community edition includes the full suite of OpenGeo Studio
tools. This guide describes supported operations, demonstrated workflows and
their boundaries.

Local checks cover uploaded data, map styling and save/reopen across database
restart, access rules, selected GIS processing and static publication. Fresh
installation, independent AWS deployment and the
complete native Notebook/Framework publishing workflow still need verification.
See the [development guide](community-development.md), [AWS guide](community-aws.md)
and [deployment examples](community-deployments.md).

## How to read the status

- **Implemented** means maintained source contains the described behavior and its
  limits. It does not mean every supported input or deployment has been exercised.
- **Demonstrated in connected checks** means the named journey used connected
  application components and retained results. The release checks below used
  cached dependencies/images, local transports and synthetic identities.
- **Planned or awaiting acceptance** identifies unfinished behavior or an
  implemented path whose complete community-release journey has not passed.

Comparisons with other GIS applications cover the named versions and operations.
They do not establish compatibility with every upstream feature.

## Workflows and practical value

| Workflow and benefit | Implemented scope | Connected community-release evidence and remaining work |
| --- | --- | --- |
| Inspect a source before using it | Catalog search, governed registration, source metadata and temporary Layer inspection; persistent Project assignment is a separate action. | Focused Catalog preview/navigation checks pass. The local pilot processes real uploaded features. Provider availability, credentials and each external adapter need their own acceptance; the table below states the current source boundary. |
| Reuse data and cartography across maps | Independently identified Layers, reusable versioned Styles and saved Project compositions. A Layer can be referenced by more than one Project. | The [built Studio check](community-development.md#browser-save-and-reopen-check) uploads five fixture features, changes point color and opacity, and saves through the UI. Revision 2, exact layer/source identities, all feature values and presentation survive a restart of the same database. Dependencies/images are cached and sign-in/object/queue transports are synthetic; broader compositions and portable round trips remain to be checked. |
| Know which input supported a finding | Immutable object versions, checksums, lineage and explicit referenced, hosted, cached, mirrored and derived custody. | The pilot connects uploads, worker outputs and a reopened map. Preserving a URL or source definition alone does not preserve the remote bytes, and a bounded capture does not establish source completeness. |
| Keep producer facts separate from interpretation | Separate source, normalized, curated and inferred metadata, with rights, license, provenance and selected import/export mappings. | The [STAC-to-CKAN exporter](api/stac-ckan.md) produces a deterministic `package_create` dry-run payload with stable identity, retained source and explicit import/export reports. Local structural and regression checks and a [disposable CKAN 2.11.6 create/readback/purge round trip](api/stac-ckan.md#disposable-server-check) for one synthetic fixture pass; harvesting, ordinary-user permissions, synchronization and production deployment remain unverified. Metadata does not grant access or establish redistribution rights. |
| Explore a bounded analytical question | Browser vector operations, PostGIS vector-analysis previews, and explicit worker jobs for selected spatial derivatives. Parameters, source identities and limits accompany results. | Real worker PMTiles and PNG outputs pass in the pilot. This does not demonstrate every algorithm, large input or remote runtime. Native publication compilation remains outside that pilot. |
| Explain results with maps, tables, charts and methods | Publication source editing, Notebook/Framework compiler components, previews, versioned artifacts and publishing interfaces. | The pilot packages a two-page Publication ZIP and checks anonymous delivery/revocation. Complete native Notebook/Framework compilation, built-browser publication and standalone delivery acceptance remain open. |
| Share work under explicit access rules | Memberships, resource roles, activity records, publication audiences and selected interoperability adapters. | The [PostGIS authorization checks](api/authorization-local.md) verify viewer edit/publication denials, editor edits, stale-version conflicts and revoked reads; denied/stale writes leave site, editions, render state and queue unchanged. Anonymous delivery/revocation also passes in the local pilot. Synthetic identities and transports leave real sign-in, production tenant administration and independent AWS operation unverified. |

For a screening study, record the input version, whether it was preserved, the
processing assumptions and what a reader can inspect. The
[examples guide](community-examples.md) shows how to explain those choices.

For client development, the [API contract](api/README.md) exports offline and
checks deterministic output, schemas and eight model-validated examples. Focused
route tests cover source registration, map revisions and publication preparation
and review with mocked repositories; connected journeys are recorded separately.

## Source operations: what is actually available

This table summarizes the maintained
[source capability catalog](../app/src/lib/sourceCapabilityCatalog.js).
**Registration**, **reading**, **preview**, **editing**, and **preservation** are
different operations. A stored definition can remain inactive; metadata import
can succeed without creating a renderable Layer. Every executable path below is
bounded and remains subject to access, configuration and source terms.

| Source family | Registration, read and preview | Editing, derivatives and preservation |
| --- | --- | --- |
| GeoJSON, zipped Shapefile, GeoPackage and GeoParquet | Managed upload, authorized exact-version download and normalized vector preview of at most 5,000 features. Preview geometry is normalized to CRS84. | Durable feature editing is limited to governed GeoJSON. Declared GeoJSON, GeoParquet, PMTiles and SVG derivatives use explicit paths; arbitrary OGR drivers and remote Parquet queries are not implied. Exact original bytes and checksums are retained. |
| Cloud-optimized GeoTIFF (COG) | Managed COG upload, isolated inspection, bounded PNG thumbnail, authorized exact download and bounded range-aware reads. | Explicit subset, band, scale and reprojection derivatives create new immutable outputs. Pixel editing and generic raster-driver support are unavailable. Exact original bytes and checksums are retained. |
| CSV | Managed nonspatial table upload, exact download, schema/thumbnail preview and a bounded Parquet working artifact. | No inferred geometry, geocoding, streaming or in-place editing. Coordinate columns and WKT-like text remain ordinary fields. Exact original bytes and checksum are retained. |
| PNG/JPEG media | Managed nonspatial image upload up to 16 MiB and 40 million pixels, exact download and normalized preview. | A metadata-stripped PNG derivative can support publication. No EXIF point generation or feature editing. Exact original bytes and checksum are retained. |
| Public HTTPS XYZ tiles | Syntax-checked tile template and zoom limits; current-view browser tile reads/preview. | Versioned credential-free configuration is retained. No complete tile archive, upstream editing or availability guarantee. |
| Public WMS 1.3.0/1.1.1 | Declared layers/styles and EPSG:3857 PNG/JPEG GetMap preview for the current extent. | Versioned configuration and a separately requested protected PNG capture; no complete archive, upstream editing, private upstream credentials or arbitrary CRS/dimensions. |
| Public ArcGIS ImageServer / MapServer | Credential-free display references; Web Mercator image tiles at 256 or 512 pixels. ImageServer supports provider default or one/three explicit bands; MapServer uses explicit layer IDs. | Configuration is versioned; registration does not archive pixels. No private credentials, arbitrary raster/render rules or original-file mirroring. Syntax validation is not a health check. |
| WFS 2.0 | Declared endpoint/schema; one current-extent GeoJSON page of at most 1,000 features. Reads are capped at four concurrent requests, 20 seconds and 8 MiB per request. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete collection, WFS-T, joins, locks or broad filter/CRS support. |
| ArcGIS REST features | Declared layer/fields/geometry; one current-extent GeoJSON page of at most 2,000 features, with the same request bounds as WFS. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete service snapshot, private authentication, upstream edits, attachments or relationship/domain conversion. |
| PMTiles | Public HTTPS archive reference or managed immutable archive, declared raster/vector rendering and browser range reads. | Explicit vector-to-PMTiles jobs create derivatives. No feature editing inside archives. Exact copies require the preservation action; registering a URL alone does not create a copy. |
| STAC 1.1 Collection | **Metadata import:** one bounded Collection document, including identity, extents, license, keywords, providers and links. [CKAN export](api/stac-ckan.md) prepares a `package_create` dry-run payload for the supported subset. | Source JSON values, checksums, metadata provenance and conversion reports are retained. No Item search, asset reads, streaming, rendering, automatic raster/vector Layer creation or live CKAN synchronization. |
| External PostgreSQL/PostGIS | **Connection only:** owner-scoped TLS profile and one fixed read-only capability-verification query. Credentials are write-only and encrypted. | Non-secret target metadata and verification receipts are retained. No table discovery, arbitrary SQL, Layer preview/streaming or upstream editing. The application's own PostGIS analysis is a separate path. |

The remaining source families retain **inert definitions during GeoLibre project
conversion**. They have no executable source adapter in this catalog:

| Retained definition | Unavailable operations |
| --- | --- |
| CAD, FileGDB, GPX, MBTiles and OSM PBF | Opening/converting their geometry, tracks, databases or tile archives; associated domains, relationships, timestamps and styling. MBTiles is not treated as PMTiles. |
| Upstream WMTS, OGC API Features, OGC API Tiles and GeoRSS | External discovery, protocol negotiation, paging, feeds, rendering and edits. OpenGeo Studio service-publication implementations do not supply these external-source clients. |
| FlatGeobuf, Zarr and NetCDF/HDF | Managed ingest/range streaming, array chunks, dimensions, codecs, calendars and multidimensional rendering. Independent format-peer evidence does not make an ingest adapter available. |
| LiDAR/COPC, Gaussian splats, 3D Tiles and glTF | Point/model loading, hierarchy traversal, streaming, rendering and analysis. |
| Video and deck.gl visualization | Frame loading/transcoding, playback, imported JavaScript, shaders and visualization execution. |
| DuckDB project query definitions | Imported SQL, extensions, attached databases/files, secrets and query execution. This is distinct from the separately implemented browser SQL workspace. |

Retaining a definition preserves safe project configuration for future handoffs.
It does not preserve the referenced dataset's bytes or make that dataset usable.
Expanding these adapters follows named user workflows in the roadmap.

## Processing boundaries

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
[reference comparison](reference-applications.md) records the remaining portable
Project, authoring and layout work.
