import {canonicalJson} from "./artifactCanonicalJson.js";
import {uuid} from "./apiResponseContracts.js";
import {sha256Hex} from "./managedUpload.js";
import {validateReceptorScreeningReport} from "./receptorScreening.js";

const POINTER = "/properties/opengeo:analysis/screening";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2_200_000;
const plain = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Keep the full bounded screening report in its existing immutable original. */
export function archivedReceptorScreeningReceipt(receipt, {distributionId, sha256} = {}) {
  if (!plain(receipt) || receipt.operation !== "receptor-screen" || receipt.version !== "1.0.0"
    || receipt.persisted !== false || receipt.crs !== "CRS:84") fail("A receptor screening receipt is required.");
  const report = validateReceptorScreeningReport(receipt.screening);
  for (const [role, datasetId, generation, count] of [
    ["receptors", receipt.sourceDatasetId, receipt.source_generation, receipt.source_count],
    ["footprint", receipt.targetDatasetId, receipt.target_generation, receipt.target_count]
  ]) {
    const input = report.inputs[role];
    if (uuid(datasetId, "Screening input dataset ID") !== input.datasetId
      || generation !== input.generation || count !== input.featureCount) fail("Screening input generations or counts do not match.");
  }
  const distribution = typeof distributionId === "string"
    && /^urn:opengeo:dataset:([^:]+):version:([^:]+):original$/.exec(distributionId);
  if (!distribution || typeof sha256 !== "string" || !SHA256.test(sha256)) fail("The screening archive reference is invalid.");
  uuid(distribution[1], "Screening output dataset ID"); uuid(distribution[2], "Screening output version ID");
  const {rows, ...summary} = report;
  return {...structuredClone(receipt), screening: {...summary, schemaVersion: "opengeo.receptor-screening-summary.1.0.0",
    audit: {distributionId, jsonPointer: POINTER, sha256, checksumMethod: "opengeo-canonical-json-sha256"}}};
}

/** Authorize/download through the existing exact-original path before calling. */
export async function verifyReceptorScreeningArchive(bytes, {objectSha256, reference} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES
    || typeof objectSha256 !== "string" || !SHA256.test(objectSha256)) fail("The screening archive bytes or checksum are invalid.");
  const original = new Blob([bytes]);
  if (await sha256Hex(original) !== objectSha256) fail("The screening archive object checksum does not match.");
  let collection;
  try {collection = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(await original.arrayBuffer()));}
  catch {fail("The screening archive is not valid UTF-8 JSON.");}
  if (!plain(collection) || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)
    || collection.features.length > 1_000 || !plain(collection.properties)
    || !plain(reference) || !plain(reference.audit)) fail("A bounded screening archive collection and reference are required.");
  const receipt = collection.properties["opengeo:analysis"];
  const summary = archivedReceptorScreeningReceipt(receipt, reference.audit).screening;
  if (canonicalJson(summary) !== canonicalJson(reference)) fail("The screening archive summary or pointer does not match.");
  if (await sha256Hex(new Blob([canonicalJson(receipt.screening)])) !== reference.audit.sha256) fail("The screening audit checksum does not match.");
  assertReceptorScreeningFeatures(collection.features, receipt.screening);
  return structuredClone({receipt, collection});
}

/** Check row bindings before registration as well as after exact-original readback. */
export function assertReceptorScreeningFeatures(features, report) {
  if (!plain(report) || !Array.isArray(report.rows) || report.rows.length > 1_000) fail("A bounded screening report is required.");
  const rows = new Map(report.rows.map(row => [row.id, row])), seen = new Set();
  if (!Array.isArray(features) || features.length !== rows.size) fail("The screening archive feature count does not match.");
  for (const feature of features) {
    const row = rows.get(feature?.id);
    if (!plain(feature) || feature.type !== "Feature" || !row || seen.has(feature.id)
      || !plain(feature.geometry) || feature.geometry.type !== row.geometryType
      || !plain(feature.properties) || !plain(feature.properties.screening)) fail("A screening archive feature does not match its report.");
    const {id, ...expected} = row;
    if (canonicalJson(feature.properties.screening) !== canonicalJson(expected)) fail("A screening archive feature measurement does not match its report.");
    seen.add(id);
  }
}

function fail(message) {throw Error(message);}
