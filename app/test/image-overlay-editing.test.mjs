import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {fitImageOverlay, overlayHandlePoint, transformImageOverlay, pointInImageOverlay} from "../src/lib/imageOverlayEditing.js";
import {addKmlPlace, createPlacesDocument, placesToGeojson, updateKmlPlace} from "../src/lib/kmlPlaces.js";

const rectangle = [[100, 100], [300, 100], [300, 200], [100, 200]];
const transform = (handle, end, options) => transformImageOverlay(rectangle, handle, overlayHandlePoint(rectangle, handle), end, options);

describe("direct image-overlay geometry", () => {
  it("fits the original aspect ratio inside the current viewport", () => {
    assert.deepEqual(fitImageOverlay(1000, 500, 400, 200), [[200, 100], [800, 100], [800, 400], [200, 400]]);
    const portrait = fitImageOverlay(390, 500, 100, 1000);
    assert.equal(portrait[1][0] - portrait[0][0], 30);
    assert.equal(portrait[3][1] - portrait[0][1], 300);
    assert.throws(() => fitImageOverlay(0, 500, 100, 100));
  });
  it("moves all corners together and resizes sides without moving the opposite edge", () => {
    assert.deepEqual(transform("move", [210, 160]), [[110, 110], [310, 110], [310, 210], [110, 210]]);
    assert.deepEqual(transform("e", [350, 150]), [[100, 100], [350, 100], [350, 200], [100, 200]]);
    assert.deepEqual(transform("n", [200, 50]), [[100, 50], [300, 50], [300, 200], [100, 200]]);
  });
  it("keeps the opposite corner fixed and optionally preserves proportions", () => {
    assert.deepEqual(transform("se", [400, 225]), [[100, 100], [400, 100], [400, 225], [100, 225]]);
    assert.deepEqual(transform("se", [400, 225], {lockAspect: true}), [[100, 100], [400, 100], [400, 250], [100, 250]]);
  });
  it("rotates around the center, snaps on request, and resizes rotated axes", () => {
    const center = overlayHandlePoint(rectangle, "move");
    const rotated = transformImageOverlay(rectangle, "rotate", [200, 50], [300, 150]);
    assert.deepEqual(overlayHandlePoint(rotated, "move"), center);
    assert.ok(Math.abs(Math.hypot(...rotated[1].map((value, axis) => value - rotated[0][axis])) - 200) < 1e-8);
    const start = overlayHandlePoint(rotated, "e");
    const resized = transformImageOverlay(rotated, "e", start, [start[0], start[1] + 50]);
    assert.deepEqual(resized[0], rotated[0]);
    assert.deepEqual(resized[3], rotated[3]);
    const snap = transformImageOverlay(rectangle, "rotate", [200, 50], [205, 50], {snapRotation: true});
    assert.deepEqual(snap, rectangle);
  });
  it("prevents inversion and supports selecting the rendered image", () => {
    const shrunk = transform("se", [0, 0]);
    assert.ok(shrunk[2][0] > shrunk[0][0] && shrunk[2][1] > shrunk[0][1]);
    assert.equal(pointInImageOverlay([200, 150], rectangle), true);
    assert.equal(pointInImageOverlay([10, 150], rectangle), false);
    assert.throws(() => transformImageOverlay(rectangle, "se", [1, 2], [NaN, 3]));
  });
  it("persists the image quadrilateral and opacity in ordinary KML metadata", () => {
    const document = createPlacesDocument();
    const points = [[-72, 43], [-71, 43], [-71, 42], [-72, 42]];
    const next = addKmlPlace(document, document.id, {kind: "ground-overlay", name: "Aerial", icon: {href: "image.png"}, box: null, quad: [points[3], points[2], points[1], points[0]], color: "80ffffff"});
    const changed = updateKmlPlace(next, next.children[0].id, {color: "40ffffff"});
    assert.deepEqual(placesToGeojson(changed).features[0].geometry.coordinates[0].slice(0, 4), points);
    assert.equal(changed.children[0].color, "40ffffff");
  });
});
