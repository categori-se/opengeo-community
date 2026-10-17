# Processing data

OpenGeo separates small browser operations from deliberate server jobs. This keeps common inspection immediate and lets heavy conversion capacity return to zero when it is not needed.

For scripts, open **Processing → Analysis console**. Choose a language and an
available execution profile, select the loaded vector inputs, then use **Run**
and **Stop**. Review output before selecting **Add result to map**. The
[console guide](../python-automation.md#analysis-console-in-a-map) explains the
browser/local setup and the remaining managed-profile work.

## Run a browser tool

1. Select a local vector layer in the Layers tree.
2. Open **Processing** and choose **Count features**, **Calculate bounds**, **Create bounding-box layer**, **Create vertex-mean centers**, or **Create planar centroid layer**.
3. Select **Run**.

Count and bounds return a summary. Bounding box and both center tools add a temporary derived layer to the current project. The processing panel states the registry and tool version that ran and lists recent project processing history.

Browser processing accepts CRS:84 GeoJSON with at most 50,000 features and 1,000,000 coordinate positions. It makes no network request. A saved model may contain at most 16 steps. When a project contains a supported saved model, the panel offers **Run saved model** and feeds each derived layer into the next step.

Saving the project retains up to 100 compact history entries. Each entry records the tool, version, parameters, input facts, output summary, limits, bounded log, time, duration, and output layer name. Derived GeoJSON stays in its layer and is not duplicated in history.

## Request a server conversion

**Vector to PMTiles** and **Raster to COG** use the activation-only processing service. Reading the tool list starts no job. A project member with the required authority deliberately creates a bounded request against an immutable source version. The job remains queued while processing capacity is inactive.

A successful job records one immutable receipt containing the sealed request, exact source and output objects, checksums, lineage, tool and configured software versions, bounded completion events, actor, and time. Project reads remain tenant-scoped. Server limits include 512 MiB source objects, four active jobs, and 64 retained jobs; COG requests also enforce their declared pixel, sample, band, CRS, and resampling limits.

### Configurable PMTiles conversion — local candidate

The next PMTiles profile adds the same reviewed form to dataset intake and map
Processing. Choose the zoom range and output tile Layer; leave the input Layer
blank when the source contains only one. Advanced controls cover coordinate
detail, simplification, buffers, tile budgets and included attributes. Higher zooms
increase work and archive size. Adaptive conversion can simplify geometry or omit
features; retain the original for analysis.

The form reads supported formats and processing availability when opened or
explicitly refreshed. A paused or exhausted runtime rejects new work before
creating a job. Matching requests reuse their existing result. Completed output
can be reviewed and admitted for tiled display, then selected and saved with the
Project. This profile still awaits its actual-image and hosted acceptance; large
sources without an original preview also need the initial tile-backed Add Layer
path. It is not yet a claim of a complete deployed intake workflow.

## Open a GeoLibre project with processing history

OpenGeo maps known GeoLibre tool ids to its registry. It preserves unknown models and history entries with an operation-level `preserved-unsupported` result. Importing a project never runs its processing steps. Review the conversion report, replace unsupported steps where appropriate, and then run a supported model explicitly.

The current executable browser subset is count, bounds, bounding box, vertex-mean
centers and planar geometric centroids. The vertex-mean tool retains GeoLibre import
semantics. Planar centroids weight line segments by length and polygon components by
area, subtract holes and use the highest dimension in mixed geometry. They operate
on valid CRS:84 geometry in the longitude/latitude plane; they do not repair topology
or compute ellipsoidal centers. Both use the existing local derived-layer and saved
processing-history path. GeoLibre sidecars and the rest of its processing catalog remain visible as preserved project information rather than executable OpenGeo tools.
