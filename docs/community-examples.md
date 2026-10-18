# Maps and published analysis

Start with a question, then keep enough of the inputs and method to adapt the
study later. These publications show maps and analysis together. They are worked
references, not complete input bundles or one-click Studio templates.

| Publication | What to explore |
| --- | --- |
| [Map Folio](https://opengeo.tools/map-folio/) | Explore Bali through a retained OpenStreetMap snapshot. Toggle forests, rivers and water bodies, rotate the projection and adjust map annotations. |
| [Reading beyond the visible](https://opengeo.tools/noaa-coastal-imagery/reading-beyond-visible/) | Compare NOAA coastal imagery in natural color and color infrared. Inspect pixel values, contrast stretches and vegetation indices, then export the analysis parameters. |
| [Measuring change in Nepal with census tables](https://opengeo.tools/nepal-census-tables/) | Compare census counts, check denominators and examine the difficulties of joining observations across dates and boundaries. |
| [Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/) | Compare color, patterns, labels and map controls that make spatial information easier to read. |

These are published examples from [our deployment](community-deployments.md).
Their source data and reuse terms are described on the individual pages; this
repository does not include a complete installation and input bundle for every
publication.

## Reproduce a Berkshire conservation study

The [Berkshire conservation example](../examples/berkshires-acecs/README.md)
includes the real retained GeoJSON, executable analysis, provenance and a native
Framework page. It asks which conservation designations and municipalities appear
in the historical archive. The result is 16 municipal polygon records, five
distinct designations and eleven town attributes; repeated area fields are not
summed. Unknown export dates and provider/archive rights remain explicit.

Its packaging command creates an editable Studio Project backup and a Publication
source ZIP. The map starts with its Layer visible, designation colors, transparent
fills and a blank background. Actual browser checks import the backup, revise its
opacity, save and reopen it without changing geometry. The native compiler and
browser render the same real input as a map and calculated tables. These local
checks reuse cached software; they do not establish independent installation or
hosted delivery. Existing hosted Berkshire Layers and map identities are preserved.

## Adapt a method

Each example should help you decide what to reuse, what to change and what the
result can support. Read its source and rights record before downloading,
capturing or redistributing an input. A public page does not itself grant rights
to all of its data.

| Starting point and question | Inputs and method | Expected observation and route into Studio |
| --- | --- | --- |
| **Map Folio:** How do water and forest features relate in this study area? | Use the publication's retained OpenStreetMap snapshot under its recorded terms; compare thematic Layers and annotations. | Layer visibility and presentation change the reading of a shared geography. Use permitted compatible vector inputs in a Project and retain source attribution; the publication's full composition is not supplied as a Studio template. |
| **Reading beyond the visible:** What does color infrared reveal that natural color obscures? | Select permitted NOAA imagery identified on the page; compare band combinations, contrast stretches and vegetation indices, retaining the analysis parameters. | Vegetation and surface differences become easier to distinguish; display colors alone do not establish a land-cover classification. Use a supported imagery source or permitted local input in Studio; the publication's analytical controls are not all Studio tools. |
| **Nepal census tables:** What changed between observations? | Follow the cited tables and their reuse terms; check denominators, dates and boundary correspondence before comparing counts. | Apparent change can depend on the denominator or geographic join. Bring a permitted compatible table or derived spatial input into Studio and document the join; automatic census harmonization is not implied. |
| **Accessible cartographic design:** Can readers distinguish the mapped categories? | Apply the article's color, pattern, label and control guidance to a dataset you may use. | Compare readability in the intended viewing and print conditions. Adapt supported Styles and labels in Studio, then inspect the exported result; the article is design guidance rather than an importable style pack. |

The [capability guide](community-capabilities.md) describes supported inputs and
operations. Preserve the method and interpretation limits alongside any adapted
map instead of assuming that a visual resemblance reproduces the analysis.

## Explore environmental screening

The [MassGIS demonstration](https://demo.studio.opengeo.tools/?view=examples)
offers a different way to explore the workspace. Choose **Explore MassGIS**,
open an indicator and inspect its source and legend before comparing Layers.
The question is which block groups warrant further investigation for a selected
environmental indicator. Compare the indicator's statewide percentile with the
source definition and other Layers; keep the edition and selected measure with
your saved map.
MassEnviroScreen uses statewide block-group percentiles for screening. A high
percentile identifies a question for investigation; it does not establish
conditions on a particular parcel or an individual's exposure.

The [MassGIS configuration](../app/src/data/massgis-enviroscreen.json) records
indicator definitions, the source edition, attribution and public-domain terms.
The source archive is not included in this repository.

## Try it: community facilities

For a short study you can keep, open the [starter map](https://demo.studio.opengeo.tools/?map=community-facilities).
It contains five fictional facilities released under **CC0-1.0**, with a
[downloadable GeoJSON input](../app/src/data/sample-public-facilities.geojson)
and [source and rights record](../app/src/data/public-demo-catalog.json).
On GitHub, choose **Raw** to download the original input. The question is which
facilities are marked as publicly accessible and how to make that distinction
clear to a reader.

1. Open **Catalog**, find **Public community facilities** and choose **Review
   and add**. Read the source information, then choose **Cancel** to keep the
   existing composition.
2. Select the Layer and choose **Layer → Open attribute table**. There are five
   records; four have `public_access: true`.
3. Open **Layer → Layer properties**, change the point symbol or opacity, and
   toggle visibility. These choices change the presentation, not the input.
4. Choose **Project → Save on this device**, give the map a name and check for
   **Saved on this device**. Open **Project → Projects on this device** and
   reopen the saved Project to check that your styling remains.
5. In **Projects on this device**, choose **Download backup**. The ZIP retains
   the Project, supported local data, source metadata, styling and saved layouts;
   live services remain references. Keep the ZIP outside browser storage.
6. Choose **Project → Open Print Studio** to prepare a layout from this map.
   Inspect its legend and attribution, save the layout, then download an updated
   backup to retain it. Use **Project → Save as / export…** for the available map
   outputs; a viewable export and an editable Project backup serve different uses.

Personal Projects have no daily expiry and are independent of sample resets.
They remain local to this browser profile and site; browser storage can be
cleared or evicted. Older sample drafts have separate daily expiry. Saving on
this device does not upload a Project or make it available to another website.

The facility names, coordinates and verification dates are invented. The
exercise teaches inspection and styling, rather than assessment of a real
community. Its data license is separate from the software's Apache-2.0 license.

### Use the registered Layer in a Publication

In a connected Studio workspace, reuse the registered GeoJSON Layer rather than
uploading another copy. The [local setup](community-development.md) supplies a
connected API and the optional native compiler profile; browser-only Demo storage
does not provide a Catalog file to another workspace.

Open an authored Publication's Files editor with a root `index.md` page. Under
**Draft settings and data references → Data files → Connect a Catalog file**, use
**Search Catalog**, select the Layer, its exact version and original GeoJSON, then
choose **Connect file** or **Link dataset and use file**. Set **FileAttachment path**
to `data/facilities.geojson` and insert the file. Keep one reader cell in your page:

```js
const facilities = await FileAttachment("./data/facilities.geojson").json();
const count = facilities.features.filter(f => f.properties.public_access === true).length;
const summary = document.createElement("p");
summary.textContent = `Public access: ${count}/${facilities.features.length}`;
display(summary);
const names = document.createElement("ul");
for (const f of facilities.features) {
  const item = document.createElement("li");
  item.textContent = f.properties.name;
  names.append(item);
}
display(names);
```

Retain the CC0 source attribution, Save draft, choose Saved preview, then Build
saved revision and Show preview. Expect all five names and **Public access: 4/5**.
This archived-file workflow passes locally through the Source editor, API, native
compiler and signed preview. The saved revision pins the selected input; it does
not follow later dataset versions automatically. Publishing remains a separate
action. Reusing a saved map's styling requires its retained Project Artifact;
this file-based example does not embed that map.

See the [workflow guide](community-workflow.md) for account-backed saving,
shared-Layer reuse and the recurring-study publication acceptance target. To add
a worked example, follow the
[contribution guide](../CONTRIBUTING.md) and include its question,
permitted inputs, method, expected observations, interpretation limits and a
route into the compatible Studio workflow. Identify which steps are demonstrated
and which still need acceptance.
