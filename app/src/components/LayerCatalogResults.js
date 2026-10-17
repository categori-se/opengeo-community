import {layerHref, compositionHref} from "../lib/applicationRoutes.js";
import {CatalogLayerPreview} from "./CatalogLayerPreview.js";

let directorySequence = 0;

// Group recorded identities, never infer a shared service from similar titles.
export function LayerCatalogResults({records, adapter = null, adapterKind = null, loadPreview = null}) {
  const root = document.createElement("div");
  const directoryId = `catalog-directory-${++directorySequence}`;
  const rowCache = new Map(), groupState = new Map();
  const controller = new AbortController(), previews = new Set();
  root.dispose = () => {controller.abort(); for (const preview of previews) preview.dispose?.(); previews.clear();};
  root.className = "layer-catalog-results layer-catalog-directory";
  if (!records.length) {root.append(text("p", "No matching layers or datasets.")); return root;}
  const tools = document.createElement("div"); tools.className = "catalog-directory-tools";
  const grouping = document.createElement("select"); grouping.ariaLabel = "Group catalog entries";
  for (const [value, label] of [["services", "Group by service"], ["datasets", "Group by dataset"], ["projects", "Group by project"]]) {
    const option = text("option", label); option.value = value; grouping.append(option);
  }
  grouping.value = records.some(record => record.service) ? "services" : "datasets";
  const sort = document.createElement("select"); sort.ariaLabel = "Sort this catalog page";
  for (const [value, label] of [["name", "Name A–Z"], ["updated", "Last modified (newest first)"], ["format", "Format"]]) {
    const option = text("option", label); option.value = value; sort.append(option);
  }
  sort.value = "name";
  tools.append(grouping, sort);
  for (const [label, open] of [["Expand groups", true], ["Collapse groups", false]]) {
    const button = text("button", label); button.type = "button";
    button.addEventListener("click", () => {
      for (const group of root.querySelectorAll(".catalog-dataset-group, .catalog-source-group")) group.open = open;
    });
    tools.append(button);
  }
  tools.append(text("small", "Sorting and counts apply to this page"));
  const content = document.createElement("div");
  root.append(tools, content);
  grouping.addEventListener("change", render);
  sort.addEventListener("change", render);
  render();
  return root;

  function render() {
  // Keep this page's disclosure state and preview nodes when reorganizing it.
  // Caches belong to this result set, never to another account or search.
  for (const group of content.querySelectorAll("details[data-group-key]")) {
    groupState.set(group.dataset.groupKey, group.open);
  }
  content.replaceChildren();
  const ordered = [...records].sort((a, b) => {
    const primary = sort.value === "updated" ? (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
      : sort.value === "format" ? String(a.format).localeCompare(String(b.format)) : 0;
    return primary || a.title.localeCompare(b.title, undefined, {sensitivity: "base", numeric: true});
  });
  const groups = new Map(), parents = new Map();
  for (const record of ordered) {
    const key = JSON.stringify([record.projectId, record.datasetId, record.service?.url, record.service?.layerId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  function parentFor(record) {
    if (grouping.value === "datasets") return content;
    const key = grouping.value === "projects" ? record.projectId : record.service?.url ?? "unrecorded";
    if (parents.has(key)) return parents.get(key);
    const parent = document.createElement("details"); parent.className = "catalog-source-group"; parent.open = true;
    parent.dataset.groupKey = JSON.stringify([grouping.value, key]);
    parent.open = groupState.get(parent.dataset.groupKey) ?? true;
    const heading = document.createElement("summary");
    if (grouping.value === "projects") heading.append(text("strong", record.projectName));
    else if (record.service) {
      const url = new URL(record.service.url), name = url.pathname.split("/").at(-2);
      heading.append(text("strong", name), text("span", record.service.kind), text("small", url.host + url.pathname));
      parent.dataset.serviceUrl = record.service.url;
    } else heading.append(text("strong", "Other datasets"), text("small", "No shareable ArcGIS service address in the catalog record"));
    parent.append(heading); content.append(parent); parents.set(key, parent);
    return parent;
  }
  for (const items of groups.values()) {
    const first = items[0];
    const group = document.createElement("details");
    group.className = "catalog-dataset-group"; group.open = true;
    group.dataset.groupKey = JSON.stringify(["dataset", first.projectId, first.datasetId, first.service?.url, first.service?.layerId]);
    group.open = groupState.get(group.dataset.groupKey) ?? true;
    group.dataset.datasetId = first.datasetId;
    const summary = document.createElement("summary");
    summary.append(text("strong", first.datasetName), text("span", `${items.length} ${items.length === 1 ? "entry" : "entries"}`), text("small", first.projectName));
    if (first.service?.layerId !== null && first.service?.layerId !== undefined) {
      summary.append(text("small", `Provider layer ${first.service.layerId}`));
    }
    group.append(summary);
    const scroll = document.createElement("div"); scroll.className = "catalog-directory-scroll";
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", `${first.datasetName} layers`);
    const table = document.createElement("table"); table.className = "catalog-layer-table";
    const head = document.createElement("thead"), labels = document.createElement("tr");
    for (const label of ["Layer / dataset", "Field / style", "Geometry", "Format", "Last modified"]) {
      const th = text("th", label); th.scope = "col"; labels.append(th);
    }
    head.append(labels); table.append(head);
    const body = document.createElement("tbody");
    for (const record of items) {
      const cached = rowCache.get(record);
      if (cached) {body.append(...cached); continue;}
      const row = document.createElement("tr"); row.className = "layer-catalog-entry";
      row.dataset.datasetId = record.datasetId;
      if (record.layerId) row.dataset.layerId = record.layerId;
      const name = document.createElement("td"), field = document.createElement("td");
      const toggle = text("button", record.title); toggle.type = "button";
      toggle.className = "catalog-layer-toggle"; toggle.setAttribute("aria-expanded", "false");
      name.append(toggle); field.append(text("span", record.styleField ?? "—"));
      const colors = record.legend?.colors;
      if (Array.isArray(colors) && colors.length) {
        const ramp = document.createElement("div"); ramp.className = "layer-catalog-ramp";
        ramp.setAttribute("role", "img"); ramp.ariaLabel = `Style: ${record.styleField ?? record.title}`;
        for (const color of colors.slice(0, 32)) {
          const swatch = document.createElement("span");
          if (typeof color === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) swatch.style.backgroundColor = color;
          ramp.append(swatch);
        }
        field.append(ramp);
      }
      const modified = text("td", Number.isFinite(Date.parse(record.updatedAt))
        ? new Date(record.updatedAt).toLocaleDateString() : "—");
      modified.title = "Studio catalog record modified; not the source acquisition date";
      row.append(name, field, text("td", record.geometryType ?? "—"), text("td", record.format ?? "—"), modified);
      const detailRow = document.createElement("tr"); detailRow.hidden = true; detailRow.className = "catalog-layer-detail";
      detailRow.id = `${directoryId}-detail-${rowCache.size}`;
      toggle.setAttribute("aria-controls", detailRow.id);
      const detail = document.createElement("td"); detail.colSpan = 5;
      if (record.description) detail.append(text("p", record.description));
      detail.append(text("p", `${record.layerId ? "Layer view" : "Dataset"} · ${record.sourceType ?? "Source type not recorded"} · ${record.classification ?? "Sensitivity not recorded"}`));
      const actions = document.createElement("div"); actions.className = "layer-catalog-actions";
      if (record.mapId) actions.append(link("Open containing Project", compositionHref(record.mapId, {adapterKind})));
      actions.append(link("Metadata and access", layerHref(record.datasetId, {adapterKind})));
      if (record.service) {
        const provider = link("Provider layer ↗", record.service.layerUrl);
        provider.target = "_blank"; provider.rel = "noopener noreferrer";
        actions.append(provider);
        detail.append(text("p", `${record.service.kind}${record.service.layerId !== null ? ` · layer ${record.service.layerId}` : ""}${record.service.sourceVersion ? ` · source revision ${record.service.sourceVersion}` : ""}. ${record.mapId ? "Saved map" : "Registered connection"} uses ${record.service.renderingSource === "captured_copy" ? "a captured copy" : "the service endpoint"}.`));
      }
      detail.append(actions);
      if ((record.mapId || record.service) && loadPreview) {
        const preview = text("button", "Open map"); preview.type = "button";
        preview.className = "platform-button secondary platform-catalog-open-map";
        preview.setAttribute("aria-expanded", "false");
        const target = document.createElement("div"); target.hidden = true;
        target.id = `${detailRow.id}-map`;
        preview.setAttribute("aria-controls", target.id);
        let loaded = false;
        preview.addEventListener("click", async () => {
          if (controller.signal.aborted) return;
          if (detailRow.hidden) {
            detailRow.hidden = false;
            toggle.setAttribute("aria-expanded", "true");
          }
          target.hidden = !target.hidden;
          preview.setAttribute("aria-expanded", String(!target.hidden));
          if (target.hidden) return;
          if (loaded) {target.querySelector(".map-frame")?.__resize?.(); return;}
          preview.disabled = true;
          const status = text("p", "Loading live source preview…"); status.setAttribute("role", "status");
          target.replaceChildren(status);
          try {
            const content = await CatalogLayerPreview({record, adapter, load: loadPreview, interactive: true, signal: controller.signal});
            if (controller.signal.aborted) {content.dispose?.(); return;}
            previews.add(content); target.replaceChildren(content); loaded = true;
          }
          catch (error) {if (!controller.signal.aborted) status.textContent = `${error?.message || "Preview unavailable"} No archived copy was used.`;}
          finally {if (!controller.signal.aborted) preview.disabled = false;}
        });
        name.append(preview); detail.append(target);
      }
      toggle.addEventListener("click", () => {
        detailRow.hidden = !detailRow.hidden;
        toggle.setAttribute("aria-expanded", String(!detailRow.hidden));
        if (!detailRow.hidden) detail.querySelector(".map-frame")?.__resize?.();
      });
      detailRow.append(detail); body.append(row, detailRow);
      rowCache.set(record, [row, detailRow]);
    }
    table.append(body); scroll.append(table); group.append(scroll); parentFor(first).append(group);
  }
  if (sort.value === "name") {
    for (const container of [content, ...parents.values()]) {
      const children = [...container.children].filter(node => node.matches("details[data-group-key]"));
      children.sort((a, b) => a.querySelector("summary strong").textContent
        .localeCompare(b.querySelector("summary strong").textContent, undefined, {sensitivity: "base", numeric: true}));
      container.append(...children);
    }
  }
  // A retained map may have moved into a differently sized group.
  for (const frame of content.querySelectorAll(".map-frame")) frame.__resize?.();
  }
}
function text(tag, value) {const node = document.createElement(tag); node.textContent = value; return node;}
function link(label, href) {const node = text("a", label); node.href = href; return node;}
