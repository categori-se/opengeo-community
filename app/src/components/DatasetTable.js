import {PermissionBadge} from "./PermissionBadge.js";
import {formatBytes, formatDate} from "../lib/catalog.js";

export function DatasetTable(datasets, {objects = [], workspaceById = new Map(), showWorkspace = false} = {}) {
  const table = document.createElement("table");
  table.className = "data-table";

  const headers = ["Dataset", showWorkspace ? "Workspace" : null, "Type", "Status", "Object", "Updated"].filter(Boolean);
  const thead = table.createTHead();
  const headerRow = thead.insertRow();

  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headerRow.append(th);
  }

  const tbody = table.createTBody();

  for (const dataset of datasets) {
    const object = objects.find((candidate) => candidate.datasetId === dataset.datasetId);
    const row = tbody.insertRow();

    row.append(linkCell(dataset.title, `/datasets/${dataset.datasetId}`, dataset.description));

    if (showWorkspace) {
      row.append(textCell(workspaceById.get(dataset.workspaceId)?.title ?? dataset.workspaceId));
    }

    row.append(textCell([dataset.datasetType, dataset.geometryType].filter(Boolean).join(" / ")));
    row.append(nodeCell(PermissionBadge(dataset.status)));
    row.append(textCell(object ? `${object.objectRole} · ${formatBytes(object.sizeBytes)}` : "No object"));
    row.append(textCell(formatDate(dataset.updatedAt)));
  }

  return table;
}

function linkCell(label, href, detail) {
  const td = document.createElement("td");
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  td.append(link);

  if (detail) {
    const description = document.createElement("div");
    description.style.color = "var(--opengeo-muted)";
    description.style.fontSize = "0.84rem";
    description.textContent = detail;
    td.append(description);
  }

  return td;
}

function nodeCell(node) {
  const td = document.createElement("td");
  td.append(node);
  return td;
}

function textCell(value) {
  const td = document.createElement("td");
  td.textContent = value;
  return td;
}
