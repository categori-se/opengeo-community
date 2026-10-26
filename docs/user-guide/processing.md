# Processing data

OpenGeo separates small browser operations from deliberate server jobs. Inspecting
data or reading the tool list starts no server job.

For scripts, open **Processing → Analysis console**. Choose a language and an
available profile, select fully loaded vector inputs, then use **Run** and
**Stop**. Review output before selecting **Add result to map**. The
[console guide](../python-automation.md#analysis-console-in-a-map) explains the
browser and local profiles and their acceptance limits.

## Compare source references before analysis

In **Catalog → Search external STAC Items**, enter a public search endpoint, Collection IDs, bounds and UTC dates. Search reads metadata; opening Catalog starts no request. Under **View asset references**, choose one or three bands and **Add <Item> / <asset> to comparison**. In **Compare selected STAC assets**, enter study bounds, whole UTC dates and the criteria that matter to the analysis, then choose **Compare selected assets**.

The local review compares at most twenty selected TIFF references across declared footprint coverage, dates, nominal resolution, exact band/class names, scene cloud cover, asset licenses and declared transfer bytes. Unknown evidence remains unknown. Footprint overlap is not valid-pixel coverage; scene cloud cover is not AOI accuracy, Item terms do not become asset terms, and file size is not a processing price. No imagery is read during comparison.

Use **Download selected source comparison JSON** to retain the report, or **Review <Item> / <asset> for Catalog** to continue through deliberate registration. A new Layer retains only the selected compact inferred review alongside unchanged original Item/asset/query metadata. Existing matching Layers retain their existing metadata. Criteria or account changes invalidate the review; changing asset settings clears it before ordinary registration. **Open map** is temporary; Project composition and saving remain separate actions.

The tool and source are included under Apache-2.0 in the full Community suite. Hosted operation, provider integration and commissioned interpretation are separately scoped services. Current local checks cover comparison, export and registration with retained metadata; this new review has not yet passed hosted persistence or current provider-availability acceptance.

## Run a browser tool

1. Select a local vector Layer in the Layers tree.
2. Open **Processing** and choose **Count features**, **Calculate bounds**,
   **Create bounding-box layer**, **Create vertex-mean centers**, or
   **Create planar centroid layer**.
3. Select **Run**.

Count and bounds return a summary. Bounding box and both center tools add a
temporary derived Layer to the current Project. The processing panel shows the
registry and tool version and recent Project processing history.

Browser processing accepts CRS:84 GeoJSON with at most 50,000 features and
1,000,000 coordinate positions. It makes no network request. A saved model may
contain at most 16 steps. For supported saved models, **Run saved model** feeds
each derived Layer into the next step.

Saving the Project retains up to 100 compact history entries recording the tool,
version, parameters, input facts, output summary, limits, bounded log, time,
duration and output Layer name. Derived GeoJSON stays in its Layer and is not
duplicated in history.

## Request a server conversion

**Vector to PMTiles** and **Raster to COG** use the activation-only processing
service. An authorized Project member deliberately requests conversion of an
immutable source version. A queued job requires configured, active capacity.

A successful job retains the sealed request, exact source and output objects,
checksums, lineage, configured software versions, bounded completion events,
actor and time. Project reads remain tenant-scoped. Server limits include
512 MiB source objects, four active jobs and 64 retained jobs. COG requests also
enforce their declared pixel, sample, band, CRS and resampling limits.

### Configurable PMTiles conversion — local candidate

The configurable profile provides zoom range, output tile Layer and optional
input Layer controls in intake and map Processing. Advanced settings cover
coordinate detail, simplification, buffers, tile budgets and included attributes.
Higher zooms increase work and archive size. Adaptive conversion can simplify
geometry or omit features; retain the original for analysis.

The form reads supported formats and processing availability when opened or
explicitly refreshed. Paused or exhausted capacity rejects new work before
creating a job; matching requests reuse the existing result. Completed output
can be reviewed, admitted for tiled display and saved with the Project.
Actual-image and hosted acceptance remain open. Large sources without an
original preview also need the initial tile-backed Add Layer path. This profile
does not establish a complete deployed intake workflow.

## Open a GeoLibre project with processing history

OpenGeo maps known GeoLibre tool IDs to its registry. Unknown models and history
entries retain an operation-level `preserved-unsupported` result. Importing a
Project never runs processing steps. Review the conversion report, replace
unsupported steps where appropriate, then run a supported model deliberately.

The executable browser subset is count, bounds, bounding box, vertex-mean centers
and planar geometric centroids. Vertex-mean centers retain GeoLibre import
semantics. Planar centroids weight line segments by length and polygon components
by area, subtract holes and use the highest dimension in mixed geometry. They
operate on valid CRS:84 longitude/latitude geometry; they do not repair topology
or compute ellipsoidal centers. Other GeoLibre processing information remains
preserved Project content.
