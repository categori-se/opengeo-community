# Review a baseline with published data

Start with a study question, area and observation period. Use OpenGeo Studio to
inspect published evidence, compare interpretations and retain the methods behind
each result. These bounded tools do not establish a complete environmental or
social baseline. See [capabilities and maturity](community-capabilities.md) and the
[development guide](community-development.md) for available workflows and setup.

For a small reproducible start, follow the [synthetic footprint and influence-area
example](../examples/esia-screening/README.md). Three exact GeoJSON inputs produce
separate expected counts of two footprint receptors and four influence-area
receptors. It includes local reproduction, methods/CSV/GeoJSON exports, explicit
unknown rights and save/reopen and recovery steps. Use the existing general GIS
Project and Processing controls; this is a screening exercise, not a complete ESIA
or a collection of real field observations.

## Choose source evidence

In **Catalog → Register Layer → Published baseline sources**, enter study bounds
and optional requested dates. Choose a **Baseline objective** and **Ranking
priority**, then **Compare baseline sources**. The comparison reviews two curated
profiles: ESA WorldCover 2021 v200 land cover and Fields of the World global field
predictions for 2024/2025. It does not search every provider. Objective compatibility
precedes the selected priority; the ordering is not a quality score or approval.

Review the separate facts, assessments and unknowns, and download the JSON report.
Study-area completeness, effective rights, quality and processing cost may remain
unknown. Comparison fetches no source data and creates no Catalog records.

**Find WorldCover 2021 tiles** identifies up to four candidate references locally.
Choose **Use** for a tile, then deliberately **Review Layer → Register referenced
Layer**. Registration preserves a reference rather than copying its data. One
checked tile on the original host lacked browser CORS permission; this limits the
demonstrated browser path, without establishing that every tile is unavailable.
A current comparison accompanies the selected reference.

## Review a published forest-history legend

For a loaded categorical band, open **Categorical raster inventory** and select
**JRC TMF 2025 — Transition Map main classes** under **Published product
interpretation**. Check the input against that exact product/release and confirm
it separately. Then calculate a window inventory or intersect a loaded study-area
polygon. The selected legend is a declaration; it does not verify the input data.

The report keeps mapped regrowth, different forest conversions and recent
unresolved degradation/deforestation separate. It preserves unknown codes, missing
cells, native source meanings and your custom labels. JSON/CSV include the full
pinned legend and history periods. Areas describe cached cells, which may be
coarse overviews; they do not establish complete coverage, pristine forest,
ecological condition or independent accuracy. Review source terms before sharing.

The same selector also offers **Hansen Global Forest Change 2025 v1.13 — annual
tree-cover loss year** for a checked `lossyear` band. Codes 1–25 describe mapped
events in 2001–2025; code 0 records no loss code and does not establish intact
forest or valid land coverage. The separate data mask is not applied. Unknown
codes, source NoData and your labels remain separate. Selection and calculation
read only the already loaded window. JSON/CSV retain the declared profile and
source facts. Sensor and algorithm differences limit annual comparisons, and
mapped-cell footprints are not definitive forest-loss area estimates. See the
[pinned usage notes](https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/download.html)
and [band definitions](https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2025_v1_13).
This interpretation does not verify a selected raster or demonstrate a complete
monitoring update.

## Discover analytical assets through STAC

In **Catalog → Search external STAC Items**, enter a public HTTPS search endpoint,
Collection IDs, bounds and UTC dates. **Search Items** reads one bounded page;
**Next page** is deliberate and shares the same request/byte/time limit. Candidate
bounding matches do not prove study-area coverage. The result preserves the original
Item, observation dates, search filters and response hash; downloading references
or reviewing assets does not fetch imagery.

Choose **View asset references → Review Catalog registration**, then select a
compatible public TIFF, one or three bands and an editable access workspace. Terms
belong to each distribution; unknown asset terms do not inherit Item terms. Other
asset formats remain references. Supply a known byte size only when independently
established; it is retained as an unverified declaration. Some providers hide browser
range headers, so access and snapshot consistency can remain unverified.

**Register Layer** preserves the upstream reference and can reuse an existing
matching Layer. **Open map** inspects that Layer temporarily; use the separate
Project composition/save action to retain it in a Project. The existing reader is
bounded and may use coarse overviews. Native raster values and scale/offset metadata
remain separate; display does not establish physical units, classification accuracy,
forest change or complete study-area coverage.

## Retrieve mapped field predictions

In a Project, open **Processing → Find mapped agricultural fields**. Choose a
country, 2024 or 2025, and an explicit WGS84 rectangle, then **Find fields**. The
query has request, transfer, decoding, feature and time limits; unsupported sources
or exceeded limits do not produce a partial accepted inventory. Returned polygons
retain whole footprints, including portions outside the rectangle.

Inspect the result before **Add temporary field Layer**. **Download field query
JSON** retains the source receipt; **Open saved field query** reopens that download
without another provider query. Source confidence is sampled from a 500 m
reliability raster, not a calibrated polygon probability or boundary-accuracy
measurement. Missing confidence stays missing. Predicted fields establish neither
crops, cadastral parcels nor tenure.

Within a returned or reopened query, expand **Inspect field confidence** and choose
**Review field confidence**. Inspect exact scores, missing values and the supplied
range. Optionally flag scores below a chosen 0–100 threshold; equal scores are not
flagged and missing scores remain separate. **Download confidence JSON/CSV** saves
all field rows, source/query evidence and the review method. The original query
download and added Layer keep every field unchanged. This review reads no provider
data and does not establish field accuracy or independent validation.

## Compare surface and terrain heights

Load the surface (DSM) and bare-earth terrain (DTM) raster windows, then open
**Processing → Compare surface and terrain heights**. Choose their bands and
units explicitly. Different bands in one cached Layer can be compared. Check
each band's role and record why the vertical references, dates, source scaling
and methods are compatible.

Choose **Calculate height differences**. The result retains negative heights,
missing pairs and unknown accuracy; it does not identify buildings or vegetation.
Matching grids are required, with no resampling or additional raster reads.
Download the height JSON or summary CSV. For up to 1,024 cells, download complete
height-cell GeoJSON or **Add height cells to map**, then deliberately register
the temporary Layer in Catalog before saving an account Project. Larger results
retain summaries with an explicit complete-map limit. Source terms and output
permissions remain separate.

## Inspect loaded categorical rasters

Select a loaded raster and open **Layer style → Categorical raster inventory**.
Confirm the categorical band and review source dates and class meanings. Choose
the entire cached window or a loaded polygon in **Analysis area**. Whole-window
areas use whole cells; polygon inventories measure partial intersections. Source
NoData, noncategorical values and area outside the cached window remain separate.
Requested dates do not replace published source observation dates.
Areas use Earth's mean sphere, and overviews remain coarser observations. Export
the inventory JSON or CSV with its scope and methods.

**Compare categorical rasters** requires two resident aligned windows, separate
categorical-band confirmations, explicit `code = group` crosswalks and a
**Comparability basis**. Raw codes and native meanings remain separate from
normalized groups; identical codes do not establish equivalent classes. There is
no resampling. Ordered source periods plus confirmed methods yield **Declared
comparable**, rather than verified change. Missing or incompatible evidence stays
explicit. WorldCover 2020 v100 and 2021 v200 use different algorithms; their
differences alone cannot establish land-cover change.

Optionally choose **Reference raster** and record a **Reference evaluation basis**
before comparing. Per-class precision, recall, F1 and intersection-over-union
describe agreement with that designated reference. The sparse confusion table
counts paired mapped cached cells with equal weight; missing pairs stay excluded,
absent declared classes remain visible and zero denominators stay unknown. Reference
quality, independent validation, accuracy and uncertainty remain unestablished.
**Download agreement CSV** retains every class and confusion pair with methods;
comparison JSON and complete transition maps also retain the full evaluation.

JSON and CSV preserve the full bounded transition report. Complete changed-cell
polygons can be downloaded or deliberately added to the map. More than 1,024 cells
or a complete GeoJSON exceeding 1 MiB withholds all map geometry while retaining
the valid report. Results do not establish forest loss, regrowth or accuracy.

**Summarize class patches** describes one explicit crosswalk group. Choose
edge-only **4** or edge-or-corner **8** connectivity and enter an interpretation
basis. Patch count, area and density describe the loaded grid. Observed edges
against other mapped groups remain separate from missing-data and window
boundaries. Connectivity outside the window is unknown; these summaries do not
verify habitat condition or ecological fragmentation. Methods JSON, table CSV
and complete bounded cell maps retain the choices.

After **Add transitions to map** or **Add patch cells to map**, select the temporary
Layer and open **Processing → Save raster Layer to Catalog**. Review its title,
description, output license and attribution. Leave unknown output terms blank;
input terms do not grant output permissions. Registration preserves the complete
cell map and methods report. Processing readiness is a separate step: open Catalog,
add the ready saved Layer, check it, then remove the temporary Layer and save the
account Project. Resume an unfinished registration to reuse its committed upload.
Saving does not reread the source rasters or repeat their calculations.

## Validate categorical classes with reference review

Open **Processing → Validate categorical raster classes**. Choose a loaded
categorical band, crosswalk, seed, draws per mapped group, reference classes,
question and whole-cell labeling protocol before sampling. **Generate validation
sample Layer** freezes only eligible loaded whole cells. It samples with
replacement, proportional to cell area within each mapped group; repeated draws
keep their multiplicity while sharing one reference label per distinct cell.

Use **Focus selected cell** and existing imagery controls to inspect the entire
footprint. Record the reviewer, reference source/date/version and cell review note.
Unresolved reviews remain explicit and prevent estimates. Corrections append to
the history. Once every distinct cell has a resolved reference class, explicitly
**Calculate area-adjusted estimates** to view weighted confusion, class areas,
standard errors and conservative simultaneous 95% class-area intervals.

The intervals describe sampling uncertainty conditional on fixed labels and the
frozen population. Reference quality, temporal/positional errors and classification
accuracy remain unverified. Whole-cell labels do not estimate subpixel cover;
precision, recall, F1 and overall agreement are point estimates without intervals.
Choose the seed before reviewing labels; do not redraw or replace difficult cells.

Download assessment JSON to retain a draft or complete review, then **Open saved
assessment JSON** to continue on a new temporary Layer without the original raster.
JSON and draw-cell GeoJSON preserve the complete history; CSV retains context,
draws, current reviews and estimates. Use the same deliberate **Save raster Layer
to Catalog**, readiness, Catalog Add and Project Save steps described above for
account persistence. Generation is bounded to 1,048,576 cells, 16 mapped groups,
2–128 draws per group, 512 total draws and ten seconds; exports are at most 1 MiB.
No sampling, estimation or source acquisition runs merely from opening the panel.

## Review vector evidence

In **Spatial analysis → Reconcile building footprints**, select two distinct
stored inventories. Review overlap groups, explicitly select retained footprints
and record a reason for every group. The reviewed inventory preserves selected
geometry and the decisions; it does not automatically validate buildings.

Choose an explicit **Reference inventory** before **Evaluate inventory
agreement**. Precision, recall, F1 and matched intersection-over-union describe
agreement between the original inventories. They do not establish reference
completeness, field accuracy or household counts.

For **Screen footprint and influence area**, select the receptor, Project
footprint and influence-area roles, then record the screening question and
influence-area basis. Separate summaries report polygon areas, line lengths or
points as appropriate. Overlap is screening evidence; expert impact findings,
rights and compensation require separate assessment.

In main Studio, **Social baseline evidence** adds a
source review for one demographic/vulnerability, settlement, infrastructure or
land-use inventory. Record its original spatial unit, dates, coverage evidence,
suitability and limitations, then describe up to six original fields with units
and denominators. Apply the review before exporting or retaining the result.
Other evidence topics remain explicitly missing. The evidence CSV preserves
individual values and missingness; population-zone totals and rates are not
allocated to clipped areas. This single-source review does not establish a
complete social baseline, affected households, tenure or impact findings.

## Retain results and deliver deliberately

Catalog Layers retain resource identities; Projects deliberately compose them.
Temporary Add, Catalog registration, Project Save and publishing are separate
actions. Export methods and source/version pins, review distribution terms and
retain attribution. For account persistence, register eligible temporary data
through the configured Catalog workflow before account Project saving. Browser
device save/reopen checks do not establish governed account persistence.

These tools have local implementation and selected acceptance evidence; this guide
claims no cloud deployment, comprehensive live-provider coverage or independent
full installation. Follow the [data lifecycle](community-data-lifecycle.md) and
[publication destinations](community-publication-destinations.md) for preservation,
configured account authority, saved builds, preview and deliberate release.

The shared tools belong to Community. Licensed or private client data, expert
validation, commissioned studies and managed delivery require their own scope and
permissions. See the [Community roadmap](../ROADMAP.md) for remaining work.

## Inspect retained building inputs

For an eligible uploaded GeoJSON Layer, choose **Catalog → Open map** to inspect
its exact saved original in a temporary interactive view. Saved governed Layer
presentations use the same reader. Inspection retains original attributes and
geometry, checks normal access and content integrity, and leaves saved Projects
unchanged. Listing Catalog records does not read original files.

Both entrypoints pass local contracts; the Resources path also renders two retained
synthetic building inputs through the local account API. This demonstrates scoped
transport and rendering, not provider rights, reference quality or building accuracy.
