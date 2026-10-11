import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";

import {JSDOM} from "jsdom";

import {featureLockControls} from "../src/components/ProjectDatasets.js";

const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const DATASET_ID = "80000000-0000-4000-8000-000000000001";
const FEATURE_ID = "90000000-0000-4000-8000-000000000001";
const LOCK_TOKEN = "a0000000-0000-4000-8000-000000000001";

describe("feature reservation controls", () => {
  let previousDocument;

  beforeEach(() => {
    previousDocument = globalThis.document;
    globalThis.document = new JSDOM("<!doctype html><body></body>").window.document;
  });

  afterEach(() => {
    globalThis.document = previousDocument;
  });

  it("distinguishes available, caller-held, and other-editor reservations compactly", () => {
    const context = {
      state: {project: {id: PROJECT_ID}, adapter: {}},
      dataset: {id: DATASET_ID},
      details: document.createElement("div"),
      feature: {id: FEATURE_ID, version: 4}
    };
    const available = featureLockControls(
      context.state, context.dataset, context.details, context.feature, null
    );
    const own = featureLockControls(
      context.state,
      context.dataset,
      context.details,
      context.feature,
      featureLock({heldByCurrentUser: true, lockToken: LOCK_TOKEN})
    );
    const other = featureLockControls(
      context.state,
      context.dataset,
      context.details,
      context.feature,
      featureLock({heldByCurrentUser: false, lockToken: null})
    );

    assert.equal(available.dataset.state, "available");
    assert.equal(available.querySelector("button")?.textContent, "Reserve edit");
    assert.equal(own.dataset.state, "own");
    assert.deepEqual(
      [...own.querySelectorAll("button")].map(({textContent}) => textContent),
      ["Renew", "Release"]
    );
    assert.equal(other.dataset.state, "other");
    assert.match(other.textContent, /Reserved by another editor until/);
    assert.equal(other.querySelectorAll("button").length, 0);
  });

  it("explains a competing reservation without exposing its token or owner identity", async () => {
    const adapter = {
      async acquireFeatureLock() {
        throw Object.assign(new Error("feature_locked"), {
          code: "feature_locked",
          currentVersion: 4
        });
      }
    };
    const controls = featureLockControls(
      {project: {id: PROJECT_ID}, adapter},
      {id: DATASET_ID},
      document.createElement("div"),
      {id: FEATURE_ID, version: 4},
      null
    );

    controls.querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(controls.textContent, /Another editor holds the active short reservation/);
    assert.doesNotMatch(controls.textContent, new RegExp(LOCK_TOKEN));
  });
});

function featureLock({heldByCurrentUser, lockToken}) {
  return {
    featureId: FEATURE_ID,
    featureVersion: 4,
    heldByCurrentUser,
    lockToken,
    acquiredAt: "2026-09-02T17:00:00Z",
    expiresAt: "2026-09-02T17:02:00Z"
  };
}
