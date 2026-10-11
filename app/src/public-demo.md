---
title: OpenGeo Studio demo
toc: false
---

# OpenGeo Studio demo

The anonymous GIS workbench now has its own isolated home at
`demo.studio.opengeo.tools`.

Use the demo to open local GIS files, add public web layers, style and inspect
data, measure features, and save a browser-only draft. The demo does not share
authentication state, private project references, or managed uploads with
[OpenGeo Studio](https://studio.opengeo.tools/).

<a class="button" href="https://demo.studio.opengeo.tools/">Open the GIS workbench demo</a>

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
