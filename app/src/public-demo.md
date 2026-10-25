---
title: OpenGeo Studio demo
toc: false
---

# OpenGeo Studio demo

OpenGeo Studio, the geospatial workspace from OpenGeo.Tools.
An open workspace for geospatial analysis and publishing, optimized for
environmental and social baselines, risk analysis, impact assessment and monitoring.

Try useful GIS work without an account at
[demo.studio.opengeo.tools](https://demo.studio.opengeo.tools/).

Use the demo to open local GIS files, add public web layers, style and inspect
data, measure features, save and reopen a Project on this device, and export
supported outputs. Download a backup: browser storage can be cleared or evicted.
The demo does not share
authentication state, private project references, or managed uploads with
[OpenGeo Studio](https://studio.opengeo.tools/).

<a class="button" href="https://demo.studio.opengeo.tools/">Open the GIS workbench demo</a>

The community edition delivers the full suite of tools. See the
[source and deployment guides](https://github.com/categori-se/opengeo-community)
or [request limited free cloud beta access](mailto:akdennis@gmail.com).
Selected individuals and small teams need approval; beta duration, usage limits,
enabled workflows and team permissions are agreed before access. Existing members
can [sign in to Studio](https://studio.opengeo.tools/).

[Discuss future hosting, integration or GIS/E&S consultancy](https://www.linkedin.com/in/akdennis/).
These are provisional service options, with scope, availability and pricing agreed individually.
You can also visit [Aaron’s Observable forum profile](https://talk.observablehq.com/u/aaronkyle/activity).

[Open source & credits](/credits)

## Reusable NOAA map

This public map component is served by Studio without requiring a Studio login or
a running map server. Imagery and source-pixel requests go directly to NOAA.
The component never reads account state and never switches to archived imagery.
Use its **Source, analysis parameters & reusable embed** panel to copy the embed
or export a portable interactive HTML file. The exported controls are self-contained;
NOAA data still requires an internet connection.

```js
const imageryLabUrl = await FileAttachment("./assets/imagery-lab.js").url();
const imageryLabScript = document.createElement("script");
imageryLabScript.src = imageryLabUrl;
imageryLabScript.defer = true;
document.head.append(imageryLabScript);
const imageryLab = document.createElement("opengeo-imagery-lab");
imageryLab.setAttribute("mode", "spectral");
imageryLab.setAttribute("label", "NOAA 2004 coastal Connecticut · RGB / CIR");
display(imageryLab);
```
