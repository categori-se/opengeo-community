import assert from "node:assert/strict";
import {test} from "node:test";
import {featureFieldVisible} from "../src/lib/featureFieldVisibility.js";

test("numeric visibility boundaries and absent controllers agree with server rules", () => {
  for (const [operator, shown, hidden] of [
    ["ne", 9, 10], ["gt", 11, 10], ["gte", 10, 9], ["lt", 9, 10], ["lte", 10, 11]
  ]) {
    const rule = {field: "score", equals: 10, operator};
    assert.equal(featureFieldVisible(rule, new Map([["score", shown]])), true);
    assert.equal(featureFieldVisible(rule, new Map([["score", hidden]])), false);
    assert.equal(featureFieldVisible(rule, new Map()), false);
  }
  assert.equal(featureFieldVisible({field: "flag", equals: false}, new Map([["flag", false]])), true);
});

test("field operands use current record values and hide when either operand is missing", () => {
  const rule = {field: "measured", value_field: "limit", operator: "gt"};
  assert.equal(featureFieldVisible(rule, new Map([["measured", 11], ["limit", 10]])), true);
  assert.equal(featureFieldVisible(rule, new Map([["measured", 9], ["limit", 10]])), false);
  assert.equal(featureFieldVisible(rule, new Map([["measured", 11]])), false);
  assert.equal(featureFieldVisible({...rule, operator: "ne"}, new Map([["limit", 10]])), false);
});
