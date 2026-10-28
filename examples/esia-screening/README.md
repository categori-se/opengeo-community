# Synthetic footprint and influence-area screening

Use the normal GIS Project and spatial-analysis controls to ask a small E&S
baseline question: **which mapped point receptors intersect each selected area?**
This example contains invented geometry and names, never field observations or a
study of the place under these coordinates. It teaches a bounded screening step
for a supported pilot; it is not a complete ESIA or an impact finding. No new
landing page, specialist interface or provider account is required.

## Exact inputs and expected result

Keep these three GeoJSON files and [provenance.json](provenance.json) together.
The provenance pins their bytes, SHA-256 hashes and fixture version **1.0.0**.
Coordinates are longitude/latitude in CRS84, with no reprojection.

| Input | Contents |
| --- | --- |
| [footprint.geojson](data/footprint.geojson) | One Polygon: rectangle `[10,10]` to `[10.02,10.02]`. |
| [influence.geojson](data/influence.geojson) | One Polygon: larger rectangle `[9.99,9.99]` to `[10.03,10.03]`. This is an explicit exercise area, not an automatically justified buffer. |
| [receptors.geojson](data/receptors.geojson) | Five Point records, A–E. Their names and coordinates are synthetic. |

| Screening scope | Point records / point coordinates | Expected members |
| --- | --- | --- |
| Project footprint | **2 / 2** | A, B |
| Influence area | **4 / 4** | A, B, C, D |
| Outside both, checked against the source | **1 / 1** | E |

The two screening rows stay separate. A and B occur in both: the exported
screening result has **six scoped records**, representing **four distinct source
points**, not six people, households or impacts. Polygon and line receptor counts
are zero; polygon-area and line-length results are not applicable. The polygons
are masks, not polygon receptors. No point lies on a mask boundary.

After the repository's normal frontend setup, reuse installed dependencies:

```bash
node examples/esia-screening/analysis.mjs
```

The command checks the input hashes and reproduces these memberships with the
existing OpenLayers geometry implementation. It reads local files only and creates
no API requests or native-analysis receipts. This fixture calculation does not
prove Studio clipping, sign-in, saving, hosted delivery or independent installation.

## Run the screening in connected Studio

1. Upload each file once through the configured Catalog workflow. Wait for its
   processing state to become ready, then add the three saved Layers to one
   Project. Opening local files alone creates browser Layers; the native analysis
   requires stored inputs. Name the Layers **Synthetic footprint**, **Synthetic
   influence area** and **Synthetic receptors**. Save the Project.
2. Record the actual Catalog dataset/version IDs and collection generations.
   Fixture version `1.0.0` identifies these files; it does not replace server
   version numbers or establish an observation date. Keep all three original
   distributions and their provenance available.
3. Open **Processing → Spatial analysis**. Set **Operation** to **Screen
   footprint and influence area**, **Receptor layer** to Synthetic receptors,
   **Project footprint** to Synthetic footprint and **Influence area** to
   Synthetic influence area.
4. Enter **Screening question**: “Which synthetic point receptors intersect each
   explicitly selected area?” Enter **Influence area basis**: “A larger
   author-drawn rectangle for this numerical exercise; not a buffer, modeled
   impact zone or regulatory distance.” Choose **Preview analysis**.
5. Compare the two result rows with the table above. Download **screening table
   CSV**, **screening methods JSON** and **analysis GeoJSON** using their buttons.
   Keep the actual method/version, source IDs, source and mask generations,
   question, area basis and interpretation limits with the exports. Studio uses
   native planar CRS84 clipping; polygon/line measurements, when applicable to
   other inputs, use the declared mean-sphere method. Do not report this local
   count check as native API acceptance.

`observation_period`, `verified`, `households` and `rights` are deliberately
`null`, not zero, false or verified facts. Source quality, coverage, observation
period and distribution/access rights remain unknown in the provenance. Leave
unknown license fields blank when registering; the software license does not
supply rights for real data substituted into this exercise. Do not infer land
access, tenure, consent, population totals or compensation eligibility.

## Retain and reopen deliberately

Use the existing result registration controls to review its title, attribution
and output terms, then **Save as catalog Layer**. Use **Resume Layer registration**
for the same
registration if interrupted; do not upload another copy after a committed stage.
Wait for processing readiness, add the saved result from Catalog, compare its
records and methods with the exports, and remove the temporary result only after
that check. **Save** the account Project, close it and reopen through the same
account. Check its saved Layer/version references, the two masks and the retained
result. Project saving is separate from registering data and from publishing.

For a browser-only exercise, inspect/style the inputs, choose **Save on this
device**, reopen the personal Project and download a backup. That demonstrates
device persistence only; it cannot substitute for this stored-input native
screening or an account-backed save/reopen check.

## Task and recovery notes

- **Source still loading:** use the available cancel control or leave the view;
  inspect the reported limit/error before retrying. Do not interpret a preview as
  a retained copy. See [source review](../../docs/community-baseline.md#choose-source-evidence).
- **Map blank or rendering failed:** preserve exports and source files; continue
  Catalog/metadata work where available. Stop map-dependent analysis/capture and
  reopen the map after resolving graphics support. A failed display is not proof
  that a Layer addition failed; check the Layer list before adding it again.
- **Save conflict or interrupted registration:** keep exports, inspect the saved
  revision/committed Catalog record and resume its existing operation. Do not
  overwrite newer work or blindly repeat writes. See [save and delivery](../../docs/community-baseline.md#retain-results-and-deliver-deliberately).
- **Print unavailable:** capture each frame, inspect its captured detail and
  eligibility, then prepare a supported output. Preserve the layout and return to
  the map when capture cannot finish; map exports do not establish study validity.
- **Unexpected counts:** check the exact input hashes, Layer roles and versions
  before changing geometry. Retain the discrepancy; never move points merely to
  produce the expected result.

This example has a local geometric count check. The connected Studio steps above
are a reproducible acceptance procedure, not a claim of completed hosted or
multiuser acceptance. A real study also needs appropriately licensed evidence,
coverage/quality review, expert interpretation and its own delivery scope.
