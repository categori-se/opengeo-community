/** CKAN's API is a source adapter. DCAT metadata and native resource access remain authoritative. */
export function parseCkanSearch(value) {
  if (!value || !Array.isArray(value.datasets) || value.datasets.length > 20
    || !Number.isSafeInteger(value.total) || value.total < 0
    || !Number.isSafeInteger(value.start) || value.start < 0 || value.start > 10000
    || !Number.isSafeInteger(value.rows) || value.rows < 1 || value.rows > 20
    || value.datasets.length > value.rows
    || (value.next_start !== null && (!Number.isSafeInteger(value.next_start)
      || value.next_start !== value.start + value.datasets.length
      || !value.datasets.length || value.next_start >= value.total))) throw Error("invalid_ckan_search");
  const sourceUrl = ckanUrl(value.source_url);
  const datasets = value.datasets.map(item => ({id: ckanId(item?.id), name: ckanId(item?.name), title: text(item?.title, 300)}));
  if (new Set(datasets.map(item => item.id)).size !== datasets.length) throw Error("invalid_ckan_search");
  return {sourceUrl, datasets, total: value.total, start: value.start, rows: value.rows, nextStart: value.next_start};
}

export function parseCkanInspection(value, datasetId, sourceUrl) {
  const packageValue = value?.package;
  if (!packageValue || packageValue.private !== false || packageValue.state !== "active"
    || ![ckanId(packageValue.id), ckanId(packageValue.name)].includes(ckanId(datasetId))
    || !/^[0-9a-f]{64}$/.test(value.package_sha256)
    || value.dcat?.["@type"] !== "dcat:Dataset"
    || value.report?.ckan?.sourceUrl !== ckanUrl(sourceUrl)
    || value.report.ckan.packageId !== packageValue.id
    || value.report.ckan.packageSha256 !== value.package_sha256
    || !Array.isArray(packageValue.resources ?? []) || (packageValue.resources?.length ?? 0) > 64) {
    throw Error("invalid_ckan_inspection");
  }
  return {package: structuredClone(packageValue), packageSha256: value.package_sha256,
    dcat: structuredClone(value.dcat), report: structuredClone(value.report)};
}

export function parseCkanPreview(value, resourceId) {
  if (value?.resource_id !== ckanId(resourceId) || value.limit !== 20
    || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 64
    || !Array.isArray(value.records) || value.records.length > 20
    || value.custody !== "referenced") throw Error("invalid_ckan_preview");
  const fields = value.fields.map(field => text(field, 100));
  if (new Set(fields).size !== fields.length || value.records.some(row => !row
    || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).some(field => !fields.includes(field)))) throw Error("invalid_ckan_preview");
  return {fields, records: structuredClone(value.records), resourceId, limit: 20};
}

export function ckanUrl(value) {
  const url = new URL(text(value, 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== "443")) throw Error("invalid_ckan_url");
  return url.href.replace(/\/+$/, "");
}
export function ckanId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw Error("invalid_ckan_identifier");
  return value;
}
function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error("invalid_ckan_response");
  return value;
}
