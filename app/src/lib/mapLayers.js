import {geoStream} from "d3";

export function geojsonBounds(geojson) {
  // MapLibre consumes planar GeoJSON. Spherical geoBounds interprets RFC 7946
  // exterior winding as the globe minus the polygon, making Fit zoom worldwide.
  // Stream positions without changing ring order or mutating source geometry.
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  let invalid = false;
  geoStream(geojson, {
    point(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) { invalid = true; return; }
      west = Math.min(west, x); east = Math.max(east, x);
      south = Math.min(south, y); north = Math.max(north, y);
    },
    lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {},
    sphere() { west = -180; south = -90; east = 180; north = 90; }
  });
  if (invalid) return null;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return [[west, south], [east, north]];
}

export function geometryPaint(geometryType) {
  if (geometryType === "GeometryCollection") {
    return ["Polygon", "LineString", "Point"].flatMap(type =>
      geometryPaint(type).map(layer => ({...layer, filter: ["==", ["geometry-type"], type]})));
  }
  if (geometryType === "Point" || geometryType === "MultiPoint") {
    return [
      {
        id: "preview-points",
        type: "circle",
        paint: {
          "circle-radius": 5,
          "circle-color": "#1769aa",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1
        }
      }
    ];
  }

  if (geometryType === "Polygon" || geometryType === "MultiPolygon") {
    return [
      {
        id: "preview-fill",
        type: "fill",
        paint: {"fill-color": "#287d52", "fill-opacity": 0.28}
      },
      {
        id: "preview-outline",
        type: "line",
        paint: {"line-color": "#1769aa", "line-width": 2}
      }
    ];
  }

  return [
    {
      id: "preview-lines",
      type: "line",
      paint: {"line-color": "#1769aa", "line-width": 3}
    }
  ];
}
