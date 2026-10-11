import assert from "node:assert/strict";
import {test} from "node:test";
import {mapGraticule} from "../src/lib/mapGraticule.js";

for (const [name, bounds] of [
  ["world", [-180, -85, 180, 85]],
  ["street", [-71.1, 42.3, -71.09, 42.31]],
  ["date line", [179.5, -10, -179.5, 10]],
  ["wrapped world", [170, -80, 530, 80]],
  ["reversed latitude", [20, 50, 21, 40]],
  ["tiny extent", [12, 45, 12.0000001, 45.0000001]],
  ["invalid", [NaN, 0, 1, 2]],
  ["extreme", [1e300, 0, -1e300, 1]],
  ["null", null]
]) {
  test(`graticule is finite and bounded at ${name} scale`, () => {
    const grid = mapGraticule(bounds);
    assert.equal(grid.type, "FeatureCollection");
    assert.ok(grid.features.length > 0 && grid.features.length <= 30);
    for (const {geometry} of grid.features) {
      assert.ok(geometry.coordinates.length >= 2 && geometry.coordinates.length <= 73);
      geometry.coordinates.forEach(([lon, lat], index, coordinates) => {
        assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180);
        assert.ok(Number.isFinite(lat) && lat >= -85 && lat <= 85);
        if (index) assert.ok(Math.abs(lon - coordinates[index - 1][0]) <= 5.000001);
      });
    }
  });
}

test("street grid has both visible meridians and parallels", () => {
  const {features} = mapGraticule([-71.1, 42.3, -71.09, 42.31]);
  assert.ok(features.filter(({properties}) => properties.kind === "meridian").length >= 3);
  assert.ok(features.filter(({properties}) => properties.kind === "parallel").length >= 3);
});
