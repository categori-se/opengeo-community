import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  loadManagedLoginFixture,
  validateManagedLoginFixture
} from "../scripts/managed-login-fixture.mjs";

describe("Managed-login development fixture", () => {
  it("loads two distinct projects around one bounded six-feature dataset", async () => {
    const fixture = await loadManagedLoginFixture();

    assert.equal(fixture.environment, "development");
    assert.equal(fixture.projects.length, 2);
    assert.equal(fixture.dataset.features.length, 6);
    assert.equal(fixture.acceptance.sharedDatasetProjectCount, 2);
    assert.equal(fixture.acceptance.governedFeatureCount, 6);
    assert.equal(fixture.acceptance.minimumStatusContrastRatio, 7);
    assert.equal(new Set(fixture.projects.flatMap(({strokes}) => strokes)).size, 4);
    assert.doesNotMatch(JSON.stringify(fixture), /password|secret|credential|token/i);
  });

  it("rejects production scope, duplicate styles, and unbounded coordinates", async () => {
    const fixture = structuredClone(await loadManagedLoginFixture());
    fixture.environment = "production";
    assert.throws(
      () => validateManagedLoginFixture(fixture),
      /outside the development environment/
    );

    fixture.environment = "development";
    fixture.projects[1].strokes[0] = fixture.projects[0].strokes[0];
    assert.throws(
      () => validateManagedLoginFixture(fixture),
      /palettes must be independent/
    );

    fixture.projects[1].strokes[0] = "#175cd3";
    fixture.dataset.features[0].coordinates[0][0] = 181;
    assert.throws(
      () => validateManagedLoginFixture(fixture),
      /coordinate is invalid/
    );
  });
});
