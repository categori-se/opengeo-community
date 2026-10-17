import {test} from "node:test";
import assert from "node:assert/strict";
import {canClosePolygon, mapAuthoringPreview} from "../src/lib/mapAuthoringPreview.js";
import {editShapeVertex, shapeVertexGroups} from "../src/lib/shapeEditing.js";
import {panelExtent} from "../src/components/ResizablePanels.js";

test("drawing previews use individual vertices and a live pointer edge without changing the draft", () => {
  const draft = {kind: "Polygon", coordinates: [[0, 0], [10, 0]], hover: [10, 10]};
  const preview = mapAuthoringPreview(draft);
  assert.deepEqual(preview.features[0].geometry.coordinates, [0, 0]);
  assert.deepEqual(preview.features.find(({geometry}) => geometry.type === "LineString").geometry.coordinates, [[0, 0], [10, 0], [10, 10]]);
  assert.equal(draft.coordinates.length, 2);
  assert.deepEqual(mapAuthoringPreview(null).features, []);
});

test("polygon closure requires three vertices and uses screen pixels at any zoom", () => {
  const draft = {kind: "Polygon", coordinates: [[0, 0], [10, 0], [10, 10]], canClose: true};
  const project = ([x, y]) => ({x: x + 100, y: y + 100});
  assert.equal(canClosePolygon(draft, {x: 102, y: 100}, project), true);
  assert.equal(canClosePolygon(draft, {x: 108, y: 100}, project), false, "a closer later vertex must not close the ring");
  assert.equal(canClosePolygon(draft, {x: 120, y: 100}, project), false);
  assert.equal(canClosePolygon({...draft, coordinates: draft.coordinates.slice(0, 2)}, {x: 100, y: 100}, project), false);
  assert.equal(mapAuthoringPreview(draft).features[0].properties.close, true);
});

test("polygon origin hits require three distinct finite vertices and a visible origin", () => {
  const draft = {kind: "Polygon", coordinates: [[0, 0], [20, 0], [20, 20]]};
  const project = ([x, y]) => ({x: x * 10 + 100, y: y * 10 + 100});
  const viewport = {width: 800, height: 600};
  assert.equal(canClosePolygon(draft, {x: 112, y: 100}, project, 12, viewport), true);
  assert.equal(canClosePolygon(draft, {x: 113, y: 100}, project, 12, viewport), false);
  assert.equal(canClosePolygon({...draft, coordinates: [[0, 0], [20, 0], [20, 0]]}, {x: 100, y: 100}, project), false);
  assert.equal(canClosePolygon({...draft, coordinates: [[0, 0], [20, 0], [NaN, 20]]}, {x: 100, y: 100}, project), false);
  assert.equal(canClosePolygon(draft, {x: 100, y: 100}, () => ({x: Infinity, y: 100})), false);
  assert.equal(canClosePolygon(draft, {x: 0, y: 100}, ([x, y]) => ({x: x - 8, y: y + 100}), 12, viewport), false);
  assert.equal(canClosePolygon({...draft, kind: "LineString"}, {x: 100, y: 100}, project), false);
  const zoomed = ([x, y]) => ({x: x * 0.1 + 400, y: y * 0.1 + 300});
  assert.equal(canClosePolygon(draft, {x: 400, y: 300}, zoomed, 12, viewport), true);
  assert.equal(canClosePolygon(draft, {x: 402, y: 300}, zoomed, 12, viewport), false);
});

test("vertex editing preserves altitude, polygon closure, holes and the original geometry", () => {
  const geometry = {type: "Polygon", coordinates: [[[0, 0, 8], [10, 0, 8], [10, 10, 8], [0, 0, 8]], [[2, 2], [4, 2], [4, 4], [2, 2]]]};
  const edited = editShapeVertex(geometry, 0, 0, [-1, -1]);
  assert.deepEqual(edited.coordinates[0][0], [-1, -1, 8]);
  assert.deepEqual(edited.coordinates[0].at(-1), edited.coordinates[0][0]);
  assert.deepEqual(edited.coordinates[1], geometry.coordinates[1]);
  assert.deepEqual(geometry.coordinates[0][0], [0, 0, 8]);
  assert.throws(() => editShapeVertex(geometry, 0, 0, null, "delete"));
  const inserted = editShapeVertex(geometry, 0, 1, [10, 5], "insert");
  assert.equal(inserted.coordinates[0].length, 5);
  assert.equal(editShapeVertex(inserted, 0, 1, null, "delete").coordinates[0].length, 4);
});

test("points and multipart shapes retain their geometry structure", () => {
  const geometry = {type: "GeometryCollection", geometries: [{type: "MultiPoint", coordinates: [[1, 2], [3, 4]]}, {type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]]}]};
  assert.equal(shapeVertexGroups(geometry).length, 3);
  assert.deepEqual(editShapeVertex(geometry, 1, 0, [5, 6]).geometries[0].coordinates, [[1, 2], [5, 6]]);
  assert.throws(() => editShapeVertex(geometry, 2, 0, null, "delete"));
  assert.throws(() => editShapeVertex(geometry, 1, 0, [0, NaN]));
});

test("panel sizing reserves map space and remains bounded on small screens", () => {
  assert.equal(panelExtent(1000, 1440), 580);
  assert.equal(panelExtent(-20, 1440), 240);
  assert.equal(panelExtent(1000, 400, true), 300);
  assert.equal(panelExtent(0, 400, true), 140);
});
