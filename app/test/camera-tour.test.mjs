import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  CAMERA_TOUR_SCHEMA_VERSION,
  addCameraTourKeyframe,
  cameraTourDurationMilliseconds,
  cameraTourFrameAt,
  createCameraTour,
  exportCameraTour,
  moveCameraTourKeyframe,
  normalizeCameraTour,
  parseCameraTour,
  removeCameraTourKeyframe,
  updateCameraTourKeyframe
} from "../src/lib/cameraTour.js";

describe("bounded deterministic camera tours", () => {
  it("records bounded views and interpolates across the antimeridian deterministically", () => {
    let tour = createCameraTour({
      title: "Dateline review",
      camera: camera(179, 10, 3, 170, 20),
      projection: "globe"
    });
    tour = updateCameraTourKeyframe(tour, "view-1", {holdMilliseconds: 0});
    tour = addCameraTourKeyframe(tour, camera(-179, 20, 5, -170, 40), {
      transitionMilliseconds: 4_000,
      holdMilliseconds: 1_000,
      easing: "linear"
    });

    assert.equal(tour.schemaVersion, CAMERA_TOUR_SCHEMA_VERSION);
    assert.equal(cameraTourDurationMilliseconds(tour), 5_000);
    assert.deepEqual(cameraTourFrameAt(tour, 2_000), {
      camera: {center: [180, 15], zoom: 4, pitch: 30, bearing: -180},
      elapsedMilliseconds: 2_000,
      durationMilliseconds: 5_000,
      keyframeIndex: 1,
      phase: "transition",
      progress: 0.5,
      done: false
    });
    assert.equal(cameraTourFrameAt(tour, 5_000).done, true);
    assert.deepEqual(cameraTourFrameAt(tour, 5_000).camera, tour.keyframes[1].camera);
  });

  it("updates, orders, removes, and round-trips without changing the source object", () => {
    const original = createCameraTour({title: "Inspection", camera: camera(-71, 42, 8, 0, 20)});
    let tour = addCameraTourKeyframe(original, camera(-70.5, 42.2, 10, 30, 40));
    tour = updateCameraTourKeyframe(tour, "view-2", {
      title: "Final site",
      transitionMilliseconds: 2_000,
      holdMilliseconds: 500
    });
    tour = moveCameraTourKeyframe(tour, "view-2", -1);
    assert.equal(tour.keyframes[0].id, "view-2");
    assert.equal(tour.keyframes[0].transitionMilliseconds, 0);
    assert.equal(tour.keyframes[1].transitionMilliseconds, 3_000);
    tour = removeCameraTourKeyframe(tour, "view-1");
    assert.equal(tour.keyframes.length, 1);
    assert.deepEqual(parseCameraTour(exportCameraTour(tour)), tour);
    assert.equal(original.keyframes.length, 1);
  });

  it("fails closed for unsupported versions, invalid cameras, excessive duration, duplicate IDs, and the last frame", () => {
    const tour = createCameraTour({title: "Safe", camera: camera(0, 0, 2, 0, 0)});
    assert.throws(
      () => normalizeCameraTour({...tour, schemaVersion: "opengeo.camera-tour.2.0.0"}),
      ({code}) => code === "camera_tour_version_unsupported"
    );
    assert.throws(
      () => addCameraTourKeyframe(tour, camera(0, 100, 2, 0, 0)),
      ({code}) => code === "camera_tour_camera_invalid"
    );
    assert.throws(
      () => normalizeCameraTour({...tour, keyframes: [
        tour.keyframes[0],
        {...tour.keyframes[0], transitionMilliseconds: 1_000}
      ]}),
      ({code}) => code === "camera_tour_keyframe_id_duplicate"
    );
    const tooLong = {
      ...tour,
      keyframes: Array.from({length: 16}, (_, index) => ({
        ...tour.keyframes[0],
        id: `view-${index + 1}`,
        transitionMilliseconds: index ? 60_000 : 0,
        holdMilliseconds: 60_000
      }))
    };
    assert.throws(
      () => normalizeCameraTour(tooLong),
      ({code}) => code === "camera_tour_duration_limit"
    );
    assert.throws(
      () => removeCameraTourKeyframe(tour, "view-1"),
      ({code}) => code === "camera_tour_last_keyframe_required"
    );
  });
});

function camera(longitude, latitude, zoom, bearing, pitch) {
  return {center: [longitude, latitude], zoom, bearing, pitch};
}
