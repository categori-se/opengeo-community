---
title: Berkshire conservation designations in a retained MassGIS archive
toc: true
---

# Berkshire conservation designations in a retained MassGIS archive

Which Areas of Critical Environmental Concern appear in this historical Berkshire
County archive, and which municipalities are represented? This screening study
counts the designations and municipal records in a retained MassGIS-derived
GeoJSON. It provides a starting inventory for reviewing an environmental study;
it does not establish current legal boundaries or conditions at a property.

```js
import {summarizeArchive} from "./analysis.js";
const archive = await FileAttachment("./data/acecs.geojson").json();
const summary = summarizeArchive(archive);
```

```js
import {geoMercator, geoPath} from "npm:d3@7.9.0";
const mapWidth = 720;
const mapHeight = 480;
const projection = geoMercator().fitExtent([[20, 20], [mapWidth - 20, mapHeight - 20]], archive);
const path = geoPath(projection);
const colors = ["#3b8b75", "#8771a6", "#b57b38", "#4489a8", "#a45a72"];
const categoryOrder = [...summary.designations].sort((a, b) => b.recordCount - a.recordCount || a.name.localeCompare(b.name));
const colorById = new Map(categoryOrder.map((designation, index) => [designation.id, colors[index]]));
const figure = document.createElement("figure");
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
svg.setAttribute("role", "img");
svg.setAttribute("aria-label", "Five conservation designations in the historical Berkshire archive; Mercator projection, no basemap");
svg.style.cssText = "display:block;width:100%;max-height:480px;background:#f1f4f0;border:1px solid #b8c4bc;border-radius:6px";
for (const feature of archive.features) {
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path(feature));
  shape.setAttribute("fill", colorById.get(feature.properties.ACECID));
  shape.setAttribute("fill-opacity", "0.62");
  shape.setAttribute("stroke", "#344b49");
  shape.setAttribute("stroke-width", "1.25");
  const description = document.createElementNS(svg.namespaceURI, "title");
  description.textContent = `${feature.properties.NAME} — ${feature.properties.TOWN}`;
  shape.append(description);
  svg.append(shape);
}
const caption = document.createElement("figcaption");
caption.textContent = "Historical designation polygons, Mercator projection. Colors distinguish designations; they do not classify land cover or regulatory severity. Source: MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS.";
const legend = document.createElement("ul");
for (const designation of categoryOrder) {
  const item = document.createElement("li");
  const swatch = document.createElement("span");
  swatch.textContent = "■ ";
  swatch.style.color = colorById.get(designation.id);
  item.append(swatch, document.createTextNode(designation.name));
  legend.append(item);
}
figure.append(svg, caption, legend);
display(figure);
```

The archive contains **${summary.recordCount} municipal polygon records**,
representing **${summary.designationCount} distinct conservation designations**
and **${summary.municipalityCount} municipalities**. Designations are counted by
`ACECID`; municipalities are counted from distinct `TOWN` attributes. Multiple
records can describe the same designation.

## Designations and municipal context

The designation dates below are the archive's `DES_DATE` values. They describe
designation decisions, rather than the date when this GeoJSON was exported.

```js
function studyTable(caption, columns, rows) {
  const table = document.createElement("table");
  const title = table.createCaption();
  title.textContent = caption;
  const header = table.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column.title;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (const column of columns) {
      const value = row[column.key];
      line.insertCell().textContent = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return table;
}
```

```js
display(studyTable("Conservation designations in the retained archive", [
  {key: "id", title: "ACECID"},
  {key: "name", title: "Designation"},
  {key: "designationDate", title: "Designation date (month/day/year)"},
  {key: "recordCount", title: "Polygon records"},
  {key: "towns", title: "Municipalities named in the archive"}
], summary.designations));
```

## Municipality inventory

This table reports municipality attributes already present in the source. It
does not calculate a new spatial intersection or infer coverage from bounding
boxes. A municipality can contain records from more than one designation.

```js
display(studyTable("Municipal records by town", [
  {key: "town", title: "Municipality"},
  {key: "recordCount", title: "Polygon records"},
  {key: "designationCount", title: "Distinct designations"},
  {key: "designationIds", title: "ACECIDs"}
], summary.municipalities));
```

## Retained input and method

The input is the unchanged 284,185-byte file archived at
`berkshire.guide/maps/berkshires_acecs_poly.geojson`. Its SHA-256 is
`1a436462c200365cce9235e79815e1458aabb22d4add893057172817d2e9663f`.
The complete GeoJSON and the small analysis module travel with this page;
the calculation makes no remote data request. Download these files to inspect
or reuse the method:

```js
const downloadFiles = [
  ["Retained GeoJSON input", FileAttachment("./data/acecs.geojson")],
  ["Analysis module", FileAttachment("./analysis.js")],
  ["Provenance record", FileAttachment("./provenance.json")]
];
const downloadURLs = await Promise.all(downloadFiles.map(([, attachment]) => attachment.url()));
const studyDownloads = document.createElement("ul");
for (const [index, [title, attachment]] of downloadFiles.entries()) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = downloadURLs[index];
  link.download = attachment.name.split("/").at(-1);
  link.textContent = title;
  item.append(link);
  studyDownloads.append(item);
}
display(studyDownloads);
```

The method groups records by `ACECID`, checks that each group's name and
designation date agree, and collects distinct `TOWN` values. All original
properties and coordinates remain in the input. It does not add areas:
`POLY_ACRES` and `ACEC_ACRES` repeat designation-level values across municipal
records and would overstate area if summed.

## Source, rights and interpretation

Source credit: **MassGIS (Bureau of Geographic Information), Commonwealth of
Massachusetts EOTSS**. The historical local study identifies the Massachusetts
Natural Heritage and Endangered Species Program alongside MassGIS; archive
custody is recorded separately from provider authorship.

MassGIS's [source information](https://www.mass.gov/info-details/massgis-data-areas-of-critical-environmental-concern)
describes the dataset as planning information and directs users to the
designation documents for boundary interpretation. Its April 2009 edition
statement is provider context. The latest designation date observed in this file
is March 30, 2009. Neither establishes the export or capture date of these local
bytes, which remains unknown. The retained archive was listed in S3 with a
February 2, 2024 modification timestamp; that storage timestamp is not a survey
or data-observation date.

The [MassGIS FAQ](https://www.mass.gov/info-details/massgis-frequently-asked-questions)
states that MassGIS data is public domain. The
[MassGIS data guidance](https://www.mass.gov/info-details/learn-about-massgis-data)
permits redistribution and derived use with source credit. These are provider
determinations. This historical export has no separate file-level license
statement; it is not labeled CC0, and this example adds no license over the
underlying source. Preserve the source credit, provenance and limitations when
reusing it.

Use the results to locate records for further review. Do not interpret them as
current regulatory status, an official boundary determination, parcel-level
exposure, or a measured environmental impact. Consult current designation texts
and authoritative records before making a decision.
