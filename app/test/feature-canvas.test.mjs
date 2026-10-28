import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {fromGeojsonVt} from "@maplibre/vt-pbf";
import {VectorTile} from "@mapbox/vector-tile";
import Pbf from "pbf";

import {
  addGeometryPart,
  addPolygonHole,
  FeatureCanvas,
  canvasEditingSupported,
  commitVertexDragHistory,
  commitDraftHistory,
  createVertexDragSession,
  createDraftHistory,
  dragActivationExceeded,
  geometryFromCanvasClicks,
  geometryPartAtPosition,
  geometryPartCount,
  geometrySegments,
  geometryVertexHandles,
  geometryVertices,
  insertGeometryVertex,
  mergeTouchingLineParts,
  multiPolygonPartAtPosition,
  previewVertexDrag,
  redoDraftHistory,
  removeGeometryPart,
  removePolygonRing,
  removeGeometryVertex,
  replaceGeometryVertex,
  reorderGeometryPart,
  snapToGeometry,
  snapToNearestVertex,
  splitMultiLinePart,
  undoDraftHistory,
  validateMultiPolygonGeometry,
  validatePolygonGeometry,
  VERTEX_DRAG_HIT_DIAMETER
} from "../src/components/FeatureCanvas.js";

describe("governed feature canvas geometry", () => {
  it("captures bounded single and multipart geometry shapes", () => {
    assert.equal(canvasEditingSupported("Point"), true);
    assert.equal(canvasEditingSupported("MultiPoint"), true);
    assert.equal(canvasEditingSupported("LineString"), true);
    assert.equal(canvasEditingSupported("MultiLineString"), true);
    assert.equal(canvasEditingSupported("Polygon"), true);
    assert.equal(canvasEditingSupported("MultiPolygon"), true);
    assert.equal(canvasEditingSupported("GeometryCollection"), false);

    assert.deepEqual(geometryFromCanvasClicks("Point", [[-77, 39]]), {
      type: "Point",
      coordinates: [-77, 39]
    });
    assert.equal(geometryFromCanvasClicks("LineString", [[-77, 39]]), null);
    assert.deepEqual(geometryFromCanvasClicks("LineString", [[-77, 39], [-76, 40]]), {
      type: "LineString",
      coordinates: [[-77, 39], [-76, 40]]
    });
    assert.deepEqual(geometryFromCanvasClicks("MultiPoint", [[-77, 39]]), {
      type: "MultiPoint",
      coordinates: [[-77, 39]]
    });
    assert.deepEqual(geometryFromCanvasClicks("MultiLineString", [[-77, 39], [-76, 40]]), {
      type: "MultiLineString",
      coordinates: [[[-77, 39], [-76, 40]]]
    });
    assert.deepEqual(geometryFromCanvasClicks("MultiPolygon", [[0, 0], [2, 0], [1, 2]]), {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [2, 0], [1, 2], [0, 0]]]]
    });
    assert.equal(geometryFromCanvasClicks("Polygon", [[0, 0], [1, 0]]), null);
  });

  it("closes polygon captures without aliasing the first position", () => {
    const polygon = geometryFromCanvasClicks("Polygon", [[0, 0], [2, 0], [1, 2]]);

    assert.deepEqual(polygon, {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]]
    });
    assert.notEqual(polygon.coordinates[0][0], polygon.coordinates[0][3]);
  });

  it("adds immutable point, line, and disjoint polygon parts with a bounded authoring cap", () => {
    const point = {type: "MultiPoint", coordinates: [[0, 0]]};
    const line = {type: "MultiLineString", coordinates: [[[0, 0], [2, 0]]]};
    const polygon = {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]
    };

    const points = addGeometryPart(point, [[1, 1]]);
    const lines = addGeometryPart(line, [[3, 3], [4, 4], [5, 3]]);
    const polygons = addGeometryPart(polygon, [[20, 20], [30, 20], [30, 30], [20, 30]]);

    assert.deepEqual(point.coordinates, [[0, 0]]);
    assert.deepEqual(points.coordinates, [[0, 0], [1, 1]]);
    assert.deepEqual(lines.coordinates[1], [[3, 3], [4, 4], [5, 3]]);
    assert.deepEqual(polygons.coordinates[1][0], [
      [20, 20], [30, 20], [30, 30], [20, 30], [20, 20]
    ]);
    assert.equal(geometryPartCount(polygons), 2);
    assert.equal(validateMultiPolygonGeometry(polygons), true);
    assert.throws(() => addGeometryPart(point, [[1, 1], [2, 2]]), /one position/);
    assert.throws(() => addGeometryPart(line, [[1, 1]]), /at least two/);
    assert.throws(
      () => addGeometryPart({
        type: "MultiPoint",
        coordinates: Array.from({length: 256}, (_, index) => [index / 2, 0])
      }, [[0, 1]]),
      /at most 256 parts/
    );
    assert.throws(
      () => geometryPartCount({
        type: "MultiLineString",
        coordinates: [
          Array.from({length: 6000}, (_, index) => [index / 100, 0]),
          Array.from({length: 5000}, (_, index) => [index / 100, 1])
        ]
      }),
      /at most 10000 positions/
    );
  });

  it("rejects overlapping, touching, and nested polygon parts while allowing a part inside a hole", () => {
    const shell = {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]
    };
    assert.throws(
      () => addGeometryPart(shell, [[5, 5], [12, 5], [12, 12], [5, 12]]),
      /may not touch, overlap, or contain/
    );
    assert.throws(
      () => addGeometryPart(shell, [[10, 2], [12, 2], [12, 4], [10, 4]]),
      /may not touch, overlap, or contain/
    );
    assert.throws(
      () => addGeometryPart(shell, [[2, 2], [4, 2], [4, 4], [2, 4]]),
      /may not touch, overlap, or contain/
    );

    const withHole = addPolygonHole(shell, [[2, 2], [8, 2], [8, 8], [2, 8]], 0);
    const island = addGeometryPart(withHole, [[3, 3], [4, 3], [4, 4], [3, 4]]);
    assert.equal(validateMultiPolygonGeometry(island), true);
    assert.equal(geometryPartCount(island), 2);
  });

  it("locates polygon parts without treating holes or their boundaries as selectable interiors", () => {
    const geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
          [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
        ],
        [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]
      ]
    };

    assert.equal(multiPolygonPartAtPosition(geometry, [1, 1]), 0);
    assert.equal(multiPolygonPartAtPosition(geometry, [25, 25]), 1);
    assert.equal(multiPolygonPartAtPosition(geometry, [3, 3]), null);
    assert.equal(multiPolygonPartAtPosition(geometry, [2, 3]), null);
    assert.equal(multiPolygonPartAtPosition(geometry, [40, 40]), null);
  });

  it("selects the nearest point or line component in projected screen space", () => {
    const project = ([x, y]) => ({x: x * 10, y: y * 10});
    const points = {type: "MultiPoint", coordinates: [[0, 0], [10, 10], [20, 20]]};
    const lines = {
      type: "MultiLineString",
      coordinates: [[[0, 0], [5, 0]], [[10, 10], [15, 10]]]
    };

    assert.equal(geometryPartAtPosition(points, [9, 9], project), 1);
    assert.equal(geometryPartAtPosition(lines, [13, 9.8], project), 1);
    assert.equal(geometryPartAtPosition({type: "LineString", coordinates: [[0, 0], [1, 1]]}, [1, 1]), 0);
    assert.throws(() => geometryPartAtPosition(points, [0, 0], null), /projection is required/);
  });

  it("reorders and removes multipart components without mutating the input", () => {
    const points = {type: "MultiPoint", coordinates: [[0, 0], [1, 1], [2, 2]]};
    const lines = {
      type: "MultiLineString",
      coordinates: [[[0, 0], [1, 0]], [[10, 10], [11, 10]]]
    };
    const polygons = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
        [[[10, 10], [15, 10], [15, 15], [10, 15], [10, 10]]]
      ]
    };

    assert.deepEqual(reorderGeometryPart(points, 0, 2).coordinates, [[1, 1], [2, 2], [0, 0]]);
    assert.deepEqual(removeGeometryPart(lines, 0).coordinates, [[[10, 10], [11, 10]]]);
    assert.deepEqual(removeGeometryPart(polygons, 1).coordinates, [polygons.coordinates[0]]);
    assert.deepEqual(points.coordinates, [[0, 0], [1, 1], [2, 2]]);
    assert.throws(
      () => removeGeometryPart({type: "MultiPoint", coordinates: [[0, 0]]}, 0),
      /retain at least one part/
    );
    assert.throws(() => reorderGeometryPart(points, 0, 3), /target index is outside/);
    assert.throws(
      () => reorderGeometryPart({type: "LineString", coordinates: [[0, 0], [1, 1]]}, 0, 0),
      /only multipart/
    );
  });

  it("inserts and removes line and polygon vertices with closure and topology guards", () => {
    const line = {type: "LineString", coordinates: [[0, 0], [2, 0]]};
    const polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
    };
    const lines = {
      type: "MultiLineString",
      coordinates: [[[0, 0], [1, 0]], [[10, 10], [12, 10]]]
    };

    const insertedLine = insertGeometryVertex(line, 0, [1, 1]);
    const insertedPolygon = insertGeometryVertex(polygon, 3, [0, 1]);
    const insertedMultiLine = insertGeometryVertex(lines, 0, [11, 11], 0, 1);
    assert.deepEqual(insertedLine.coordinates, [[0, 0], [1, 1], [2, 0]]);
    assert.deepEqual(insertedPolygon.coordinates[0], [
      [0, 0], [2, 0], [2, 2], [0, 2], [0, 1], [0, 0]
    ]);
    assert.deepEqual(insertedMultiLine.coordinates[1], [[10, 10], [11, 11], [12, 10]]);
    assert.deepEqual(removeGeometryVertex(insertedLine, 1).coordinates, line.coordinates);
    assert.deepEqual(removeGeometryVertex(insertedPolygon, 4).coordinates, polygon.coordinates);
    assert.deepEqual(removeGeometryVertex(
      {type: "MultiPoint", coordinates: [[0, 0], [1, 1]]},
      0,
      0,
      1
    ).coordinates, [[0, 0]]);
    assert.deepEqual(line.coordinates, [[0, 0], [2, 0]]);
    assert.throws(() => insertGeometryVertex(line, 0, [0, 0]), /differ from both/);
    assert.throws(() => removeGeometryVertex(line, 0), /retain at least two/);
    assert.throws(
      () => removeGeometryVertex({
        type: "Polygon",
        coordinates: [[[0, 0], [2, 0], [1, 1], [0, 0]]]
      }, 0),
      /retain at least three/
    );
  });

  it("removes one polygon interior ring without mutating shells or sibling parts", () => {
    const polygon = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
        [[6, 6], [8, 6], [8, 8], [6, 8], [6, 6]]
      ]
    };
    const multiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        polygon.coordinates,
        [
          [[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]],
          [[22, 22], [24, 22], [24, 24], [22, 24], [22, 22]]
        ]
      ]
    };

    const oneHole = removePolygonRing(polygon, 1);
    const onePartHoleRemoved = removePolygonRing(multiPolygon, 1, 1);
    assert.equal(oneHole.coordinates.length, 2);
    assert.deepEqual(oneHole.coordinates[1], polygon.coordinates[2]);
    assert.equal(onePartHoleRemoved.coordinates[1].length, 1);
    assert.equal(onePartHoleRemoved.coordinates[0].length, 3);
    assert.equal(polygon.coordinates.length, 3);
    assert.equal(multiPolygon.coordinates[1].length, 2);
    assert.throws(() => removePolygonRing(polygon, 0), /exterior ring cannot be removed/);
    assert.throws(() => removePolygonRing(polygon, 3), /outside the geometry/);
    assert.throws(
      () => removePolygonRing({type: "LineString", coordinates: [[0, 0], [1, 1]]}, 1),
      /only polygon geometry/
    );
  });

  it("splits a multiline component only at an interior vertex", () => {
    const geometry = {
      type: "MultiLineString",
      coordinates: [
        [[0, 0], [1, 1], [2, 0], [3, 1]],
        [[10, 10], [11, 11]]
      ]
    };

    const changed = splitMultiLinePart(geometry, 0, 2);
    assert.deepEqual(changed.coordinates, [
      [[0, 0], [1, 1], [2, 0]],
      [[2, 0], [3, 1]],
      [[10, 10], [11, 11]]
    ]);
    assert.equal(geometry.coordinates.length, 2);
    assert.throws(() => splitMultiLinePart(geometry, 0, 0), /only at an interior vertex/);
    assert.throws(() => splitMultiLinePart(geometry, 1, 1), /only at an interior vertex/);
    assert.throws(
      () => splitMultiLinePart({type: "LineString", coordinates: [[0, 0], [1, 1], [2, 2]]}, 0, 1),
      /only MultiLineString/
    );
  });

  it("merges exactly two line parts that share one endpoint", () => {
    const geometry = {
      type: "MultiLineString",
      coordinates: [
        [[0, 0], [1, 0]],
        [[2, 0], [1, 0]],
        [[10, 10], [11, 11]]
      ]
    };

    const changed = mergeTouchingLineParts(geometry, 0, 1);
    assert.deepEqual(changed.coordinates, [
      [[0, 0], [1, 0], [2, 0]],
      [[10, 10], [11, 11]]
    ]);
    assert.deepEqual(mergeTouchingLineParts({
      type: "MultiLineString",
      coordinates: [[[0, 0], [1, 0]], [[1, 0], [2, 0]]]
    }, 0, 1).coordinates[0], [[0, 0], [1, 0], [2, 0]]);
    assert.deepEqual(mergeTouchingLineParts({
      type: "MultiLineString",
      coordinates: [[[1, 0], [0, 0]], [[1, 0], [2, 0]]]
    }, 0, 1).coordinates[0], [[2, 0], [1, 0], [0, 0]]);
    assert.deepEqual(mergeTouchingLineParts({
      type: "MultiLineString",
      coordinates: [[[1, 0], [0, 0]], [[2, 0], [1, 0]]]
    }, 0, 1).coordinates[0], [[2, 0], [1, 0], [0, 0]]);
    assert.equal(geometry.coordinates.length, 3);
    assert.throws(() => mergeTouchingLineParts(geometry, 0, 2), /share exactly one endpoint/);
    assert.throws(() => mergeTouchingLineParts(geometry, 0, 0), /two distinct/);
    assert.throws(
      () => mergeTouchingLineParts({
        type: "MultiLineString",
        coordinates: [[[0, 0], [1, 0]], [[0, 0], [1, 0]]]
      }, 0, 1),
      /share exactly one endpoint/
    );
  });

  it("moves a selected vertex while preserving immutable input and ring closure", () => {
    const original = {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]]
    };
    const changed = replaceGeometryVertex(original, 0, [-1, -1]);

    assert.deepEqual(original.coordinates[0][0], [0, 0]);
    assert.deepEqual(changed.coordinates[0][0], [-1, -1]);
    assert.deepEqual(changed.coordinates[0][3], [-1, -1]);
    assert.deepEqual(geometryVertices(changed), [[-1, -1], [2, 0], [1, 2]]);
  });

  it("rejects invalid coordinates and vertex indexes before browser mutation", () => {
    assert.throws(() => geometryFromCanvasClicks("Point", [[181, 0]]), /invalid WGS84/);
    assert.throws(
      () => replaceGeometryVertex({type: "LineString", coordinates: [[0, 0], [1, 1]]}, 2, [2, 2]),
      /outside the geometry/
    );
  });

  it("snaps to the nearest vertex only inside a bounded screen-pixel tolerance", () => {
    const project = ([longitude, latitude]) => ({
      x: longitude * 100,
      y: latitude * -100
    });
    const candidates = [[-71.1, 42.3], [-70, 41]];

    assert.deepEqual(
      snapToNearestVertex([-71.04, 42.34], candidates, project, 8),
      [-71.1, 42.3]
    );
    assert.equal(
      snapToNearestVertex([-71.04, 42.34], candidates, project, 5),
      null
    );
    assert.deepEqual(candidates, [[-71.1, 42.3], [-70, 41]]);
  });

  it("rejects invalid snapping projections and unbounded tolerances", () => {
    assert.throws(
      () => snapToNearestVertex([0, 0], [[1, 1]], () => ({x: Number.NaN, y: 0})),
      /invalid projected snap position/
    );
    assert.throws(
      () => snapToNearestVertex([0, 0], [], () => ({x: 0, y: 0}), 100),
      /outside the supported range/
    );
  });

  it("requires a bounded screen-pixel movement before a click becomes a drag", () => {
    assert.equal(VERTEX_DRAG_HIT_DIAMETER, 44);
    assert.equal(dragActivationExceeded({x: 10, y: 10}, {x: 12, y: 12}), false);
    assert.equal(dragActivationExceeded({x: 10, y: 10}, {x: 13, y: 10}), true);
    assert.throws(
      () => dragActivationExceeded({x: 0, y: 0}, {x: 1, y: 1}, 25),
      /outside the supported range/
    );
    assert.throws(
      () => dragActivationExceeded({x: 0, y: 0}, {x: Number.NaN, y: 1}),
      /invalid projected snap position/
    );
  });

  it("extracts immutable line and closed-polygon segments", () => {
    const line = {type: "LineString", coordinates: [[0, 0], [2, 0], [2, 2]]};
    const polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]]
    };

    assert.deepEqual(geometrySegments(line), [
      {start: [0, 0], end: [2, 0], partIndex: 0, ringIndex: 0, startVertexIndex: 0, endVertexIndex: 1},
      {start: [2, 0], end: [2, 2], partIndex: 0, ringIndex: 0, startVertexIndex: 1, endVertexIndex: 2}
    ]);
    assert.deepEqual(geometrySegments(polygon).at(-1), {
      start: [1, 2],
      end: [0, 0],
      partIndex: 0,
      ringIndex: 0,
      startVertexIndex: 2,
      endVertexIndex: 0
    });
    assert.deepEqual(line.coordinates, [[0, 0], [2, 0], [2, 2]]);
    assert.throws(
      () => geometrySegments({type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [2, 2]]]}),
      /must be closed/
    );
  });

  it("adds a strictly contained polygon hole without mutating the outer ring", () => {
    const original = {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
    };
    const changed = addPolygonHole(original, [[2, 2], [4, 2], [4, 4], [2, 4]]);

    assert.equal(validatePolygonGeometry(changed), true);
    assert.equal(original.coordinates.length, 1);
    assert.deepEqual(changed.coordinates[1], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]);
    assert.notEqual(changed.coordinates[1][0], changed.coordinates[1].at(-1));
  });

  it("rejects self-crossing, exterior, touching, overlapping, and nested holes", () => {
    const polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
    };
    assert.throws(
      () => addPolygonHole(polygon, [[2, 2], [8, 8], [2, 8], [8, 2]]),
      /no area|crosses or touches itself/
    );
    assert.throws(
      () => addPolygonHole(polygon, [[8, 8], [12, 8], [12, 9], [8, 9]]),
      /strictly inside/
    );
    assert.throws(
      () => addPolygonHole(polygon, [[0, 2], [2, 2], [2, 4], [0, 4]]),
      /strictly inside|touch or cross/
    );
    const oneHole = addPolygonHole(polygon, [[2, 2], [8, 2], [8, 8], [2, 8]]);
    assert.throws(
      () => addPolygonHole(oneHole, [[4, 4], [6, 4], [6, 6], [4, 6]]),
      /contain one another/
    );
    assert.throws(
      () => addPolygonHole(oneHole, [[7, 7], [9, 7], [9, 9], [7, 9]]),
      /touch, overlap, or contain/
    );
  });

  it("enumerates and moves vertices in every polygon ring with topology protection", () => {
    const polygon = addPolygonHole(
      {type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
      [[2, 2], [4, 2], [4, 4], [2, 4]]
    );
    const handles = geometryVertexHandles(polygon);
    const moved = replaceGeometryVertex(polygon, 0, [1, 1], 1);

    assert.equal(handles.length, 8);
    assert.deepEqual(handles.at(-1), {
      coordinates: [2, 4],
      partIndex: 0,
      ringIndex: 1,
      vertexIndex: 3
    });
    assert.deepEqual(moved.coordinates[1][0], [1, 1]);
    assert.deepEqual(moved.coordinates[1].at(-1), [1, 1]);
    assert.equal(geometrySegments(moved).filter(({ringIndex}) => ringIndex === 1).length, 4);
    assert.throws(
      () => replaceGeometryVertex(polygon, 0, [-1, -1], 1),
      /strictly inside/
    );
  });

  it("preserves part, ring, and vertex identity across every multipart geometry", () => {
    const points = {type: "MultiPoint", coordinates: [[0, 0], [2, 2]]};
    const lines = {
      type: "MultiLineString",
      coordinates: [[[0, 0], [1, 0]], [[10, 10], [11, 10], [12, 12]]]
    };
    const polygons = {
      type: "MultiPolygon",
      coordinates: [
        [[[-10, -10], [-2, -10], [-2, -2], [-10, -2], [-10, -10]]],
        [
          [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]],
          [[12, 12], [14, 12], [14, 14], [12, 14], [12, 12]]
        ]
      ]
    };

    assert.deepEqual(geometryVertexHandles(points).at(-1), {
      coordinates: [2, 2], partIndex: 1, ringIndex: 0, vertexIndex: 0
    });
    assert.deepEqual(geometryVertexHandles(lines).at(-1), {
      coordinates: [12, 12], partIndex: 1, ringIndex: 0, vertexIndex: 2
    });
    assert.deepEqual(geometryVertexHandles(polygons).at(-1), {
      coordinates: [12, 14], partIndex: 1, ringIndex: 1, vertexIndex: 3
    });
    assert.equal(geometrySegments(lines).filter(({partIndex}) => partIndex === 1).length, 2);
    assert.equal(
      geometrySegments(polygons).filter(({partIndex, ringIndex}) => partIndex === 1 && ringIndex === 1).length,
      4
    );

    const movedPoint = replaceGeometryVertex(points, 0, [3, 3], 0, 1);
    const movedLine = replaceGeometryVertex(lines, 1, [11, 11], 0, 1);
    const movedPolygon = replaceGeometryVertex(polygons, 0, [11, 11], 1, 1);
    assert.deepEqual(movedPoint.coordinates[1], [3, 3]);
    assert.deepEqual(movedLine.coordinates[1][1], [11, 11]);
    assert.deepEqual(movedPolygon.coordinates[1][1][0], [11, 11]);
    assert.deepEqual(movedPolygon.coordinates[1][1].at(-1), [11, 11]);
    assert.deepEqual(polygons.coordinates[1][1][0], [12, 12]);
  });

  it("adds a hole to an explicitly selected MultiPolygon part", () => {
    const original = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
        [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]
      ]
    };
    const changed = addPolygonHole(original, [[22, 22], [24, 22], [24, 24], [22, 24]], 1);

    assert.equal(original.coordinates[1].length, 1);
    assert.equal(changed.coordinates[0].length, 1);
    assert.equal(changed.coordinates[1].length, 2);
    assert.deepEqual(changed.coordinates[1][1], [
      [22, 22], [24, 22], [24, 24], [22, 24], [22, 22]
    ]);
    assert.throws(
      () => addPolygonHole(original, [[22, 22], [24, 22], [24, 24]], 2),
      /part index is outside/
    );
  });

  it("snaps to vertices, segment interiors, and crossings by explicit mode", () => {
    const project = ([longitude, latitude]) => ({x: longitude * 10, y: latitude * 10});
    const unproject = ({x, y}) => [x / 10, y / 10];
    const candidates = [
      {id: "horizontal", geometry: {type: "LineString", coordinates: [[0, 5], [10, 5]]}},
      {id: "vertical", geometry: {type: "LineString", coordinates: [[5, 0], [5, 10]]}}
    ];

    assert.deepEqual(
      snapToGeometry([-0.2, 5.1], candidates, project, unproject, {
        mode: "intersection",
        tolerancePixels: 4
      }),
      {kind: "vertex", position: [0, 5], distancePixels: Math.sqrt(5)}
    );
    assert.deepEqual(
      snapToGeometry([7, 5.2], candidates, project, unproject, {
        mode: "segment",
        tolerancePixels: 4
      }),
      {kind: "segment", position: [7, 5], distancePixels: 2}
    );
    assert.deepEqual(
      snapToGeometry([5.1, 5.2], candidates, project, unproject, {
        mode: "intersection",
        tolerancePixels: 4
      }),
      {kind: "intersection", position: [5, 5], distancePixels: Math.sqrt(5)}
    );
    assert.equal(
      snapToGeometry([5.1, 5.2], candidates, project, unproject, {
        mode: "vertex",
        tolerancePixels: 4
      }),
      null
    );
  });

  it("excludes a moved vertex and its incident segments from self-snapping", () => {
    const project = ([longitude, latitude]) => ({x: longitude * 10, y: latitude * 10});
    const unproject = ({x, y}) => [x / 10, y / 10];
    const candidates = [{
      id: "selected",
      geometry: {type: "LineString", coordinates: [[0, 0], [5, 0], [10, 0]]}
    }];

    assert.equal(
      snapToGeometry([5, 0.1], candidates, project, unproject, {
        mode: "intersection",
        tolerancePixels: 4,
        excludedFeatureId: "selected",
        excludedVertexIndex: 1
      }),
      null
    );
    assert.throws(
      () => snapToGeometry([0, 0], candidates, project, null, {mode: "segment"}),
      /inverse projection/
    );
  });

  it("scopes self-snap exclusions to the selected polygon ring", () => {
    const project = ([longitude, latitude]) => ({x: longitude * 10, y: latitude * 10});
    const unproject = ({x, y}) => [x / 10, y / 10];
    const polygon = addPolygonHole(
      {type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
      [[4, 4], [6, 4], [6, 6], [4, 6]]
    );
    const candidates = [{id: "selected", geometry: polygon}];

    assert.equal(
      snapToGeometry([6, 4.1], candidates, project, unproject, {
        mode: "vertex",
        tolerancePixels: 4,
        excludedFeatureId: "selected",
        excludedRingIndex: 1,
        excludedVertexIndex: 1
      }),
      null
    );
    assert.deepEqual(
      snapToGeometry([6, 4.1], candidates, project, unproject, {
        mode: "vertex",
        tolerancePixels: 4,
        excludedFeatureId: "selected",
        excludedRingIndex: 0,
        excludedVertexIndex: 1
      }),
      {kind: "vertex", position: [6, 4], distancePixels: 1}
    );
  });

  it("scopes self-snap exclusions to a multipart component", () => {
    const project = ([longitude, latitude]) => ({x: longitude * 10, y: latitude * 10});
    const candidate = [{
      id: "selected",
      geometry: {type: "MultiPoint", coordinates: [[0, 0], [1, 1]]}
    }];

    const remainingPart = snapToGeometry([1, 1.01], candidate, project, null, {
      mode: "vertex",
      tolerancePixels: 0.2,
      excludedFeatureId: "selected",
      excludedPartIndex: 0,
      excludedVertexIndex: 0
    });
    assert.equal(remainingPart.kind, "vertex");
    assert.deepEqual(remainingPart.position, [1, 1]);
    assert.ok(Math.abs(remainingPart.distancePixels - 0.1) < 1e-9);
    assert.equal(
      snapToGeometry([1, 1.01], candidate, project, null, {
        mode: "vertex",
        tolerancePixels: 0.2,
        excludedFeatureId: "selected",
        excludedPartIndex: 1,
        excludedVertexIndex: 0
      }),
      null
    );
  });

  it("keeps a bounded immutable multi-step undo and redo history", () => {
    let history = createDraftHistory({geometry: {type: "Point", coordinates: [0, 0]}}, 2);
    const original = structuredClone(history);
    history = commitDraftHistory(history, {geometry: {type: "Point", coordinates: [1, 1]}});
    history = commitDraftHistory(history, {geometry: {type: "Point", coordinates: [2, 2]}});
    history = commitDraftHistory(history, {geometry: {type: "Point", coordinates: [3, 3]}});

    assert.deepEqual(original.present.geometry.coordinates, [0, 0]);
    assert.equal(history.past.length, 2);
    history = undoDraftHistory(history);
    assert.deepEqual(history.present.geometry.coordinates, [2, 2]);
    history = undoDraftHistory(history);
    assert.deepEqual(history.present.geometry.coordinates, [1, 1]);
    assert.equal(undoDraftHistory(history), history);
    history = redoDraftHistory(history);
    assert.deepEqual(history.present.geometry.coordinates, [2, 2]);
    assert.equal(history.future.length, 1);
    history = commitDraftHistory(history, {geometry: {type: "Point", coordinates: [4, 4]}});
    assert.equal(history.future.length, 0);
    assert.throws(() => createDraftHistory({}, 101), /outside the supported range/);
  });

  it("previews many drag positions but commits one clone-isolated history state", () => {
    const geometry = {type: "LineString", coordinates: [[0, 0], [5, 0], [10, 0]]};
    let session = createVertexDragSession(geometry, 1);
    session = previewVertexDrag(session, [5, 1]);
    session = previewVertexDrag(session, [5, 2]);
    const history = createDraftHistory({
      kind: "selected",
      featureId: "feature-1",
      geometry
    });
    const committed = commitVertexDragHistory(history, session, "feature-1");

    assert.deepEqual(geometry.coordinates[1], [5, 0]);
    assert.deepEqual(session.originalGeometry.coordinates[1], [5, 0]);
    assert.deepEqual(session.geometry.coordinates[1], [5, 2]);
    assert.equal(committed.past.length, 1);
    assert.deepEqual(committed.present.geometry.coordinates[1], [5, 2]);
    assert.deepEqual(undoDraftHistory(committed).present.geometry.coordinates[1], [5, 0]);
  });

  it("drags a vertex in one multipart component without changing its siblings", () => {
    const geometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
        [[[10, 10], [15, 10], [15, 15], [10, 15], [10, 10]]]
      ]
    };
    const original = structuredClone(geometry);
    const session = previewVertexDrag(createVertexDragSession(geometry, 0, 0, 1), [9, 9]);

    assert.equal(session.partIndex, 1);
    assert.deepEqual(session.geometry.coordinates[0], original.coordinates[0]);
    assert.deepEqual(session.geometry.coordinates[1][0][0], [9, 9]);
    assert.deepEqual(session.geometry.coordinates[1][0].at(-1), [9, 9]);
    assert.deepEqual(geometry, original);
  });

  it("rejects invalid drag topology and does not commit a stationary handle", () => {
    const polygon = addPolygonHole(
      {type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
      [[2, 2], [4, 2], [4, 4], [2, 4]]
    );
    const session = createVertexDragSession(polygon, 0, 1);
    const history = createDraftHistory({
      kind: "selected",
      featureId: "feature-1",
      geometry: polygon
    });

    assert.throws(() => previewVertexDrag(session, [-1, -1]), /strictly inside/);
    assert.equal(commitVertexDragHistory(history, session, "feature-1"), history);
    assert.throws(() => commitVertexDragHistory(history, {...session, changed: true}, "feature-1"), /session is invalid/);
    assert.throws(() => createVertexDragSession(polygon, 99, 1), /outside the geometry/);
  });
});

// Exercise the real canvas event handler and existing geometry validator/finish path.
describe("polygon origin click completion", () => {
  it("closes once from the actual screen hit without appending another point", () => withCanvas("Polygon", ({map, button, changes}) => {
    button("Draw new").click();
    map.click([0, 0]);map.click([20, 0]);map.click([20, 20]);
    map.click([80, 80], {x: 108, y: 100});
    assert.deepEqual(changes, [{type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 20], [0, 0]]]}]);
    map.click([0, 0]);
    assert.equal(changes.length, 1);
    assert.equal(map.cameraChanges, 0);
  }));

  it("retains invalid drafts for undo and keeps other-vertex clicks, cancel and paths distinct", () => {
    withCanvas("Polygon", ({map, button, changes, root}) => {
      button("Draw new").click();
      map.click([0, 0]);map.click([20, 0]);map.click([20, 20]);
      map.click([20, 0]);
      assert.equal(changes.length, 0, "a later vertex is not the closing control");
      button("Cancel canvas edit").click();
      button("Draw new").click();
      map.click([0, 0]);map.click([20, 0]);map.click([20, 0]);map.click([0, 0]);
      assert.equal(changes.length, 0, "three distinct vertices are required");
      button("Cancel canvas edit").click();button("Draw new").click();
      map.click([0, 0]);map.click([20, 20]);map.click([0, 20]);map.click([20, 0]);
      map.click([0, 0]);
      assert.equal(changes.length, 0);
      assert.match(root.textContent, /geometry is not valid/);
      button("Undo").click();map.click([0, 0]);
      assert.equal(changes.length, 1, "undo repairs the retained draft before the same finish path runs");
      assert.equal(changes[0].coordinates[0].length, 4);
    });
    withCanvas("LineString", ({map, button, changes}) => {
      button("Draw new").click();map.click([0, 0]);map.click([20, 0]);map.click([20, 20]);map.click([0, 0]);
      assert.equal(changes.length, 0);
      button("Finish geometry").click();assert.equal(changes[0].type, "LineString");
      assert.equal(changes[0].coordinates.length, 4);
    });
  });
});

describe("saved polygon cut drawing", () => {
  const feature = () => ({
    id: "saved-polygon", version: 7, properties: {name: "Original"}, bbox: [0, 0, 15, 15],
    geometry: {type: "MultiPolygon", coordinates: [
      [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
      [[[10, 10], [15, 10], [15, 15], [10, 15], [10, 10]]]
    ]}
  });

  it("discloses unavailable cutting and requires a saved selected multipolygon", () => {
    withCanvas("MultiPolygon", ({root, button}) => {
      root.selectFeature(feature());
      assert.equal(button("Cut polygon").disabled, true);
      assert.match(button("Cut polygon").title, /unavailable/);
    });
    withCanvas("MultiPolygon", ({root, button}) => {
      assert.equal(button("Cut polygon").disabled, true);
      root.selectFeature(feature());
      assert.equal(button("Cut polygon").disabled, false);
    }, {onCutLine() {}});
  });

  it("draws and applies a cut for a saved Polygon without changing its geometry type or properties", async () => {
    const original = {...feature(), id: "4befca90-0ae1-40a5-b66f-81190e64c5ee",
      geometry: {type: "Polygon", coordinates: [
        [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]],
        [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]
      ]}};
    const before = structuredClone(original), calls = [];
    await withCanvas("Polygon", async ({root, map, button, changes}) => {
      assert.equal(button("Cut polygon").disabled, true);
      map.renderedFeatures = [{id: original.id, properties: {"opengeo:featureId": original.id}}];
      button("Select feature").click();map.click([4, 4]);
      assert.equal(button("Cut polygon").disabled, false);
      assert.equal([...root.querySelectorAll("button")].some(control => /^Part /.test(control.textContent)), false);
      button("Cut polygon").click();
      assert.match(root.textContent, /open line across the polygon/);
      assert.doesNotMatch(root.textContent, /polygon part|untouched parts/);
      map.click([-1, 3]);map.click([6, 3]);
      assert.equal(calls.length, 0, "drawing the preview does not persist a cut");
      assert.deepEqual(map.sources.get("opengeo-feature-draft").data.features[0].geometry,
        {type: "LineString", coordinates: [[-1, 3], [6, 3]]});
      assert.deepEqual(map.sources.get("opengeo-authoritative-features").data.features[0].geometry, original.geometry);
      button("Undo").click();assert.equal(button("Apply cut").disabled, true);
      button("Redo").click();button("Apply cut").click();
      assert.deepEqual(calls, [{feature: original, partIndex: 0,
        cutLine: {type: "LineString", coordinates: [[-1, 3], [6, 3]]}}]);
      await Promise.resolve();await Promise.resolve();
      assert.match(root.textContent, /Cut saved/);
      assert.equal(changes.length, 0, "cut drawing never replaces the Polygon form draft");
      assert.deepEqual(original, before);
    }, {features: [original], onCutLine: payload => calls.push(payload)});
  });

  it("requires finishing active capture and saving geometry edits before a cut", () => {
    withCanvas("MultiPolygon", ({root, map, button, changes}) => {
      root.selectFeature(feature());button("Add hole").click();
      assert.equal(button("Cut polygon").disabled, true);
      map.click([1, 1]);map.click([3, 1]);map.click([2, 3]);button("Finish geometry").click();
      assert.equal(changes.length, 1);
      button("Cut polygon").click();
      assert.match(root.textContent, /Save the geometry draft or reselect/);
      assert.equal(button("Finish geometry").textContent, "Finish geometry");
    }, {onCutLine() {assert.fail("An unsaved geometry cannot be cut");}});
  });

  it("selects the original UUID and second polygon part after the actual tile codec coerces its id", async () => {
    const original = {...feature(), id: "4befca90-0ae1-40a5-b66f-81190e64c5ee"};
    original.properties["opengeo:featureId"] = "untrusted-input-property";
    const selections = [], cuts = [];
    await withCanvas("MultiPolygon", async ({map, button, changes}) => {
      const source = map.sources.get("opengeo-authoritative-features");
      assert.equal(source.promoteId, "opengeo:featureId");
      const display = source.data.features[0];
      assert.equal(display.properties["opengeo:featureId"], original.id);
      assert.equal(original.properties["opengeo:featureId"], "untrusted-input-property",
        "display identity does not mutate persisted properties");
      const encoded = fromGeojsonVt({features: {features: [{id: display.id, type: 3,
        geometry: display.geometry.coordinates.flat(), tags: display.properties}]}});
      const rendered = new VectorTile(new Pbf(encoded)).layers.features.feature(0);
      assert.equal(rendered.id, 4, "the installed production encoder coerces the UUID");
      assert.equal(rendered.properties["opengeo:featureId"], original.id);
      map.renderedFeatures = [rendered];
      button("Select feature").click();map.click([12, 12]);
      assert.deepEqual(selections, [original]);
      assert.equal(button("Part 2/2").disabled, false);
      button("Cut polygon").click();map.click([9, 12]);map.click([16, 12]);
      button("Apply cut").click();
      assert.equal(cuts.length, 1);
      assert.equal(cuts[0].feature.id, original.id);
      assert.equal(cuts[0].feature.version, 7);
      assert.equal(cuts[0].partIndex, 1);
      assert.deepEqual(cuts[0].feature.properties, original.properties);
      assert.equal(changes.length, 0);
      await Promise.resolve();
    }, {features: [original], onSelectFeature: selected => selections.push(selected),
      onCutLine: payload => cuts.push(payload)});
  });

  it("keeps an arbitrary open line in its own undo history until explicit versioned apply", async () => {
    let resolveCut;
    const calls = [];
    await withCanvas("MultiPolygon", async ({root, map, button, changes}) => {
      const selected = feature();
      root.selectFeature(selected);
      button("Part 1/2").click();
      button("Cut polygon").click();
      assert.equal(button("Apply cut").disabled, true);
      assert.equal(button("Part 2/2").disabled, true);
      assert.match(root.textContent, /polygon part 2/);
      assert.match(root.textContent, /largest piece.*identity.*untouched parts/s);
      map.click([8, 12]);map.click([12, 11]);map.click([17, 12]);
      assert.equal(calls.length, 0);
      assert.equal(changes.length, 0);
      assert.deepEqual(map.sources.get("opengeo-feature-draft").data.features[0].geometry,
        {type: "LineString", coordinates: [[8, 12], [12, 11], [17, 12]]});
      map.click([8, 12]);
      assert.equal(calls.length, 0, "clicking the line origin cannot apply a cut");
      assert.equal(map.sources.get("opengeo-feature-draft").data.features[0].geometry.type, "LineString");
      button("Undo").click();
      button("Undo").click();button("Redo").click();
      assert.equal(changes.length, 0, "cut vertex history does not replace the geometry form");
      button("Apply cut").click();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {feature: selected, partIndex: 1,
        cutLine: {type: "LineString", coordinates: [[8, 12], [12, 11], [17, 12]]}});
      assert.notEqual(calls[0].feature, selected);
      assert.equal(button("Apply cut").disabled, true);
      assert.equal(button("Cancel canvas edit").disabled, true);
      map.click([18, 12]);button("Apply cut").click();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cutLine.coordinates.length, 3);
      resolveCut();await Promise.resolve();await Promise.resolve();
      assert.match(root.textContent, /Cut saved/);
      assert.equal(changes.length, 0);
    }, {onCutLine: payload => {calls.push(payload);return new Promise(resolve => {resolveCut = resolve;});}});
  });

  it("cancels only cut vertices, retains the selected feature, and enforces the coordinate bound", () => {
    let calls = 0;
    withCanvas("MultiPolygon", ({root, map, button, changes}) => {
      root.selectFeature(feature());button("Cut polygon").click();
      for (let index = 0; index < 257; index++) map.click([index / 100, 2]);
      assert.equal(map.sources.get("opengeo-feature-draft").data.features[0].geometry.coordinates.length, 256);
      assert.match(root.textContent, /at most 256/);
      button("Cancel canvas edit").click();
      assert.equal(calls, 0);assert.equal(changes.length, 0);
      assert.equal(map.sources.get("opengeo-feature-draft").data.features.length, 0);
      assert.equal(button("Cut polygon").disabled, false);
      assert.equal(button("Undo").disabled, true);
      button("Cut polygon").click();map.click([0, 2]);map.click([5, 2]);
      root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
      assert.match(root.textContent, /Cut line discarded/);
    }, {onCutLine() {calls++;}});
  });

  it("retains a failed cut for correction and ignores stale completion after selection or disposal", async () => {
    let rejectCut;
    await withCanvas("MultiPolygon", async ({root, map, button}) => {
      root.selectFeature(feature());button("Cut polygon").click();map.click([0, 2]);map.click([5, 2]);
      button("Apply cut").click();rejectCut(new Error("feature_version_conflict"));
      await Promise.resolve();await Promise.resolve();
      assert.match(root.textContent, /draft line is retained/);
      assert.match(root.textContent, /The cut was not applied: feature_version_conflict/);
      assert.equal(button("Apply cut").disabled, false);
      button("Undo").click();assert.equal(button("Apply cut").disabled, true);
      button("Cancel canvas edit").click();
    }, {onCutLine: () => new Promise((resolve, reject) => {rejectCut = reject;})});

    for (const dispose of [false, true]) {
      let resolveCut;
      await withCanvas("MultiPolygon", async ({root, map, button}) => {
        root.selectFeature(feature());button("Cut polygon").click();map.click([0, 2]);map.click([5, 2]);
        button("Apply cut").click();
        if (dispose) root.__destroy();
        else root.selectFeature({...feature(), id: "other-polygon", version: 9});
        const before = root.textContent;
        resolveCut();await Promise.resolve();await Promise.resolve();
        assert.equal(root.textContent, before, "an old cut cannot change a new selection or disposed canvas");
      }, {onCutLine: () => new Promise(resolve => {resolveCut = resolve;})});
    }
  });
});

function withCanvas(geometryType, run, options = {}) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let map, root, deferredCleanup = false;
  const cleanup = () => {
    root?.__destroy();
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);else delete globalThis.document;
    dom.window.close();
  };
  class CanvasMap {
    constructor({container}) {
      map = this;this.handlers = new Map();this.sources = new Map();this.cameraChanges = 0;
      this.canvas = {style: {}};
      Object.defineProperties(container, {clientWidth: {value: 800}, clientHeight: {value: 600}});
    }
    on(type, ...args) {if (args.length === 1) this.handlers.set(type, args[0]);return this;}
    addControl() {}
    addSource(id, source) {this.sources.set(id, {...source, setData(data) {this.data = data;}});}
    addLayer() {}
    getSource(id) {return this.sources.get(id);}
    getCanvas() {return this.canvas;}
    queryRenderedFeatures() {return this.renderedFeatures ?? [];}
    project([x, y]) {return {x: x * 10 + 100, y: y * 10 + 100};}
    fitBounds() {this.cameraChanges++;}
    remove() {}
    click([lng, lat], point = this.project([lng, lat])) {this.handlers.get("click")({lngLat: {lng, lat}, point});}
  }
  try {
    Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
    const changes = [];
    root = FeatureCanvas({collection: {geometryType}, features: options.features ?? [], initialGeometry: null,
      onGeometryChange: geometry => changes.push(geometry), onSelectFeature: options.onSelectFeature ?? (() => {}),
      onCutLine: options.onCutLine,
      mapEngine: {Map: CanvasMap, NavigationControl: class {}}});
    dom.window.document.body.append(root);map.handlers.get("load")();
    const button = label => {const control = [...root.querySelectorAll("button")].find(button => button.textContent === label);assert(control, label);return control;};
    const result = run({root, map, button, changes});
    if (result?.then) {
      deferredCleanup = true;
      return Promise.resolve(result).finally(cleanup);
    }
    return result;
  } finally {
    if (!deferredCleanup) cleanup();
  }
}
