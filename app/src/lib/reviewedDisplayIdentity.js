// The two custody kinds have separate identities; missing fields never match.
export function matchesReviewedDisplay(record, layer, {ticket = false} = {}) {
  if (!layer?.datasetId || record?.dataset_id !== layer.datasetId) return false;
  if (layer.sourceType === "governed-dataset") {
    return typeof layer.datasetVersionId === "string" && layer.datasetVersionId.length > 0
      && record.dataset_version_id === layer.datasetVersionId
      && record.source_version == null && record.source_url == null;
  }
  return record.dataset_version_id == null
    && Number.isSafeInteger(layer.sourceVersion) && layer.sourceVersion > 0
    && record.source_version === layer.sourceVersion
    && (!ticket || (typeof layer.sourceUrl === "string" && layer.sourceUrl.length > 0
      && record.source_url === layer.sourceUrl));
}
