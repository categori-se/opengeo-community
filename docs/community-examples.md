# Examples for inspecting and explaining spatial evidence

Begin with a question, retain the input and explain what the result supports.
The starter exercise below is reproducible from a tiny public input. The hosted
examples show existing presentations; proposed exercises remain invitations for
contributors, with their missing inputs and acceptance stated explicitly.

## Try it: community facilities

**Question:** what does this input say about its listed facilities, and which
claims would require more evidence?

Use the [five-feature GeoJSON](../app/src/data/sample-public-facilities.geojson)
and its [source and rights record](../app/src/data/public-demo-catalog.json).
On GitHub, choose **Raw** on the GeoJSON file, then save it locally to inspect the
original bytes or open it in another GIS. The input is synthetic demonstration data released under
**CC0-1.0**, credited to **OpenGeo.Tools synthetic demonstration data**. Its
facility names, coordinates and `last_verified` dates are fictional. The
software's Apache-2.0 license is separate from the input's terms.

![The anonymous Demo with the synthetic facility Layer and five mapped locations.](assets/community/starter-map.png)

*Actual October 5, 2026 Demo capture, with external basemap requests blocked.
The older display labels remain as captured. No private account, restricted
input or connected persistence result appears in this image.*

1. Open the [starter map](https://demo.studio.opengeo.tools/?map=community-facilities)
   and choose **Catalog**. Find **Public community facilities**, choose
   **Review and add**, and read its source and rights information. Expected:
   five points identified as synthetic CC0 data. Choose **Cancel** to inspect
   without adding a second copy to the browser composition. No account-backed
   Project is created.
2. Select the facility Layer and choose **Layer → Open attribute table**.
   Expected: five rows, one each for health, resilience, education, logistics and
   services. Four rows have `public_access: true`; the supply hub has `false`.
3. Choose **Layer → Layer properties**, change the point symbol or opacity, and
   toggle the Layer's visibility. Expected: the display changes while the input's
   feature count and attributes stay the same. This introduces the difference
   between a data source and a presentation choice.
4. Choose **Save locally**, reload the starter map in the same browser, and check
   your saved presentation. Expected: a browser draft retained within the Demo's
   limits, subject to daily reset. Export important work through **Save as**;
   this action does not save to a Studio account or upload the input.
5. Write a short finding beside the map: “This synthetic input contains five
   facilities; four are marked as publicly accessible.” Include the input name,
   fictional status, count method and rights. That is the beginning of an
   analytical explanation; it is not an accepted native publication journey.

For a quick independent check from the repository root:

```bash
node --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
const data = JSON.parse(await readFile('app/src/data/sample-public-facilities.geojson', 'utf8'));
console.log({
  facilities: data.features.length,
  publicAccess: data.features.filter(feature => feature.properties.public_access === true).length,
  categories: [...new Set(data.features.map(feature => feature.properties.category))]
});
JS
```

Expected counts are **5 facilities** and **4 marked publicly accessible**, across
five categories. These checks describe only the supplied attributes. Coordinates
do not establish service coverage, capacity, opening hours, accessibility or
current conditions. A fictional verification date proves no verification took
place. For a real assessment, those are explicit information gaps.

See [the illustrated workflow](community-workflow.md) for the connected saving
and publication steps, including the remaining community acceptance limits.

## Existing hosted examples

These entry points are part of [our deployment](community-deployments.md).
They are existing reading and exploration examples, rather than complete
downloadable reproduction packages for independent installations.

| Example | Try or read | What it demonstrates and where interpretation stops |
| --- | --- | --- |
| [Synthetic starter map](https://demo.studio.opengeo.tools/?map=community-facilities) | Follow the exercise above; inspect attributes and adjust the display. | Small reusable Layer and browser draft. All observations are fictional; the original input and CC0 terms are linked above. |
| [MassGIS · MassEnviroScreen](https://demo.studio.opengeo.tools/?view=examples) | Choose **Explore MassGIS**, open an indicator and read its source and legend; compare the combined presentation. | Multiple presentations share a preserved input. Statewide block-group percentiles support screening; they do not establish parcel conditions, individual exposure or causation. Definitions, source edition, credit and recorded public-domain terms are in the [release configuration](../app/src/data/massgis-enviroscreen.json). The archive body is outside this repository. |
| [Map Folio](https://opengeo.tools/map-folio/) | Read the published maps and their explanations. | Map-based delivery on the public publication site. Consult each page's source and rights information; this gallery does not redistribute its inputs. |
| [Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/) | Compare the documented color, pattern and layout choices. | Cartographic guidance for readable outputs. A consistent Style supports interpretation but cannot establish the quality or suitability of the underlying data. |

## Practitioner exercises to contribute

These are proposed demonstrations. Their presence here does not claim that a
finished workflow, cleared input bundle or published result exists.

| Proposed exercise | Assessment question | Minimum reproducible contribution and present gap |
| --- | --- | --- |
| Berkshire infrastructure screening | Which environmental and community constraints warrant closer investigation near a defined asset? | Define a small asset/study extent, supply source/version links and redistribution terms, compose a few relevant Layers, and explain the distinction between screening and a site finding. A bounded input bundle and end-to-end exercise are still needed. |
| Nepal socioeconomic comparison | Can census and survey observations be compared across dates and boundaries? | Supply a redistribution-cleared aggregate sample, define geography, dates and denominators, show the comparison and document boundary/method differences. Existing Nepal work does not establish that this proposed comparison or its downloadable input package is complete. |
| Imagery investigation | How do source bands and processing choices change an interpretation? | Pin a small input with clear redistribution terms, distinguish analytical pixels from display imagery, record band/processing parameters, and explain resolution and observation-date limits. Existing imagery demonstrations do not supply this complete independent reproduction package. |

For each contribution, include downloadable inputs or a precise authorized
retrieval path, per-input terms and attribution, steps, expected results and a
short uncertainty discussion. Prefer small public or synthetic data; keep
restricted survey records and credentials outside the repository. Start with
[the contribution guide](../CONTRIBUTING.md) and identify one bounded
question before preparing data.
