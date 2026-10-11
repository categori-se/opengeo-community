import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {featurePageWithTarget} from "../src/components/ProjectDatasets.js";

describe("feature discussion deep links", () => {
  it("reveals an exact target even when it is outside the bounded first feature page", () => {
    const page = {
      features: Array.from({length: 100}, (_, index) => ({
        id: `feature-${index}`,
        version: 1
      })),
      numberMatched: 200,
      numberReturned: 100,
      collection: {generation: 3}
    };
    const target = {id: "feature-target", version: 7};

    const revealed = featurePageWithTarget(page, target);

    assert.equal(revealed.features.length, 100);
    assert.equal(revealed.features[0], target);
    assert.equal(revealed.numberMatched, 200);
    assert.equal(revealed.numberReturned, 100);
    assert.equal(page.features[0].id, "feature-0");
  });

  it("does not duplicate a target already present in the bounded page", () => {
    const target = {id: "feature-target", version: 7};
    const page = {
      features: [target],
      numberMatched: 1,
      numberReturned: 1,
      collection: {generation: 3}
    };

    assert.equal(featurePageWithTarget(page, structuredClone(target)), page);
  });
});
