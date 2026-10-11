import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  deletedFeatureRestoreRequest,
  featureTombstonesForEditor,
  featureRevisionRestoreDraft
} from "../src/components/ProjectDatasets.js";

describe("feature revision restore", () => {
  it("copies an older immutable snapshot into a conflict-safe next-version draft", () => {
    const feature = {id: "feature-1", version: 4};
    const revision = {
      version: 2,
      operation: "update",
      geometry: {type: "Point", coordinates: [-71.1, 42.3]},
      properties: {name: "Reviewed station", score: 8}
    };

    const draft = featureRevisionRestoreDraft(feature, revision);

    assert.deepEqual(draft, {
      expectedVersion: 4,
      geometry: revision.geometry,
      properties: revision.properties,
      changeMessage: "Restored content from immutable feature revision v2"
    });
    assert.notEqual(draft.geometry, revision.geometry);
    assert.notEqual(draft.properties, revision.properties);
    draft.properties.score = 9;
    assert.equal(revision.properties.score, 8);
  });

  it("rejects current, future, deleted, or malformed revision requests", () => {
    const feature = {version: 4};
    const snapshot = {
      operation: "update",
      geometry: {type: "Point", coordinates: [0, 0]},
      properties: {}
    };

    assert.throws(
      () => featureRevisionRestoreDraft(feature, {...snapshot, version: 4}),
      (error) => error.code === "feature_restore_revision_invalid"
    );
    assert.throws(
      () => featureRevisionRestoreDraft(feature, {...snapshot, version: 5}),
      (error) => error.code === "feature_restore_revision_invalid"
    );
    assert.throws(
      () => featureRevisionRestoreDraft(feature, {...snapshot, version: 2, operation: "delete"}),
      (error) => error.code === "feature_restore_deleted_revision_invalid"
    );
    assert.deepEqual(
      featureRevisionRestoreDraft(feature, {...snapshot, version: 2, operation: "restore"}),
      {
        expectedVersion: 4,
        geometry: snapshot.geometry,
        properties: snapshot.properties,
        changeMessage: "Restored content from immutable feature revision v2"
      }
    );
    assert.throws(
      () => featureRevisionRestoreDraft(feature, {...snapshot, version: 2, geometry: null}),
      (error) => error.code === "feature_restore_geometry_invalid"
    );
  });

  it("builds a tombstone-version restore receipt without accepting browser geometry", () => {
    const request = deletedFeatureRestoreRequest(
      {featureId: "feature-1", deletedVersion: 5},
      {version: 2, operation: "update", geometry: {type: "Point"}}
    );

    assert.deepEqual(request, {
      expectedVersion: 5,
      revisionVersion: 2,
      changeMessage: "Restored deleted feature from immutable revision v2"
    });
    assert.equal("geometry" in request, false);
    assert.equal("properties" in request, false);
    assert.throws(
      () => deletedFeatureRestoreRequest(
        {deletedVersion: 5}, {version: 5, operation: "update"}
      ),
      (error) => error.code === "feature_restore_revision_invalid"
    );
    assert.throws(
      () => deletedFeatureRestoreRequest(
        {deletedVersion: 5}, {version: 4, operation: "delete"}
      ),
      (error) => error.code === "feature_restore_revision_invalid"
    );
  });

  it("keeps feature editing available during an additive static/API rollout window", async () => {
    const state = {
      project: {id: "project-1"},
      adapter: {
        async listFeatureTombstones() {
          throw Object.assign(new Error("older API"), {status: 404, code: "http_404"});
        }
      }
    };

    assert.deepEqual(await featureTombstonesForEditor(state, {id: "dataset-1"}), {
      tombstones: [],
      numberMatched: 0,
      numberReturned: 0,
      limit: 100,
      offset: 0
    });
    state.adapter.listFeatureTombstones = async () => {
      throw Object.assign(new Error("forbidden"), {status: 403, code: "action_forbidden"});
    };
    await assert.rejects(
      featureTombstonesForEditor(state, {id: "dataset-1"}),
      (error) => error.code === "action_forbidden"
    );
  });
});
