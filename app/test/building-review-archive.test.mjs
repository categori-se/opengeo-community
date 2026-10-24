import assert from "node:assert/strict";
import {test} from "node:test";
import {archivedBuildingReviewReceipt, verifyBuildingReviewArchive} from "../src/lib/buildingReviewArchive.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {buildingReconciliationGroups, buildReviewedBuildingInventory} from "../src/lib/buildingReconciliation.js";
import {sha256Hex} from "../src/lib/managedUpload.js";
import {buildingReviewComparison, buildingReviewerId} from "./fixtures/building-review.js";

const distributionId = "urn:opengeo:dataset:10000000-0000-4000-8000-000000000009:version:10000000-0000-4000-8000-000000000010:original";
const timestamp = "2026-10-23T17:24:36.123-04:00";
const placeholder = "a".repeat(64);
function reviewed(evaluationReferenceSide) {
  const collection = buildingReviewComparison();
  const decisions = buildingReconciliationGroups(collection).map(group => ({componentId: group.id,
    selectedFeatureIds: group.features.filter(feature => feature.properties.input.side === "source").map(feature => feature.id),
    reason: "Retain the reviewed source footprint; preserve the comparison identity in the audit."}));
  return buildReviewedBuildingInventory({collection, decisions, reviewerId: buildingReviewerId, timestamp, evaluationReferenceSide});
}
async function archive(collection = reviewed()) {
  const receipt = collection["opengeo:analysis"];
  const sha256 = await sha256Hex(new Blob([canonicalJson(receipt.buildingReview)]));
  const reference = archivedBuildingReviewReceipt(receipt, {distributionId, sha256}).buildingReview;
  const document = {type: "FeatureCollection", features: collection.features, properties: {"opengeo:analysis": receipt}};
  return {...await encoded(document), reference, receipt, document};
}
async function encoded(document) {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return {bytes, objectSha256: await sha256Hex(new Blob([bytes]))};
}

test("compact review receipt retains native lineage and exact immutable-original audit reference without decisions", async () => {
  const fixture = await archive(), before = structuredClone(fixture.receipt);
  const compact = archivedBuildingReviewReceipt(fixture.receipt, fixture.reference.audit);
  assert.deepEqual(fixture.receipt, before);
  assert.equal(compact.buildingReview.schemaVersion, "opengeo.building-inventory-review-summary.1.0.0");
  assert.equal(compact.buildingReview.retainedFeatureCount, 2);
  assert.equal(compact.buildingReview.excludedFeatureCount, 1);
  assert.equal(compact.buildingReview.validatedCount, null);
  assert(!Object.hasOwn(compact.buildingReview, "decisions"));
  assert(!JSON.stringify(compact).includes(before.buildingReview.decisions[0].reason));
  assert.deepEqual(compact.buildingReview.audit, {distributionId, jsonPointer: "/properties/opengeo:analysis/buildingReview",
    sha256: fixture.reference.audit.sha256, checksumMethod: "opengeo-canonical-json-sha256"});
  assert.deepEqual({...compact, buildingReview: before.buildingReview}, before);
  compact.buildingReconciliation.minimumIntersectionOverUnion = 1;
  assert.equal(fixture.receipt.buildingReconciliation.minimumIntersectionOverUnion, .5);
});

test("deliberate audit readback verifies original and review hashes and returns the complete independent receipt", async () => {
  const fixture = await archive();
  const {receipt, collection} = await verifyBuildingReviewArchive(fixture.bytes, fixture);
  assert.deepEqual(receipt, fixture.receipt);
  assert.deepEqual(collection, fixture.document);
  receipt.buildingReview.decisions[0].reason = "Changed after readback";
  assert.notEqual(receipt.buildingReview.decisions[0].reason, fixture.receipt.buildingReview.decisions[0].reason);
});

test("evaluated review archives all pair identities while bounded knowledge retains role-pinned metrics and an exact pointer", async () => {
  const input = reviewed("target"), fixture = await archive(input), summary = fixture.reference;
  const full = input["opengeo:analysis"].buildingReview.evaluation;
  assert.equal(input["opengeo:analysis"].buildingReview.schemaVersion, "opengeo.building-inventory-review.1.1.0");
  assert.equal(summary.schemaVersion, "opengeo.building-inventory-review-summary.1.1.0");
  assert.equal(summary.evaluation.schemaVersion, "opengeo.building-inventory-evaluation-summary.1.0.0");
  assert.equal(summary.evaluation.fullReportJsonPointer, "/properties/opengeo:analysis/buildingReview/evaluation");
  assert.equal(summary.evaluation.pairs, undefined);
  assert.equal(summary.evaluation.unmatchedPredictionFeatureIds, undefined);
  assert.deepEqual(summary.evaluation.inputs, full.inputs);
  assert.deepEqual(summary.evaluation.counts, full.counts);
  assert.deepEqual(summary.evaluation.metrics, full.metrics);
  assert.equal(summary.evaluation.referenceSide, "target");
  assert.equal(summary.evaluation.validatedCount, null);
  const verified = await verifyBuildingReviewArchive(fixture.bytes, fixture);
  assert.deepEqual(verified.receipt.buildingReview.evaluation, full);
  assert.equal(full.pairs.length, 1);
  assert.equal(full.unmatchedPredictionFeatureIds.length, 1);
  const changed = structuredClone(fixture.document);
  changed.properties["opengeo:analysis"].buildingReview.evaluation.referenceSide = "source";
  const object = await encoded(changed);
  await assert.rejects(verifyBuildingReviewArchive(object.bytes, {...object, reference: summary}));
});

test("archived evaluations must match every reviewed input identity and exact generation", () => {
  const fixture = reviewed("target")["opengeo:analysis"];
  for (const change of [
    value => {value.buildingReview.evaluation.inputs.source.generation++;},
    value => {value.buildingReview.evaluation.unmatchedPredictionFeatureIds[0] = "source:97000000-0000-4000-8000-000000000099";},
    value => {value.buildingReview.evaluation.metrics.precision = 1;},
    value => {value.buildingReview.schemaVersion = "opengeo.building-inventory-review.1.0.0";}
  ]) {
    const receipt = structuredClone(fixture); change(receipt);
    assert.throws(() => archivedBuildingReviewReceipt(receipt, {distributionId, sha256: placeholder}));
  }
});

test("object checksum is verified before parsing or using the audit pointer", async () => {
  const bytes = new TextEncoder().encode("not JSON");
  await assert.rejects(verifyBuildingReviewArchive(bytes, {objectSha256: placeholder, reference: null}), /object checksum/);
  await assert.rejects(verifyBuildingReviewArchive(bytes, {objectSha256: await sha256Hex(new Blob([bytes])), reference: null}), /UTF-8 JSON/);
  await assert.rejects(verifyBuildingReviewArchive(new Uint8Array(2_200_001), {objectSha256: placeholder}), /bytes or checksum/);
});

test("changed review digest, summary, pointer or checksum method cannot attest an archive", async () => {
  const fixture = await archive();
  for (const mutate of [
    reference => {reference.audit.sha256 = placeholder;},
    reference => {reference.retainedFeatureCount++;},
    reference => {reference.audit.jsonPointer = "/features";},
    reference => {reference.audit.checksumMethod = "sha256-json-stringify";},
    reference => {reference.decisions = [];},
    reference => {reference.audit.signedUrl = "https://example.com/temporary";}
  ]) {
    const reference = structuredClone(fixture.reference); mutate(reference);
    await assert.rejects(verifyBuildingReviewArchive(fixture.bytes, {...fixture, reference}), /audit checksum|summary or pointer/);
  }
  const document = structuredClone(fixture.document);
  document.properties["opengeo:analysis"].buildingReview.decisions[0].reason = "Changed reason with a newly checked object.";
  await assert.rejects(verifyBuildingReviewArchive((await encoded(document)).bytes,
    {...await encoded(document), reference: fixture.reference}), /audit checksum/);
});

test("reviewed feature selection and per-feature decisions must agree with the complete audit", async () => {
  const fixture = await archive();
  for (const mutate of [
    document => {document.features.pop();},
    document => {document.features[1] = structuredClone(document.features[0]);},
    document => {document.features[0].id = document.properties["opengeo:analysis"].buildingReview.decisions[0].excludedFeatureIds[0];},
    document => {document.features[0].properties.reconciliation.review.reason = "Different decision.";},
    document => {document.features[0].properties.reconciliation.review.reviewerId = "a3000000-0000-4000-8000-000000000004";},
    document => {document.features[0].properties.reconciliation.review.reviewedAt = "2026-10-24T00:00:00Z";},
    document => {document.features[0].properties.reconciliation.review.componentId = document.features[1].id;},
    document => {document.features[0].properties.reconciliation.review.decision = "exclude";},
    document => {document.features[0].properties.input.featureId = "97000000-0000-4000-8000-000000000099";},
    document => {document.features[0].properties.reconciliation.review.extra = "untrusted";},
    document => {document["opengeo:analysis"] = document.properties["opengeo:analysis"]; delete document.properties;}
  ]) {
    const document = structuredClone(fixture.document); mutate(document);
    const object = await encoded(document);
    await assert.rejects(verifyBuildingReviewArchive(object.bytes, {...object, reference: fixture.reference}),
      /retained feature count|selected feature or decision|archive collection/);
  }
});

test("closed review validation rejects contradictory lineage, counts and untrusted decision fields", () => {
  const fixture = reviewed()["opengeo:analysis"];
  for (const mutate of [
    receipt => {receipt.sourceDatasetId = receipt.targetDatasetId.toUpperCase();},
    receipt => {receipt.target_generation = 0;},
    receipt => {receipt.sourceDatasetId = "not-a-uuid";},
    receipt => {receipt.source_count++;},
    receipt => {receipt.operation = "building-reconcile";},
    receipt => {receipt.persisted = true;},
    receipt => {receipt.buildingReview.schemaVersion = "other";},
    receipt => {receipt.buildingReview.method = "automatic-selection";},
    receipt => {receipt.buildingReview.reviewerId = "not-a-reviewer";},
    receipt => {receipt.buildingReview.reviewedAt = "2026-02-30T12:30:00Z";},
    receipt => {receipt.buildingReview.validatedCount = 2;},
    receipt => {receipt.buildingReview.inputFeatureCount = 1001;},
    receipt => {receipt.buildingReview.componentCount--;},
    receipt => {receipt.buildingReview.retainedFeatureCount++;},
    receipt => {receipt.buildingReview.selectedOverlapPairs = 1;},
    receipt => {receipt.buildingReview.decisions.pop();},
    receipt => {receipt.buildingReview.decisions[0].reason = " ";},
    receipt => {receipt.buildingReview.decisions[0].reason = "x".repeat(501);},
    receipt => {receipt.buildingReview.decisions[0].extra = "untrusted";},
    receipt => {receipt.buildingReview.decisions[0].componentId = receipt.buildingReview.decisions[0].excludedFeatureIds[0];},
    receipt => {receipt.buildingReview.decisions[0].selectedFeatureIds.push(receipt.buildingReview.decisions[0].excludedFeatureIds[0]);},
    receipt => {receipt.buildingReview.decisions[1].selectedFeatureIds[0] = receipt.buildingReview.decisions[0].selectedFeatureIds[0];},
    receipt => {receipt.buildingReview.decisions[0].excludedFeatureIds[0] = "target:not-a-uuid";}
  ]) {
    const receipt = structuredClone(fixture); mutate(receipt);
    assert.throws(() => archivedBuildingReviewReceipt(receipt, {distributionId, sha256: placeholder}));
  }
  for (const reference of [{distributionId: "https://example.com/file.geojson", sha256: placeholder},
    {distributionId: distributionId.replace(":original", ":preview"), sha256: placeholder},
    {distributionId, sha256: "A".repeat(64)}, {distributionId, sha256: "a".repeat(63)}]) {
    assert.throws(() => archivedBuildingReviewReceipt(fixture, reference));
  }
});
