import assert from "node:assert/strict";
import {test} from "node:test";
import {geojsonBounds} from "../src/lib/mapLayers.js";

const ring = [[-72.5, 42], [-72.4, 42], [-72.4, 42.1], [-72.5, 42.1], [-72.5, 42]];

test("Fit uses the same local extent for either polygon winding without editing data", () => {
  for (const exterior of [ring, [...ring].reverse()]) {
    const polygon = {type: "Polygon", coordinates: [structuredClone(exterior)]};
    const original = JSON.stringify(polygon);
    assert.deepEqual(geojsonBounds(polygon), [[-72.5, 42], [-72.4, 42.1]]);
    assert.equal(JSON.stringify(polygon), original);
  }
});

test("collections, holes and multi-geometries retain their coordinate extents", () => {
  const feature = geometry => ({type: "Feature", properties: {}, geometry});
  const data = {type: "FeatureCollection", bbox: [-180, -90, 180, 90], features: [
    feature({type: "MultiPolygon", coordinates: [[ring, [[-72.48,42.02],[-72.46,42.02],[-72.46,42.04],[-72.48,42.02]]]]}),
    feature({type: "GeometryCollection", geometries: [
      {type: "Point", coordinates: [-73, 41, 200]},
      {type: "MultiLineString", coordinates: [[[-72,43],[-71,44]]]},
      {type: "MultiPoint", coordinates: [[-74,40],[-70,45]]}
    ]})
  ]};
  assert.deepEqual(geojsonBounds(data), [[-74, 40], [-70, 45]]);
});

test("empty or non-finite data does not produce a misleading extent", () => {
  for (const data of [null, {type:"Feature",geometry:null}, {type:"FeatureCollection",features:[]},
    {type:"Point",coordinates:[NaN,42]}, {type:"LineString",coordinates:[[0,0],[1,Infinity]]}]) {
    assert.equal(geojsonBounds(data), null);
  }
  assert.deepEqual(geojsonBounds({type:"Point",coordinates:[0,0]}), [[0,0],[0,0]]);
});

test("wide planar coordinates are not reinterpreted as a short spherical arc", () => {
  assert.deepEqual(geojsonBounds({type:"LineString",coordinates:[[-170,10],[170,20]]}), [[-170,10],[170,20]]);
});
