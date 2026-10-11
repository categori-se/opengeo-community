# OpenGeo builder cache seed

```js
import {html} from "npm:htl@1.0.0";
import * as d3 from "npm:d3@7.9.0";
// Match the existing Studio renderer and its verified package lock. This cache
// is prepared with the compiler image, never downloaded by a publication build.
import * as GeoTIFF from "npm:geotiff@3.1.0-beta.0";
import * as L from "npm:leaflet@1.9.4";
// Framework recognizes the bare import when adding Leaflet's CSS and icons.
import * as LeafletAssets from "npm:leaflet";
import maplibregl from "npm:maplibre-gl@5.20.2";
import FeatureService from "npm:mapbox-gl-arcgis-featureserver@0.0.8";
display(42);
const selected = view(Inputs.checkbox(["Survey"], {value:["Survey"]}));
display(Plot.plot({marks:[Plot.dot([[1, 1]])]}));
```
