# Maps and published analysis

These publications show how maps, data and methods can work together in a
readable explanation. Open an example to explore its controls and follow the
source references.

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

## Explore environmental screening

The [MassGIS demonstration](https://demo.studio.opengeo.tools/?view=examples)
offers a different way to explore the workspace. Choose **Explore MassGIS**,
open an indicator and inspect its source and legend before comparing Layers.
MassEnviroScreen uses statewide block-group percentiles for screening. A high
percentile identifies a question for investigation; it does not establish
conditions on a particular parcel or an individual's exposure.

The [MassGIS configuration](../app/src/data/massgis-enviroscreen.json) records
indicator definitions, the source edition, attribution and public-domain terms.
The source archive is not included in this repository.

## Try it: community facilities

For a short interface exercise, open the [starter map](https://demo.studio.opengeo.tools/?map=community-facilities).
It contains five fictional facilities released under **CC0-1.0**, with a
[downloadable GeoJSON input](../app/src/data/sample-public-facilities.geojson)
and [source and rights record](../app/src/data/public-demo-catalog.json).
On GitHub, choose **Raw** to download the original input.

1. Open **Catalog**, find **Public community facilities** and choose **Review
   and add**. Read the source information, then choose **Cancel** to keep the
   existing composition.
2. Select the Layer and choose **Layer → Open attribute table**. There are five
   records; four have `public_access: true`.
3. Open **Layer → Layer properties**, change the point symbol or opacity, and
   toggle visibility. These choices change the presentation, not the input.
4. Choose **Save locally** to retain a browser draft. Use **Save as** to export a
   backup; Demo drafts are subject to daily reset.

The facility names, coordinates and verification dates are invented. The
exercise teaches inspection and styling, rather than assessment of a real
community. Its data license is separate from the software's Apache-2.0 license.

See the [workflow guide](community-workflow.md) for account-backed saving and
publication, and the [contribution guide](../CONTRIBUTING.md) to add a
worked example. Include source links or permitted downloads, reuse terms,
instructions and the result readers should expect.
