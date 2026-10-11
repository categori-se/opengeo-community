// Catalog facts only: no provider probes, downloads or processing on inspection.
export function CatalogPreservationStatus({dataset, detailsHref, compact = false}) {
  const root = document.createElement("div");
  root.className = "catalog-preservation-status";
  const summary = dataset.preservationSummary;
  const badge = document.createElement("span");
  badge.className = "platform-badge";
  badge.textContent = summary?.sourceVersion ? "Registered source"
    : summary?.metadataPreserved ? "Provider metadata retained"
    : "Catalog resource";
  let facts = root;
  if (compact) {
    const disclosure = document.createElement("details");
    const heading = document.createElement("summary");
    heading.append(badge);
    facts = document.createElement("div");
    facts.className = "catalog-preservation-status";
    disclosure.append(heading, facts);
    root.append(disclosure);
  } else root.append(badge);
  const detail = document.createElement("small");
  detail.textContent = summary?.metadataPreserved
    ? "Provider metadata retained; view layer details."
    : "View layer details for recorded metadata.";
  facts.append(detail);
  if (summary?.sourceVersion) {
    const connection = document.createElement("small");
    connection.textContent = "Connection settings saved · live availability not checked";
    if (summary.connectionRecordedAt) connection.title = `Connection revision ${summary.sourceVersion} recorded ${summary.connectionRecordedAt}. ${summary.connectionValidation === "syntax_only" ? "Address syntax validated; no health check implied." : "Inspect the recorded verification evidence."}`;
    facts.append(connection);
  }
  const backups = document.createElement("small");
  backups.textContent = summary?.mapArchives > 0
    ? `Backups · ${summary.mapArchives} linked map ${summary.mapArchives === 1 ? "copy" : "copies"}; choose explicitly`
    : summary?.dataPreserved ? "Backups · dataset inventory linked; no map copy for this revision"
    : summary ? "Backups · no dataset inventory linked to this record"
    : "Backups · linkage not reported";
  facts.append(backups);
  if (detailsHref) {
    const link = document.createElement("a");
    link.href = detailsHref;
    link.textContent = "Layer details";
    facts.append(link);
    if (summary?.mapArchives > 0 || summary?.dataPreserved || summary?.metadataPreserved) {
      const backupLink = document.createElement("a");
      backupLink.href = detailsHref + "#archives";
      backupLink.textContent = "Backup evidence";
      facts.append(backupLink);
    }
  }
  return root;
}
