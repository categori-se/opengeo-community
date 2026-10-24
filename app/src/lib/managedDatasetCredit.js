const CREDIT = "https://schema.org/creditText";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MANAGED_DATASET_CREDIT_MAX_LENGTH = 1000;
const invalid = () => {throw Error("The saved dataset credit metadata is invalid. Review its knowledge revision.");};

// Select an existing reviewed statement for one exact output distribution.
// Source receipts, licenses and other dataset versions never supply this value.
export function reviewedDatasetCredit({datasetId, datasetVersionId, knowledge} = {}) {
  if (![datasetId, datasetVersionId].every(value => typeof value === "string" && UUID.test(value))) invalid();
  datasetId = datasetId.toLowerCase(); datasetVersionId = datasetVersionId.toLowerCase();
  if (!knowledge || !Number.isSafeInteger(knowledge.version) || knowledge.version < 0
    || knowledge.datasetId !== undefined && knowledge.datasetId.toLowerCase?.() !== datasetId) invalid();
  const document = knowledge.document;
  if (document?.schemaVersion !== "1.0.0" || !Array.isArray(document.distributions) || !Array.isArray(document.metadata?.curated)) invalid();
  const distributionId = `urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`;
  const base = {datasetId, datasetVersionId, distributionId, knowledgeVersion: knowledge.version};
  const result = (status, reason, attribution = null, claimCount = 0) => ({...base, status, attribution, reason, claimCount});
  if (knowledge.version === 0) return result("unknown", "No saved knowledge revision supplies credit.");
  const distributions = document.distributions.filter(value => value?.id === distributionId);
  if (!distributions.length) return result("unknown", "This exact dataset version has no distribution in the saved knowledge.");
  if (distributions.length !== 1) return result("conflict", "The exact distribution identity is duplicated.");
  const claims = document.metadata.curated.filter(value => value?.subject === distributionId && value.property === CREDIT);
  if (!claims.length) return result("unknown", "No reviewed credit is recorded for this exact dataset version.");
  const candidate = claim => {
    if (claim.provenance === "unknown" && claim.value === null) return {status:"unknown", value:null};
    if (typeof claim.value !== "string" || !claim.value.trim()
      || [...claim.value].length > MANAGED_DATASET_CREDIT_MAX_LENGTH
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(claim.value)) invalid();
    return {status:claim.provenance === "curator_asserted" ? "available" : "unreviewed", value:claim.value.trim()};
  };
  const selected = claims.map(candidate);
  if (selected.length > 1) {
    if (selected.every(value => value.status === "available" && value.value === selected[0].value))
      return result("duplicate", "Identical reviewed credit is recorded more than once; one distinct text is used.", selected[0].value, selected.length);
    return result("conflict", "Multiple credit statements require review before selecting an attribution.", null, selected.length);
  }
  if (selected[0].status === "unknown") return result("unknown", "Credit is explicitly unknown for this exact dataset version.", null, 1);
  if (selected[0].status === "unreviewed") return result("unreviewed", "The exact-version credit has not been recorded as a reviewed curator statement.", null, 1);
  return result("available", "Reviewed credit selected from the exact-version distribution.", selected[0].value, 1);
}
