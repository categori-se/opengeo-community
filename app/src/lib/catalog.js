export function byId(records, key) {
  return new Map(records.map((record) => [record[key], record]));
}

export function datasetsForWorkspace(datasets, workspaceId) {
  return datasets.filter((dataset) => dataset.workspaceId === workspaceId);
}

export function objectsForDataset(objects, datasetId) {
  return objects.filter((object) => object.datasetId === datasetId);
}

export function auditForResource(events, resourceId) {
  return events
    .filter((event) => event.resourceId === resourceId)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export function recentAuditEvents(events, limit = 8) {
  return [...events]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

export function catalogSummary({workspaces, datasets, objects, auditEvents}) {
  return [
    {label: "workspaces", value: workspaces.length},
    {label: "datasets", value: datasets.length},
    {label: "objects", value: objects.length},
    {label: "audit events", value: auditEvents.length}
  ];
}

export function countBy(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = record[key] ?? "unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({name, count}));
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("en", {month: "short", day: "numeric", year: "numeric"}).format(new Date(value));
}
