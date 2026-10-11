import test from "node:test";
import assert from "node:assert/strict";
import {createResourceReference} from "../src/interoperability.js";
import {assertLocationWrite, validateLocationWrite, createWorkingCopy, checkpointWorkingCopy, validateWorkingCopy,
  validateWorkingCopyCheckpoint, createPromotionRequest, assertPromotionApplicable, validatePromotionRequest} from "../src/working-state.js";

const now = new Date("2026-10-02T12:00:00.000Z");
const ref = (resourceId, resourceType, versionId, workspaceId = "workspace_a", authority = "urn:test:docs-manager") =>
  createResourceReference({authority, resourceId, resourceType, workspaceId, ...(versionId === undefined ? {} : {versionId})});
const baseReference = ref("asset_a", "asset", "original-version", "workspace_source", "urn:test:archive");
const location = ref("working_a", "asset_location");
const destination = ref("production_a", "asset_location");
const permissions = {view: true, edit: true, promote: true, providerWrite: true};
const write = {purposes: ["working"], operation: "save", currentRevision: '"opaque-etag-1"', expectedRevision: '"opaque-etag-1"', permissions, supportsConditionalWrite: true};
const createCopy = () => createWorkingCopy({reference: ref("copy_a", "working_copy"), baseReference, workingLocation: location, createdBy: "user_a", now});
const checkpoint = (copy, version = "checkpoint-1") => checkpointWorkingCopy(copy, {
  checkpointReference: ref("checkpoint_a", "working_checkpoint", version), contentReference: ref("asset_a", "asset", "working-content-1"),
  expectedRecordRevision: copy.record_revision, createdBy: "user_a", now
});
const promote = checkpoint => createPromotionRequest({promotionId: "promotion_a", checkpoint, destinationReference: destination,
  destinationPurposes: ["publication"], expectedDestinationRevision: '"production-etag"', createdBy: "user_a", now});
const live = checkpoint => ({checkpoint, destinationReference: destination, destinationPurposes: ["publication"],
  currentDestinationRevision: '"production-etag"', permissions, supportsConditionalWrite: true});

test("working Save returns an exact adapter precondition and requires explicit classification", () => {
  assert.deepEqual(assertLocationWrite(write), {operation: "save", precondition: {kind: "match", revision: '"opaque-etag-1"'}});
  assert.deepEqual(assertLocationWrite({...write, currentRevision: null, expectedRevision: null}), {operation: "save", precondition: {kind: "create", revision: null}});
  for (const purposes of [undefined, [], ["production"], ["working", "working"]]) assert.ok(validateLocationWrite({...write, purposes}).length);
});

test("ordinary Save and checkpoint cannot overwrite production, source or archival bytes", () => {
  for (const purpose of ["authoritative_source", "publication", "archival"]) {
    for (const operation of ["save", "checkpoint"]) {
      for (const purposes of [[purpose], ["working", purpose]]) {
        assert.throws(() => assertLocationWrite({...write, purposes, operation}), error => error.code === "protected-location");
      }
    }
  }
  assert.throws(() => assertLocationWrite({...write, operation: "promote", purposes: ["archival"]}), /cannot overwrite archival bytes/);
});

test("revision tokens are opaque and the adapter must enforce the precondition", () => {
  for (const patch of [{expectedRevision: 1}, {currentRevision: 1}, {expectedRevision: "1", currentRevision: 1},
    {expectedRevision: ""}, {expectedRevision: undefined}, {expectedRevision: null}, {currentRevision: "changed"}]) {
    assert.ok(validateLocationWrite({...write, ...patch}).length);
  }
  assert.throws(() => assertLocationWrite({...write, expectedRevision: '"opaque-etag-2"'}), error => error.code === "conflict");
  assert.throws(() => assertLocationWrite({...write, supportsConditionalWrite: false}), error => error.code === "conditional-write-required");
  const whitespaceToken = " opaque revision ";
  assert.equal(assertLocationWrite({...write, currentRevision: whitespaceToken, expectedRevision: whitespaceToken}).precondition.revision, whitespaceToken);
});

test("provider writes do not grant editing or promotion and explicit permission revocation denies", () => {
  assert.throws(() => assertLocationWrite({...write, permissions: {providerWrite: true}}), error => error.code === "forbidden");
  assert.throws(() => assertLocationWrite({...write, permissions: {...permissions, edit: false}}), error => error.code === "forbidden");
  assert.throws(() => assertLocationWrite({...write, permissions: {...permissions, providerWrite: false}}), error => error.code === "forbidden");
  assert.throws(() => assertLocationWrite({...write, purposes: ["publication"], operation: "promote", permissions: {edit: true, providerWrite: true}}), error => error.code === "forbidden");
  assert.throws(() => assertLocationWrite({...write, permissions: {...permissions, edit: "true"}}), error => error.code === "forbidden");
});

test("working copy retains the exact base and independent scope while checkpoints append pinned content", () => {
  const copy = createCopy(), before = structuredClone(copy), first = checkpoint(copy);
  assert.deepEqual(copy, before);
  assert.deepEqual(copy.base_reference, baseReference);
  assert.notEqual(copy.reference.workspace_id, baseReference.workspace_id);
  assert.equal(first.workingCopy.record_revision, 2);
  assert.equal(first.checkpoint.sequence, 1);
  assert.equal(first.checkpoint.previous_checkpoint_reference, null);
  assert.deepEqual(first.checkpoint.base_reference, baseReference);
  assert.equal(first.checkpoint.content_reference.version_id, "working-content-1");
  assert.ok(Object.isFrozen(first.checkpoint.content_reference));
  assert.deepEqual(validateWorkingCopy(JSON.parse(JSON.stringify(first.workingCopy))), []);
  const second = checkpoint(first.workingCopy, "checkpoint-2");
  assert.equal(second.checkpoint.sequence, 2);
  assert.deepEqual(second.checkpoint.previous_checkpoint_reference, first.checkpoint.reference);
  assert.deepEqual(second.checkpoint.base_reference, first.checkpoint.base_reference);
  assert.equal(first.workingCopy.checkpoint_count, 1);
});

test("stale working-copy record revisions, unpinned content and reused checkpoint identities fail", () => {
  const copy = createCopy(), first = checkpoint(copy);
  assert.throws(() => checkpointWorkingCopy(copy, {expectedRecordRevision: "1"}), error => error.code === "conflict");
  assert.throws(() => checkpointWorkingCopy(first.workingCopy, {expectedRecordRevision: 1}), error => error.code === "conflict");
  assert.throws(() => checkpointWorkingCopy(copy, {checkpointReference: ref("checkpoint_a", "working_checkpoint", "c1"),
    contentReference: ref("asset_a", "asset"), expectedRecordRevision: 1, createdBy: "user_a", now}), /version/);
  assert.throws(() => checkpoint(first.workingCopy), /distinct immutable reference/);
  assert.throws(() => createWorkingCopy({reference: ref("copy_a", "working_copy"), baseReference: ref("asset_a", "asset"), workingLocation: location, createdBy: "user_a", now}), /version/);
});

test("scope mismatch, wrong types and unknown record fields fail the portable boundary", () => {
  const copy = createCopy(), first = checkpoint(copy);
  assert.ok(validateWorkingCopy({...copy, permissions: ["edit"]}).length);
  assert.ok(validateWorkingCopy({...copy, reference: ref("copy_a", "working_copy", "misleading-version")}).length);
  assert.ok(validateWorkingCopy({...copy, working_location: ref("location_b", "asset_location", undefined, "workspace_b")}).length);
  assert.ok(validateWorkingCopyCheckpoint({...first.checkpoint, reference: ref("checkpoint_a", "asset", "c1")}).length);
  assert.ok(validateWorkingCopyCheckpoint({...first.checkpoint, reference: ref("checkpoint_a", "working_checkpoint", "c1", "workspace_b")}).length);
  assert.ok(validateWorkingCopyCheckpoint({...first.checkpoint, content_reference: {...first.checkpoint.content_reference, bearer_token: "synthetic"}}).length);
});

test("promotion applies the exact reviewed checkpoint and conditional target base", () => {
  const first = checkpoint(createCopy()), request = promote(first.checkpoint);
  const applicable = assertPromotionApplicable(request, live(first.checkpoint));
  assert.deepEqual(applicable.precondition, {kind: "match", revision: '"production-etag"'});
  assert.deepEqual(applicable.content, first.checkpoint.content_reference);
  assert.deepEqual(applicable.checkpoint, first.checkpoint.reference);
  assert.ok(Object.isFrozen(request.content_reference));
  assert.deepEqual(validatePromotionRequest(JSON.parse(JSON.stringify(request))), []);
  const second = checkpoint(first.workingCopy, "checkpoint-2");
  assert.notDeepEqual(second.checkpoint.reference, request.checkpoint_reference);
  assert.deepEqual(assertPromotionApplicable(request, live(first.checkpoint)).content, first.checkpoint.content_reference,
    "newer working head must not substitute different bytes into the reviewed release");
});

test("stale destination, changed binding or content and changed purposes invalidate promotion", () => {
  const first = checkpoint(createCopy()), request = promote(first.checkpoint), state = live(first.checkpoint);
  for (const patch of [{currentDestinationRevision: '"new-etag"'}, {currentDestinationRevision: null},
    {destinationReference: ref("other_target", "asset_location")}, {destinationPurposes: ["authoritative_source"]},
    {checkpoint: {...first.checkpoint, content_reference: ref("asset_a", "asset", "changed-content")}},
    {checkpoint: {...first.checkpoint, base_reference: ref("asset_a", "asset", "changed-base", "workspace_source", "urn:test:archive")}}]) {
    assert.throws(() => assertPromotionApplicable(request, {...state, ...patch}), error => error.code === "conflict");
  }
});

test("promotion rechecks source access, explicit promotion and provider authorization", () => {
  const first = checkpoint(createCopy()), request = promote(first.checkpoint), state = live(first.checkpoint);
  for (const permission of ["view", "promote", "providerWrite"]) {
    assert.throws(() => assertPromotionApplicable(request, {...state, permissions: {...permissions, [permission]: false}}), error => error.code === "forbidden");
  }
  assert.throws(() => assertPromotionApplicable(request, {...state, supportsConditionalWrite: false}), error => error.code === "conditional-write-required");
  assert.deepEqual(assertPromotionApplicable(request, {...state, permissions: {...permissions, edit: false}}).content, request.content_reference,
    "explicit promotion permission is independent of ordinary edit permission");
});

test("first publication requires an absent target and archival bytes cannot become a promotion target", () => {
  const first = checkpoint(createCopy()), request = createPromotionRequest({promotionId: "promotion_new", checkpoint: first.checkpoint,
    destinationReference: destination, destinationPurposes: ["publication"], expectedDestinationRevision: null, createdBy: "user_a", now});
  assert.deepEqual(assertPromotionApplicable(request, {...live(first.checkpoint), currentDestinationRevision: null}).precondition, {kind: "create", revision: null});
  assert.throws(() => assertPromotionApplicable(request, live(first.checkpoint)), error => error.code === "conflict");
  assert.throws(() => createPromotionRequest({promotionId: "overwrite_archive", checkpoint: first.checkpoint,
    destinationReference: destination, destinationPurposes: ["working", "archival"], expectedDestinationRevision: null, createdBy: "user_a", now}), /archival bytes/);
});
