import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  CAMERA_TOUR_SCHEMA_VERSION,
  CAMERA_TOUR_LAYER_SCHEMA_VERSION,
  CAMERA_TOUR_LIMITS,
  addCameraTourKeyframe,
  cameraTourDurationMilliseconds,
  cameraTourFrameAt,
  cameraTourForProject,
  cameraTourForSave,
  captureCameraTourLayerVisibility,
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

describe("exact-version camera tour layer events", () => {
  it("requires the first layer recording at the first view and preserves camera-only compatibility", () => {
    const old = twoViews();
    const baseline = [binding("roads", true), binding("sites", false)];
    assert.throws(() => captureCameraTourLayerVisibility(old, "view-2", baseline),
      ({code}) => code === "camera_tour_layer_baseline_required");
    assert.throws(() => captureCameraTourLayerVisibility(old, "missing", baseline),
      ({code}) => code === "camera_tour_keyframe_not_found");
    const tour = captureCameraTourLayerVisibility(old, "view-1", baseline);
    baseline[0].visible = false;
    assert.equal(tour.schemaVersion, CAMERA_TOUR_LAYER_SCHEMA_VERSION);
    assert.equal(tour.keyframes[0].layerVisibility[0].visible, true);
    assert.equal(old.schemaVersion, CAMERA_TOUR_SCHEMA_VERSION);
    assert.equal(Object.hasOwn(old.keyframes[0], "layerVisibility"), false);
    assert.equal(Object.hasOwn(cameraTourFrameAt(old, 0), "layerVisibility"), false);
    assert.deepEqual(parseCameraTour(exportCameraTour(old)), old);
    assert.throws(() => normalizeCameraTour({...old,
      keyframes: [{...old.keyframes[0], layerVisibility: []}, old.keyframes[1]]}),
    ({code}) => code === "camera_tour_layer_visibility_version_required");
  });

  it("applies complete snapshots on arrival and reconstructs earlier visibility when scrubbing backward", () => {
    const baseline = [binding("roads", true), binding("sites", false)];
    const changed = [binding("roads", false), binding("sites", true)];
    let tour = captureCameraTourLayerVisibility(twoViews(), "view-1", baseline);
    tour = captureCameraTourLayerVisibility(tour, "view-2", [...changed].reverse());
    tour = addCameraTourKeyframe(tour, camera(20, 10, 5, 40, 30), {
      transitionMilliseconds: 1_000, holdMilliseconds: 500, easing: "linear"
    });
    assert.equal(cameraTourDurationMilliseconds(tour), 5_000);
    for (const elapsed of [0, 999, 1_000, 2_999]) {
      assert.deepEqual(cameraTourFrameAt(tour, elapsed).layerVisibility, baseline, `before arrival at ${elapsed}`);
    }
    for (const elapsed of [3_000, 3_499, 3_500, 4_499, 4_500, 5_000, 99_999]) {
      assert.deepEqual(cameraTourFrameAt(tour, elapsed).layerVisibility, changed, `after arrival at ${elapsed}`);
    }
    assert.equal(cameraTourFrameAt(tour, 2_999).phase, "transition");
    assert.equal(cameraTourFrameAt(tour, 3_000).phase, "hold");
    assert.equal(cameraTourFrameAt(tour, 3_500).phase, "transition");
    assert.deepEqual(cameraTourFrameAt(tour, 0).layerVisibility, baseline);
    assert.deepEqual(cameraTourFrameAt(tour, 3_100).layerVisibility, changed);
    assert.deepEqual(cameraTourFrameAt(tour, 1_000).layerVisibility, baseline);
    const frame = cameraTourFrameAt(tour, 0);
    frame.layerVisibility[0].visible = false;
    assert.deepEqual(cameraTourFrameAt(tour, 0).layerVisibility, baseline);
  });

  it("handles instant arrivals and empty complete snapshots without adding events to older tours", () => {
    let tour = updateCameraTourKeyframe(twoViews(), "view-1", {holdMilliseconds: 0});
    tour = updateCameraTourKeyframe(tour, "view-2", {transitionMilliseconds: 0, holdMilliseconds: 0});
    tour = captureCameraTourLayerVisibility(tour, "view-1", [binding("roads", true)]);
    tour = captureCameraTourLayerVisibility(tour, "view-2", [binding("roads", false)]);
    assert.equal(cameraTourFrameAt(tour, 0).done, true);
    assert.deepEqual(cameraTourFrameAt(tour, 0).layerVisibility, [binding("roads", false)]);
    const empty = captureCameraTourLayerVisibility(twoViews(), "view-1", []);
    assert.deepEqual(cameraTourFrameAt(empty, 3_000).layerVisibility, []);
  });

  it("round-trips layer events and keeps legacy source binding strings intact", () => {
    const old = twoViews();
    old.bindings.layerVersions = [{layerId: "roads", sourceVersion: "retained-source-001"}];
    let tour = captureCameraTourLayerVisibility(old, "view-1", [binding("roads", true)]);
    tour = captureCameraTourLayerVisibility(tour, "view-2", [binding("roads", false)]);
    assert.equal(tour.bindings.layerVersions[0].sourceVersion, "retained-source-001");
    assert.deepEqual(parseCameraTour(exportCameraTour(tour)), tour);
    assert.deepEqual(cameraTourForSave(tour), tour);
    assert.deepEqual(cameraTourForProject({extensions: {cameraTour: tour}}), tour);
    const missingBaseline = structuredClone(tour);
    delete missingBaseline.keyframes[0].layerVisibility;
    assert.throws(() => normalizeCameraTour(missingBaseline),
      ({code}) => code === "camera_tour_layer_baseline_required");
    assert.equal(cameraTourForProject({extensions: {cameraTour: missingBaseline}}), null);
  });

  it("rejects missing, additional, duplicate or changed immutable layer bindings", () => {
    const snapshot = [binding("roads", true), binding("sites", false)];
    const tour = captureCameraTourLayerVisibility(twoViews(), "view-1", snapshot);
    const invalid = [
      snapshot.slice(0, 1),
      [...snapshot, binding("extra", true)],
      [snapshot[0], {...snapshot[0], visible: false}],
      [{...snapshot[0], datasetId: "22222222-2222-4222-8222-222222222222"}, snapshot[1]],
      [{...snapshot[0], datasetVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}, snapshot[1]],
      [{...snapshot[0], sourceVersion: 2}, snapshot[1]]
    ];
    for (const rows of invalid) {
      assert.throws(() => captureCameraTourLayerVisibility(tour, "view-2", rows),
        ({code}) => ["camera_tour_layer_binding_mismatch", "camera_tour_layer_binding_duplicate"].includes(code));
    }
    const later = captureCameraTourLayerVisibility(tour, "view-2", snapshot);
    assert.throws(() => captureCameraTourLayerVisibility(later, "view-1", [binding("other", true)]),
      ({code}) => code === "camera_tour_layer_binding_mismatch");
    assert.deepEqual(tour.keyframes[0].layerVisibility, snapshot);
    assert.equal(Object.hasOwn(tour.keyframes[1], "layerVisibility"), false);
  });

  it("requires real dataset/version UUIDs, a positive integer source version and boolean visibility", () => {
    const old = twoViews();
    const malformed = [
      null, [], {...binding("roads", true), layerId: "bad/layer"},
      {...binding("roads", true), datasetId: "dataset"},
      {...binding("roads", true), datasetVersionId: null},
      {...binding("roads", true), datasetVersionId: "latest"},
      ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map(sourceVersion => ({...binding("roads", true), sourceVersion})),
      {...binding("roads", true), visible: "true"}, {...binding("roads", true), accessToken: "unrecorded"}
    ];
    for (const row of malformed) {
      assert.throws(() => captureCameraTourLayerVisibility(old, "view-1", [row]),
        ({code}) => code === "camera_tour_layer_binding_invalid");
    }
    assert.throws(() => captureCameraTourLayerVisibility(old, "view-1", null),
      ({code}) => code === "camera_tour_layer_visibility_invalid");
  });

  it("preserves a deterministic baseline through editing and refuses deletion or reordering that loses it", () => {
    const baseline = [binding("roads", true)];
    let tour = captureCameraTourLayerVisibility(twoViews(), "view-1", baseline);
    assert.throws(() => removeCameraTourKeyframe(tour, "view-1"),
      ({code}) => code === "camera_tour_layer_baseline_required");
    assert.throws(() => moveCameraTourKeyframe(tour, "view-2", -1),
      ({code}) => code === "camera_tour_layer_baseline_required");
    tour = updateCameraTourKeyframe(tour, "view-1", {camera: camera(5, 5, 4, 10, 10), title: "Edited start"});
    assert.deepEqual(tour.keyframes[0].layerVisibility, baseline);
    tour = captureCameraTourLayerVisibility(tour, "view-2", [binding("roads", false)]);
    const moved = moveCameraTourKeyframe(tour, "view-2", -1);
    assert.equal(moved.keyframes[0].id, "view-2");
    assert.deepEqual(cameraTourFrameAt(moved, 0).layerVisibility, [binding("roads", false)]);
    const removed = removeCameraTourKeyframe(tour, "view-1");
    assert.deepEqual(cameraTourFrameAt(removed, 0).layerVisibility, [binding("roads", false)]);
  });

  it("bounds snapshots, frame count and the complete serialized tour", () => {
    const old = twoViews();
    const maximum = Array.from({length: CAMERA_TOUR_LIMITS.maximumLayerVisibilityBindings},
      (_, index) => binding(`layer-${index}`, true));
    assert.equal(captureCameraTourLayerVisibility(old, "view-1", maximum).keyframes[0].layerVisibility.length, 64);
    assert.throws(() => captureCameraTourLayerVisibility(old, "view-1", [...maximum, binding("extra", true)]),
      ({code}) => code === "camera_tour_layer_visibility_limit");
    const baseline = captureCameraTourLayerVisibility(old, "view-1", maximum);
    assert.throws(() => normalizeCameraTour({...baseline,
      keyframes: Array.from({length: 65}, (_, index) => ({...baseline.keyframes[0], id: `view-${index}`}))}),
    ({code}) => code === "camera_tour_keyframe_limit");
    const large = maximum.map((row, index) => ({...row, layerId: `layer-${index}-${"x".repeat(150)}`}));
    assert.throws(() => normalizeCameraTour({...baseline,
      keyframes: Array.from({length: 16}, (_, index) => ({...baseline.keyframes[0], id: `view-${index}`,
        transitionMilliseconds: 0, holdMilliseconds: 0, layerVisibility: large}))}),
    ({code}) => code === "camera_tour_serialized_limit");
  });
});

function twoViews() {
  return addCameraTourKeyframe(createCameraTour({camera: camera(0, 0, 2, 0, 0)}), camera(10, 10, 4, 20, 20), {
    transitionMilliseconds: 2_000, holdMilliseconds: 500, easing: "linear"
  });
}

function binding(layerId, visible) {
  return {layerId, datasetId: "11111111-1111-4111-8111-111111111111",
    datasetVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceVersion: 1, visible};
}

function camera(longitude, latitude, zoom, bearing, pitch) {
  return {center: [longitude, latitude], zoom, bearing, pitch};
}
