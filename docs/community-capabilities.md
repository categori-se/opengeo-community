# Capabilities and release maturity

The community edition includes the full suite of OpenGeo Studio tools. This
guide describes the supported operations, their limits and what has been tested.

The [Baseline guide](community-baseline.md) describes locally implemented source
suitability, cached raster inventory/comparison/reference agreement/patches,
stratified whole-cell reference review with conditional class-area uncertainty,
explicitly declared JRC TMF forest-history interpretation, mapped fields, building
review/agreement and footprint/receptor screening. Analysis runs on
deliberate use and adds no idle service. Compiled export/map/device reopening and
selected earlier local account/native-publication evidence are scoped separately;
these tools do not establish complete source coverage, validated findings or
configured production delivery.

Local checks cover saved Projects, database restart, selected GIS processing and
static publication. Local Studio checks also cover Framework compilation, private
preview and reviewed publishing of the Berkshire study, including anonymous map
and table rendering. General Notebook execution,
clean independent installation, configured production identity and HTTPS/CDN
delivery remain open.
See the [development guide](community-development.md), [AWS guide](community-aws.md)
and [deployment examples](community-deployments.md).

Print Studio's local checks now also cover reusable graduated Polygon/Line legends:
resolved thresholds/colors match captured map pixels, and missing-value conversion
is described explicitly. Unsupported encodings disclose the unavailable legend.
Canonical Project/Layer/Style references remain intact. This scoped local result
does not establish broader source/chart coverage or complete print parity. Locally checked classed bars now retain exact numeric intervals, saved display preference and visible recorded license status; Point glyphs remain swatches and unsupported encodings are disclosed.

For continuous scales, choose an **OpenGeo palettes** item in Styles, set
**Palette scale → Continuous**, choose the numeric field and increasing color
stop values, then save and apply its exact Style version. In Print Studio select
**Classed and continuous color bars**. The linear fill/line scale retains unequal
numeric positions, endpoint colors and a separate missing/nonnumeric swatch.
Stop validation is visible before saving; Print rejects labels that need more
column width. Scale colors precede map opacity/background blending, as stated
beside the bar. Compiled local palette authoring, MapLibre/SVG interior colors and
main/inset fixture save/reopen/output pass. Prior actual layout API/SQL proof is
reused; new connected Style persistence and hosted delivery are not claimed.
The path supports 2–22 opaque-color stops within ±10¹⁵. Other interpolations,
continuous Point paint and full Print parity remain open.

**Reusable Print templates** save named paper/furniture/frame settings with the
Project's existing layouts. Download/import source-free template JSON to reuse a
design in another Project. New layouts bind that Project's current map inputs;
table/chart slots require explicit visible Layer choices with the required loaded
fields. Cameras, source pins, Style references, attributes and captures do not
travel in a template. **Page output** shows physical/pixel dimensions and captured
detail, with an explicit format choice and processing phases. Changing DPI requires
fresh map capture, and browser printing reports a dialog request.
The local implementation adds no provider requests, account-wide template service
or background runtime. Source and hosted delivery remain separate.

**Add equation** now preserves bounded LaTeX source through saved Print layouts
and source-free JSON templates. Real local MathJax lays out fractions, roots,
sums and AMS matrices as physical vector outlines in preview/SVG/PDF. Compiled
fixture save/reopen and native PDF inspection pass, including exact matrix source
and software/font terms. Native QPT equation export directs users to JSON;
broader math/fonts/accessibility remain open. The typesetter loads only on use;
no service is added. New dependency advisory review still requires approval, and
this local source is outside the frozen public candidate.

**Add text block** is locally implemented for up to eight positioned multiline
blocks with 6–48 pt regular text, opaque hex text/background colors or a transparent
background, and left/center/right alignment. Measured wrapping uses a 1 mm inset;
overflow requires more space or smaller text and cannot silently truncate output.
Literal spaces and line breaks survive saved layouts, source-free JSON templates
and native QPT label exchange. SVG/browser output uses system fonts; direct PDF
rewraps in its exact packaged Open Sans. Source/license footers remain independent.
Compiled fixture save/reopen, SVG/PDF and native QGIS label exchange pass locally.
Rich text, broader LaTeX, custom
fonts and bidirectional text support remain open.

MapLibre capture now rerenders the loaded scene to fit physical frame dimensions
and 96/150/300 DPI, preserving geography, aspect ratio, source/Style pins and the
original display buffer. DPI/physical resizing requires recapture. The compiled
local-vector scene verifies fresh detail beyond screenshot upscaling; raster imagery
and existing tile geometry retain their source detail. Map labels now use white
halos, explicit scale endpoints and collision-aware grid placement. Dense grids
retain literal SVG values and disclose omitted labels. The retained dark-map scene
and light annotation probe pass without recapturing data. Device/provider breadth,
broader cartography and general vector PDF/GeoPDF coverage remain open.

For explicitly ranged one-band COGs, Print's **Classed and continuous color bars**
now uses the actual loaded grayscale mapping. Band/range endpoints, source NoData,
transparent values, opacity and cached-preview limits stay visible. Saved frame
settings and SVG/figure context preserve the range without service URLs. Capture
and export make no additional raster reads in the accepted local scene. RGB,
automatic ranges and transformed paints disclose unavailable bars; broader raster
analysis, NDVI/NBR/series and print typography remain unfinished.

**Vector map SVG** and **Vector Print / Save PDF** use complete loaded GeoJSON
with supported installed fill/line/circle passes. They preserve polygon holes,
source/Style pins, filters, pass order, clipping and distinct feature/composite
opacity. Captured map detail reports readiness or actionable refusal. Unsupported
visible content keeps its raster-output route; it is never silently omitted from
a claimed vector map. The existing browser controls PDF completion. Source/license
notes remain visible, and the figure ZIP still identifies its PDF as raster.
**Vector PDF** and **Geospatial PDF** now download this vector page with exact
embedded Open Sans and its license/NOTICE attachments. Geographic output registers
each captured main/inset Mercator map separately; native GDAL readback passes for
the selected scene. Covered Latin/Greek/Cyrillic/symbol text is searchable; other
fonts/text use browser Print. Two pinned browser converter packages add maintained
notices, with no running service. Mixed imagery/labels/complex styles and full
cartographic parity remain open. These bounded loaded-vector outputs do not
establish complete cartographic coverage.

QGIS `.qpt` exchange now has a reviewed source-free profile with native page/map,
label, linked legend/scale and editable unbound attribute-table items. Import
requires review and explicit destination bindings; native geometry/text/columns
win over supplemental settings. Chart slots keep the JSON route. Full native
layouts, linked north rotation and typography remain unfinished. This source-free
profile covers the item types listed here. No QGIS runtime is bundled into Studio
or started by importing XML.
Native scales now fit readable paper widths, and legends use free space without
moving maps/tables. One compiled/native scene verifies separated labels and the
complete legend below the inset. Insufficient space produces actionable guidance;
review destination legend capacity and scale labels after binding native content.

In Print Studio, choose **Add source table** or **Add source chart**, then select
the Layer, fields and row limit. Use **Arrange item** and the frame controls to
position the result; capture the linked map after changing selections. These
source-bound tables and per-record bar/line charts retain exact selected values, source/version pins, explicit loaded-data scope and source/license notes.
Configuration saves with layouts; row snapshots require deliberate capture after
reopen. Physical editing and a compiled A3 save/reopen/output fixture pass locally.
Live/view-bound, tiled/raster and incomplete data are unavailable through this
loaded-source path; it adds no provider requests or background processing. Demo
staging includes the helper; fresh Demo compilation and source delivery are pending.

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
| Reuse data and cartography across maps | Independently identified Layers, reusable versioned Styles and saved Project compositions. A Layer can be referenced by more than one Project. | A source-built Studio created a Project/map and reopened the exact saved map after database restart. This is bounded local persistence evidence; broader composition, styling and portable round trips continue. |
| Know which input supported a finding | Immutable object versions, checksums, lineage and explicit referenced, hosted, cached, mirrored and derived custody. | The pilot connects uploads, worker outputs and a reopened map. Preserving a URL or source definition alone does not preserve the remote bytes, and a bounded capture does not establish source completeness. |
| Keep producer facts separate from interpretation | Separate source, normalized, curated and inferred metadata, with rights, license, provenance and selected import/export mappings. | Metadata export is included in the local pilot. Adapter and standards coverage is specific; metadata does not grant access or establish redistribution rights. |
| Explore a bounded analytical question | Browser vector operations, PostGIS vector-analysis previews, and explicit worker jobs for selected spatial derivatives. Parameters, source identities and limits accompany results. | Real worker PMTiles and PNG outputs pass in the pilot. This does not demonstrate every algorithm, large input or remote runtime. Local native publication checks are described below. |
| Explain results with maps, tables, charts and methods | Publication source editing, Notebook/Framework compiler components, previews, versioned artifacts and publishing interfaces. | The static pilot packages a two-page Publication ZIP and checks anonymous delivery/revocation. Local Studio checks also compile the Berkshire study with Framework, preview it privately, approve its release and render its map and tables anonymously. General Notebook execution, clean independent installation and configured production identity/HTTPS/CDN delivery remain open. |
| Share work under explicit access rules | Memberships, resource roles, activity records, publication audiences and selected interoperability adapters. | Anonymous access, reviewer permissions, conflicts and revocation pass in the local pilot. Synthetic identities do not establish real sign-in, production tenant administration or independent AWS operation. |

For a screening study, record the input version, whether it was preserved, the
processing assumptions and what a reader can inspect. The
[examples guide](community-examples.md) shows how to explain those choices.

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
| Local GPX 1.0/1.1 | Shared browser file opening for waypoints, routes and separate track segments; UTF-8, 256 KiB, 5,000 positions and 1,000 working features. Source fields, supplied elevation/time and original bytes/checksum are retained. | Original GPX and working GeoJSON downloads, browser Project files and personal saves pass compiled save/reopen checks and are delivered on configured Studio/Demo. Independent community deployment acceptance remains separate. Account-map additions remain temporary and excluded from account Save. Imported GPX URLs remain inert. No device transfer, managed conversion or edited GPX writer. |
| Cloud-optimized GeoTIFF (COG) | Managed COG upload, isolated inspection, bounded PNG thumbnail, authorized exact download and bounded range-aware reads. | Explicit subset, band, scale and reprojection derivatives create new immutable outputs. Pixel editing and generic raster-driver support are unavailable. Exact original bytes and checksums are retained. |
| Delimited text | Managed nonspatial CSV table upload/preview/Parquet remains available. A local CSV/TSV/TXT wizard explicitly maps columns, EPSG:4326/3857 and optional elevation/labels; 256 KiB, 5,000 records and 30,000 values. | The local compiled map/export/personal save/fresh reopen checks and configured Studio/Demo delivery pass. Exact original bytes, source strings and omission reports survive. Account-map points remain temporary (1,000 points), excluded from account Save. No geocoding, arbitrary CRS, WKT-field interpretation or automatic managed spatial conversion. |
| NMEA observations | Local RMC/GGA Points with explicit WGS 84/rejection review; 256 KiB, 2,000 records and 1,000 Points. | Exact original and working exports plus personal Project save/reopen pass compiled checks and configured Studio/Demo delivery. No device/stream/track reconstruction. |
| PNG/JPEG media | Managed nonspatial image upload up to 16 MiB and 40 million pixels, exact download and normalized preview. | A metadata-stripped PNG derivative can support publication. No EXIF point generation or feature editing. Exact original bytes and checksum are retained. |
| Public HTTPS XYZ tiles | Syntax-checked tile template and zoom limits; current-view browser tile reads/preview. | Versioned credential-free configuration is retained. No complete tile archive, upstream editing or availability guarantee. |
| Public WMS 1.3.0/1.1.1 | Declared layers/styles and EPSG:3857 PNG/JPEG GetMap preview for the current extent. | Versioned configuration and a separately requested protected PNG capture; no complete archive, upstream editing, private upstream credentials or arbitrary CRS/dimensions. |
| Public ArcGIS ImageServer / MapServer | Credential-free display references; Web Mercator image tiles at 256 or 512 pixels. ImageServer supports provider default or one/three explicit bands; MapServer uses explicit layer IDs. | Configuration is versioned; registration does not archive pixels. No private credentials, arbitrary raster/render rules or original-file mirroring. Syntax validation is not a health check. |
| WFS 2.0 | Declared endpoint/schema; one current-extent GeoJSON page of at most 1,000 features. Reads are capped at four concurrent requests, 20 seconds and 8 MiB per request. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete collection, WFS-T, joins, locks or broad filter/CRS support. |
| ArcGIS REST features | Declared layer/fields/geometry; one current-extent GeoJSON page of at most 2,000 features, with the same request bounds as WFS. | Explicit bounded capture can preserve the reviewed page as managed GeoJSON. No complete service snapshot, private authentication, upstream edits, attachments or relationship/domain conversion. |
| PMTiles | Public HTTPS archive reference or managed immutable archive, declared raster/vector rendering and browser range reads. | Explicit vector-to-PMTiles jobs create derivatives. No feature editing inside archives. Exact copies require the preservation action; registering a URL alone does not create a copy. |
| STAC 1.1 Collection | **Metadata import only:** one bounded Collection document, including identity, extents, license, keywords, providers and links. | Exact source representation/checksum and metadata provenance are retained. No Item search, asset reads, streaming, rendering or automatic raster/vector Layer creation. |
| External STAC Item search | Separate Catalog control for explicit anonymous HTTPS GET searches, bounded manual paging, original Item/query/response evidence and selected analytical TIFF registration. | Reuses referenced COG inspection and deliberate Project composition. Asset rights/access stay unverified; unsupported assets remain references. This does not extend Collection metadata import or assert general STAC conformance. |
| External PostgreSQL/PostGIS | **Implemented, opt-in:** owner-scoped TLS profiles, read-only capability verification, relation discovery, stable live Layer registration and bounded feature preview. Credentials are write-only and encrypted. Initial support requires an ordinary table with at most 64 columns, one supported 2D EPSG:4326 geometry, a stable unique key and supported primitive attributes. | The compiled local Services-to-Catalog journey renders 100 of 123 real Points for owner and viewer without connection-management authority, preserving exact bigint/decimal text and disclosed truncation. Authenticated API removal of the viewer's project grant returns 404 without another secret read or query. No managed feature copy or Project is created; cleanup passes. The path defaults off. Configured-provider, AWS and deployment acceptance remain open. Arbitrary SQL and upstream editing are unavailable; application PostGIS analysis is separate. |

That connected PostGIS check uses synthetic connection verification, identity and
secrets, with local substitutes for external DNS/TLS and cloud transport. It proves
the selected browser/API/SQL/connector path, not a configured remote connection.

The remaining source families retain **inert definitions during GeoLibre project
conversion**. They have no executable source adapter in this catalog:

| Retained definition | Unavailable operations |
| --- | --- |
| CAD, FileGDB, MBTiles and OSM PBF | Opening/converting their geometry, databases or tile archives; associated domains, relationships and styling. MBTiles is not treated as PMTiles. |
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
