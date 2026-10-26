import assert from "node:assert/strict";
import {test} from "node:test";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {sha256Hex} from "../src/lib/managedUpload.js";
import {buildReceptorScreening} from "../src/lib/receptorScreening.js";
import {archivedReceptorScreeningReceipt, verifyReceptorScreeningArchive} from "../src/lib/receptorScreeningArchive.js";
import {receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const distributionId = "urn:opengeo:dataset:b4000000-0000-4000-8000-000000000004:version:b5000000-0000-4000-8000-000000000005:original";
const encode = async document => {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return {bytes, objectSha256: await sha256Hex(new Blob([bytes]))};
};
async function archive(evidenceReview) {
  const output = buildReceptorScreening(receptorScreeningFixture({profile: "polygons"}));
  if (evidenceReview) output["opengeo:analysis"].screening.evidenceReview = evidenceReview;
  const receipt = output["opengeo:analysis"], sha256 = await sha256Hex(new Blob([canonicalJson(receipt.screening)]));
  const reference = archivedReceptorScreeningReceipt(receipt, {distributionId, sha256}).screening;
  const document = {type: "FeatureCollection", features: output.features, properties: {"opengeo:analysis": receipt}};
  return {...await encode(document), receipt, reference, document};
}

test("screening archive retains full scope rows and exact methods behind bounded knowledge summaries", async () => {
  const fixture = await archive();
  assert.equal(fixture.reference.schemaVersion, "opengeo.receptor-screening-summary.1.0.0");
  assert.equal(fixture.reference.rows, undefined);
  assert.equal(fixture.reference.audit.jsonPointer, "/properties/opengeo:analysis/screening");
  assert.equal(fixture.reference.audit.distributionId, distributionId);
  assert.deepEqual(fixture.reference.inputs, fixture.receipt.screening.inputs);
  assert.deepEqual(fixture.reference.scopes, fixture.receipt.screening.scopes);
  const verified = await verifyReceptorScreeningArchive(fixture.bytes, fixture);
  assert.deepEqual(verified.collection, fixture.document);
  assert.equal(verified.receipt.screening.rows.length, 3);
  assert.equal(verified.receipt.screening.scope.impactAssessment, "not-assessed");
  verified.receipt.screening.question = "Edited after readback";
  assert.notEqual(verified.receipt.screening.question, fixture.receipt.screening.question);
});

test("optional social evidence review survives exact original and bounded summary readback without changing the source attributes", async () => {
  const evidenceReview = {schemaVersion: "opengeo.social-baseline-evidence.1.0.0", topic: "settlement",
    sourceDescription: "Mapped settlement inventory", spatialUnit: "Mapped source feature", periodStart: null, periodEnd: null,
    coverage: "unknown", coverageBasis: "", suitability: "unreviewed", suitabilityBasis: "",
    limitations: "Coverage and observation dates remain unknown; overlap is not an impact finding", reviewer: "Data curator",
    reviewedAt: "2026-10-25T12:00:00Z", fields: [{name: "name", meaning: "Unchanged source feature label", unit: null, denominator: null}]};
  const fixture = await archive(evidenceReview);
  assert.deepEqual(fixture.reference.evidenceReview, evidenceReview);
  const verified = await verifyReceptorScreeningArchive(fixture.bytes, fixture);
  assert.deepEqual(verified.receipt.screening.evidenceReview, evidenceReview);
  assert.deepEqual(verified.collection.features, fixture.document.features);
  assert.equal(verified.receipt.screening.scope.impactAssessment, "not-assessed");
  const reference = structuredClone(fixture.reference); reference.evidenceReview.coverage = "declared-complete"; reference.evidenceReview.coverageBasis = "Altered assertion";
  await assert.rejects(verifyReceptorScreeningArchive(fixture.bytes, {...fixture, reference}), /summary or pointer/);
});

test("screening archive verifies object bytes first and rejects altered summary, pointer, report or row bindings", async () => {
  const fixture = await archive();
  await assert.rejects(verifyReceptorScreeningArchive(new TextEncoder().encode("not JSON"), fixture), /object checksum/);
  for (const mutate of [value => {value.audit.jsonPointer = "/features";},
    value => {value.audit.sha256 = "0".repeat(64);}, value => {value.question = "Changed summary";}]) {
    const reference = structuredClone(fixture.reference); mutate(reference);
    await assert.rejects(verifyReceptorScreeningArchive(fixture.bytes, {...fixture, reference}));
  }
  for (const mutate of [document => {document.features.pop();},
    document => {document.features[1] = structuredClone(document.features[0]);},
    document => {document.features[0].properties.screening.areaSquareMeters++;},
    document => {document.properties["opengeo:analysis"].screening.influenceBasis = "Changed audit basis";}]) {
    const document = structuredClone(fixture.document); mutate(document); const object = await encode(document);
    await assert.rejects(verifyReceptorScreeningArchive(object.bytes, {...object, reference: fixture.reference}));
  }
});

test("screening summaries cannot replace exact source generations or accept unknown archive references", async () => {
  const fixture = await archive();
  for (const mutate of [value => {value.source_generation++;}, value => {value.target_count++;},
    value => {value.screening.inputs.receptors.generation++;}, value => {value.persisted = true;}]) {
    const receipt = structuredClone(fixture.receipt); mutate(receipt);
    assert.throws(() => archivedReceptorScreeningReceipt(receipt, fixture.reference.audit));
  }
  assert.throws(() => archivedReceptorScreeningReceipt(fixture.receipt, {distributionId: "https://example.invalid/file", sha256: "a".repeat(64)}));
});
