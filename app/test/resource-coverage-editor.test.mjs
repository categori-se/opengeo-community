import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseResourceCoverage} from "../src/components/ResourceCoverageEditor.js";

const parse = (overrides = {}) => parseResourceCoverage({coordinates: ["", "", "", ""], temporalStart: "", temporalEnd: "", ...overrides});

describe("resource coverage metadata", () => {
  it("preserves unknown, degenerate and ordered geographic extents", () => {
    assert.deepEqual(parse(), {spatialExtent: null, temporalStart: null, temporalEnd: null});
    assert.deepEqual(parse({coordinates: ["-71.2", "42.1", "-71.2", "42.1"]}).spatialExtent, [-71.2, 42.1, -71.2, 42.1]);
    for (const coordinates of [["1", "", "2", "3"], ["181", "0", "182", "1"], ["0", "91", "1", "92"], ["170", "0", "-170", "1"], ["1", "5", "2", "4"], ["NaN", "0", "1", "1"], ["0x10", "0", "20", "1"], []]) {
      assert.throws(() => parse({coordinates}), {code: "metadata_coverage_invalid"});
    }
  });
  it("compares zoned instants without dropping offsets or microseconds", () => {
    const temporalStart = "2026-09-08T10:00:00.000001-04:00";
    const temporalEnd = "2026-09-08T14:00:00.000002Z";
    assert.deepEqual(parse({temporalStart, temporalEnd}), {spatialExtent: null, temporalStart, temporalEnd});
    assert.throws(() => parse({temporalStart: temporalEnd, temporalEnd: temporalStart}), {code: "metadata_coverage_invalid"});
    assert.equal(parse({temporalStart}).temporalEnd, null);
    for (const temporalStart of ["2026-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2026-09-08", "2026-09-08T00:00:00", "2026-09-08T24:00:00Z", "2026-09-08T00:00:00+24:00", "2026-09-08T00:00:00.1234567Z"]) {
      assert.throws(() => parse({temporalStart}), {code: "metadata_coverage_invalid"});
    }
    assert.equal(parse({temporalStart: "2024-02-29T12:00:00Z"}).temporalStart, "2024-02-29T12:00:00Z");
  });
});
