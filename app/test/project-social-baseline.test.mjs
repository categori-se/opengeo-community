import assert from "node:assert/strict";
import {test} from "node:test";
import {buildReceptorScreening, validateReceptorScreeningReport, validateReceptorScreeningSummary} from "../src/lib/receptorScreening.js";
import {archivedReceptorScreeningReceipt} from "../src/lib/receptorScreeningArchive.js";
import {composeProjectSocialBaseline, readProjectSocialReview, validateProjectSocialBaselineSelection} from "../src/lib/projectSocialBaseline.js";
import {receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const observedAt = "2026-10-25T12:05:00Z";
const datasetId = "b4000000-0000-4000-8000-000000000004", datasetVersionId = "b5000000-0000-4000-8000-000000000005";
const selectedLayer = {layerId: "reviewed-layer", title: "Reviewed settlement evidence", sourceType: "governed-dataset", datasetId, datasetVersionId, sourceVersion: 1};
const review = (topic = "settlement") => ({schemaVersion: "opengeo.social-baseline-evidence.1.0.0", topic,
  sourceDescription: "Mapped settlement inventory", spatialUnit: "Mapped source feature", periodStart: null, periodEnd: null,
  coverage: "unknown", coverageBasis: "", suitability: "unreviewed", suitabilityBasis: "",
  limitations: "Source coverage, observation date and social meaning remain unknown", reviewer: "Data curator", reviewedAt: observedAt,
  fields: [{name: "name", meaning: "Unchanged source feature label", unit: null, denominator: null}]});
function fixture(topic = "settlement") {
  const collection = buildReceptorScreening(receptorScreeningFixture({profile: "polygons"}));
  collection["opengeo:analysis"].screening.evidenceReview = review(topic);
  const receipt = archivedReceptorScreeningReceipt(collection["opengeo:analysis"], {
    distributionId: `urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`, sha256: "a".repeat(64)});
  const knowledge = {datasetId, version: 12, document: {schemaVersion: "1.0.0", metadata: {normalized: [{subject: "resource",
    property: "http://www.w3.org/ns/prov#wasGeneratedBy", value: receipt}]}}};
  return {collection, receipt, knowledge};
}
function resident(topic = "settlement", layerId = topic) {
  return readProjectSocialReview({layer: {layerId, title: `${topic} evidence`, sourceType: "geojson-object"}, collection: fixture(topic).collection, observedAt});
}

test("resident and catalog sources compose one footprint while preserving separate evidence, scope units and missing topics", () => {
  const {knowledge} = fixture("demographic-vulnerability");
  const first = readProjectSocialReview({layer: selectedLayer, knowledge, observedAt});
  const second = resident("settlement");
  const overview = composeProjectSocialBaseline({question: "What evidence supports this baseline?", reviews: [first, second]});
  assert.equal(first.representation, "catalog-metadata-summary"); assert.equal(first.metadataRevision, 12);
  assert.equal(first.auditVerification, "not-downloaded"); assert.equal(first.report.rows, undefined);
  assert.equal(second.representation, "resident-full-report"); assert.equal(second.metadataRevision, null);
  assert.equal(second.report.rows, undefined);
  assert.deepEqual(overview.footprint, first.report.inputs.footprint);
  assert.deepEqual(overview.topics.map(topic => topic.status), ["reviewed-source", "reviewed-source", "not-supplied", "not-supplied"]);
  assert.equal(overview.topics[0].review.report.evidenceReview.coverage, "unknown");
  assert.equal(overview.scope.sourceAttributes, "not-summed-weighted-or-prorated");
  assert.equal(overview.scope.rights, "unknown"); assert.equal(overview.scope.impactAssessment, "not-assessed");
  assert.equal(overview.totalAreaSquareMeters, undefined); assert.equal(overview.population, undefined);
  assert.equal(overview.topics[0].review.report.audit.distributionId, knowledge.document.metadata.normalized[0].value.screening.audit.distributionId);
});

test("empty and unsuccessful selections retain explicit missingness without fabricating topics or zero observations", () => {
  const empty = composeProjectSocialBaseline({question: "What is missing?", reviews: []});
  assert.equal(empty.footprint, null); assert(empty.topics.every(topic => topic.status === "not-supplied" && topic.review === null));
  const unresolvedSelections = ["unloaded", "unavailable", "unreviewed", "invalid"].map((status, index) => ({layerId: `layer-${index}`, title: "Selected source", status, reason: "No supported review is available in this session."}));
  const overview = composeProjectSocialBaseline({question: "What is missing?", reviews: [], unresolvedSelections});
  assert.deepEqual(overview.unresolvedSelections, unresolvedSelections);
  assert(overview.topics.every(topic => topic.status === "not-supplied"));
  unresolvedSelections[0].reason = "Changed caller object"; assert.notEqual(overview.unresolvedSelections[0].reason, unresolvedSelections[0].reason);
  assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: [resident()], unresolvedSelections: [{layerId: "settlement", title: "Again", status: "invalid", reason: "Conflict"}]}), /more than once/);
});

test("metadata exact output identity and outer source pins cannot be substituted; revision is not dataset version", () => {
  const {knowledge} = fixture();
  assert.equal(readProjectSocialReview({layer: selectedLayer, knowledge, observedAt}).metadataRevision, 12);
  for (const change of [value => {value.datasetId = "b6000000-0000-4000-8000-000000000006";},
    value => {value.version = 0;},
    value => {value.document.metadata.normalized[0].value.source_generation++;},
    value => {value.document.metadata.normalized[0].value.target_count++;},
    value => {value.document.metadata.normalized[0].value.screening.audit.distributionId = `urn:opengeo:dataset:${datasetId}:version:b6000000-0000-4000-8000-000000000006:original`;},
    value => {value.document.metadata.normalized[0].value.screening.audit.jsonPointer = "/features";},
    value => {value.document.metadata.normalized[0].value.screening.audit.sha256 = "invalid";},
    value => {value.document.metadata.normalized.push(structuredClone(value.document.metadata.normalized[0]));}]) {
    const altered = structuredClone(knowledge); change(altered);
    assert.throws(() => readProjectSocialReview({layer: selectedLayer, knowledge: altered, observedAt}));
  }
  const wrongVersion = {...selectedLayer, datasetVersionId: "b6000000-0000-4000-8000-000000000006"};
  assert.throws(() => readProjectSocialReview({layer: wrongVersion, knowledge, observedAt}), /another catalog Layer or version/);
});

test("only the designated normalized resource assertion qualifies, with no inference from curated metadata", () => {
  const {knowledge} = fixture();
  knowledge.document.metadata.curated = knowledge.document.metadata.normalized;
  knowledge.document.metadata.normalized = [];
  assert.throws(() => readProjectSocialReview({layer: selectedLayer, knowledge, observedAt}), /exactly one/);
});

test("resident feature bindings, source attributes and ambiguous representations are checked before dropping rows", () => {
  const {collection, knowledge} = fixture();
  for (const change of [value => {value.features[0].properties.screening.areaSquareMeters++;},
    value => {value.features[0].properties.source.name = "Changed one scope only";},
    value => {value["opengeo:analysis"].source_generation++;},
    value => {value["opengeo:analysis"].screening.evidenceReview.fields[0].name = "absent";},
    value => {value.properties = {"opengeo:analysis": structuredClone(value["opengeo:analysis"])}; value.properties["opengeo:analysis"].screening.question = "Conflicting report";}]) {
    const altered = structuredClone(collection); change(altered);
    assert.throws(() => readProjectSocialReview({layer: selectedLayer, collection: altered, observedAt}));
  }
  assert.throws(() => readProjectSocialReview({layer: selectedLayer, collection, knowledge, observedAt}), /resident data or recorded metadata/);
  const portable = {type: collection.type, features: collection.features, properties: {"opengeo:analysis": collection["opengeo:analysis"]}};
  assert.equal(readProjectSocialReview({layer: selectedLayer, collection: portable, observedAt}).representation, "resident-full-report");
});

test("unreviewed sources remain explicit; inputs and output objects are detached", () => {
  const {collection} = fixture(); delete collection["opengeo:analysis"].screening.evidenceReview;
  assert.throws(() => readProjectSocialReview({layer: selectedLayer, collection, observedAt}), error => error.code === "social_baseline_unreviewed");
  const reviewed = resident(), overview = composeProjectSocialBaseline({question: "Which evidence?", reviews: [reviewed]});
  reviewed.report.evidenceReview.sourceDescription = "Mutated";
  assert.notEqual(overview.topics[1].review.report.evidenceReview.sourceDescription, "Mutated");
  const {knowledge} = fixture(); const snapshot = readProjectSocialReview({layer: selectedLayer, knowledge, observedAt});
  knowledge.document.metadata.normalized[0].value.screening.question = "Mutated";
  assert.notEqual(snapshot.report.question, "Mutated");
});

test("composition rejects mixed footprints, repeated Layers and repeated topics, retaining distinct influence questions", () => {
  const first = resident(), second = resident("land-use");
  for (const key of ["datasetId", "generation", "featureCount"]) {
    const altered = structuredClone(second), pin = altered.report.inputs.footprint;
    if (key === "datasetId") pin[key] = "b6000000-0000-4000-8000-000000000006"; else pin[key]++;
    for (const receipt of altered.report.nativeReceipts) if (receipt.targetDatasetId === second.report.inputs.footprint.datasetId) {
      if (key === "datasetId") receipt.targetDatasetId = pin[key];
      else receipt[key === "generation" ? "target_generation" : "target_count"] = pin[key];
    }
    assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: [first, altered]}), /same footprint/);
  }
  assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: [first, first]}), /more than once/);
  assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: [first, resident("settlement", "second-layer")]}), /one reviewed source per/);
  second.report.influenceBasis = "Separate source-specific study extent"; second.report.question = "A distinct source question";
  second.report.inputs.influence.datasetId = "b6000000-0000-4000-8000-000000000006";
  second.report.nativeReceipts[1].targetDatasetId = second.report.inputs.influence.datasetId;
  const overview = composeProjectSocialBaseline({question: "Shared Project question", reviews: [first, second]});
  assert.equal(overview.topics[3].review.report.question, "A distinct source question");
  assert.equal(overview.topics[3].review.report.influenceBasis, "Separate source-specific study extent");
});

test("summary validation rejects fabricated rows, invalid counts and impossible geometric measures without inventing report rows", () => {
  const {receipt} = fixture(); const summary = receipt.screening;
  assert.deepEqual(validateReceptorScreeningSummary(summary), summary);
  for (const change of [value => {value.rows = [];}, value => {value.scopes.footprint.featureCount++;},
    value => {value.scopes.influence.positionCount = -1;}, value => {value.scopes.footprint.areaSquareMeters = Infinity;},
    value => {value.scopes.footprint.pointCount = 1;}, value => {value.scopes.influence.positionCount = 50_000;},
    value => {value.validatedCount = 3;}]) {
    const altered = structuredClone(summary); change(altered); assert.throws(() => validateReceptorScreeningSummary(altered));
  }
});

test("legacy full reports retain their exact serialization while scoped composition and selection stay bounded", () => {
  const {collection} = fixture(), full = collection["opengeo:analysis"].screening, serialized = JSON.stringify(full);
  assert.equal(JSON.stringify(validateReceptorScreeningReport(full)), serialized);
  const config = {schemaVersion: "opengeo.project-social-baseline-selection.1.0.0", question: "  Source question  ", layerIds: ["layer-1", "scratch_processing_123_4"]};
  const result = validateProjectSocialBaselineSelection(config); assert.equal(result.question, "Source question");
  result.layerIds.push("new"); assert.equal(config.layerIds.length, 2);
  for (const change of [value => {value.layerIds.push(value.layerIds[0]);}, value => {value.layerIds = ["bad id"];},
    value => {value.question = "x".repeat(501);}, value => {value.permissions = ["admin"];}, value => {value.layerIds = ["1", "2", "3", "4", "5"]; }]) {
    const altered = structuredClone(config); change(altered); assert.throws(() => validateProjectSocialBaselineSelection(altered));
  }
  assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: Array.from({length: 5}, () => resident())}), /at most four/);
  assert.throws(() => composeProjectSocialBaseline({question: "q", reviews: [], unresolvedSelections: [{layerId: "x", title: "x", status: "invalid", reason: "x".repeat(501)}]}), /500 characters/);
  assert.throws(() => readProjectSocialReview({layer: selectedLayer, knowledge: fixture().knowledge, observedAt: "2026-10-25"}), /timezone/);
  assert.throws(() => readProjectSocialReview({layer: selectedLayer, knowledge: fixture().knowledge, observedAt: "2026-02-30T12:05:00Z"}), /timezone/);
});
