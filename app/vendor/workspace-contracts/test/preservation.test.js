import test from "node:test";
import assert from "node:assert/strict";
import {assertPreservedRecord, validatePreservedRecord} from "../src/index.js";

const policy = {immutableFields: ["id", "original"], appendOnly: {events: "event_id"}};
const before = {id: "asset_a", original: {date: null, raw: {publisher: "Original"}},
  events: [{event_id: "first", original_name: "original.pdf"}], curated: {title: "Before"}};

test("curation and appended editions retain original unknowns and prior evidence", () => {
  const next = {...structuredClone(before), curated: {title: "After"},
    events: [{event_id: "new", action: "curation"}, ...before.events]};
  assert.equal(assertPreservedRecord(before, next, policy), next);
  assert.deepEqual(before.original, {date: null, raw: {publisher: "Original"}});
  assert.deepEqual(validatePreservedRecord(before, {...next, original: {raw: {publisher: "Original"}, date: null}}, policy), []);
});

test("changing identity, filling unknown originals, removing or rewriting history is rejected", () => {
  for (const patch of [{id: "other"}, {original: {...before.original, date: "2020-01-01"}},
    {events: []}, {events: [{event_id: "first", original_name: "changed.pdf"}]},
    {events: [before.events[0], before.events[0]]}]) {
    assert.ok(validatePreservedRecord(before, {...before, ...patch}, policy).length);
  }
});
