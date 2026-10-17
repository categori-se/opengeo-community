import {ResourceKnowledge} from "./ResourceKnowledge.js";
import {metadataCard, recordedLayerMetadata} from "./LayerMetadataCards.js";
import {layerHref} from "../lib/applicationRoutes.js";
import {placeReferences} from "../lib/geographicReferences.js";

export function AuthoredResourceMetadata({adapter, kind, id, projectContext = null}) {
  if (!["project", "publication"].includes(kind) || !id) throw Error("Authored resource identity required");
  const root = document.createElement("details");
  root.className = "authored-resource-metadata";
  const summary = document.createElement("summary");
  summary.textContent = kind === "project" ? "Project metadata" : "Publication metadata";
  root.append(summary);
  const context = document.createElement("section");
  context.className = "project-metadata-context";
  context.style.minWidth = "0";
  context.style.overflowWrap = "anywhere";
  if (kind === "project") root.append(context);
  root.updateProjectContext = value => {
    context.replaceChildren();
    if (kind !== "project" || !value || value.map?.id !== id) return;
    renderProjectContext(context, value, adapter.kind);
  };
  root.updateProjectContext(projectContext);
  // Opening metadata is deliberate; the shared editor loads only on request.
  root.addEventListener("toggle", () => {
    if (!root.open || root.dataset.mounted) return;
    root.dataset.mounted = "true";
    const editor = ResourceKnowledge({adapter, resourceKind: kind, resourceId: id});
    root.append(editor);
    if (kind === "project") void editor.load();
  });
  return root;
}

function renderProjectContext(root, {map, datasets = [], sources = [], knowledgeByDataset = new Map()}, adapterKind) {
  const layers = Array.isArray(map.definition?.layers) ? map.definition.layers.filter(layer => layer && typeof layer === "object") : [];
  root.append(node("h2", map.name || "Saved Project"));
  if (map.description) root.append(node("p", map.description));
  root.append(metadataCard("Saved composition", [
    ["Project revision", map.version], ["Layers", layers.length], ["Project ID", map.id],
    ...(map.updatedAt ? [["Saved", map.updatedAt]] : [])
  ]));
  const list = node("ol");
  list.setAttribute("aria-label", "Layers in this Project");
  const byId = new Map(datasets.map(dataset => [dataset.id, dataset]));
  const sourceById = new Map(sources.map(source => [source.datasetId, source]));
  for (const layer of layers) {
    const dataset = byId.get(layer.datasetId), source = sourceById.get(layer.datasetId);
    const item = node("li"), title = node("strong", layer.title || dataset?.name || "Saved Layer");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(layer.datasetId ?? "")) {
      const link = node("a");link.href = layerHref(layer.datasetId, {adapterKind});link.append(title);item.append(link);
    } else item.append(title);
    const facts = [layer.sourceType,
      Number.isSafeInteger(layer.sourceVersion) ? `saved source revision ${layer.sourceVersion}` : null,
      layer.datasetVersionId ? `saved data version ${layer.datasetVersionId}` : null].filter(Boolean);
    if (facts.length) item.append(node("p", facts.join(" · ")));
    if (layer.description) item.append(node("p", layer.description));
    if (layer.sourceUrl) item.append(node("p", `Saved endpoint: ${layer.sourceUrl}`));
    if (layer.attribution) item.append(node("p", `Saved attribution: ${layer.attribution}`));
    if (dataset) {
      const candidate = knowledgeByDataset.get(layer.datasetId);
      const knowledge = candidate?.datasetId === layer.datasetId ? candidate : null;
      const observed = recordedLayerMetadata(knowledge).metadata;
      const details = node("details");details.append(node("summary", "Catalog record and source"));
      if (dataset.description) details.append(node("p", dataset.description));
      if (observed?.description || observed?.serviceDescription) {
        const parsed = new root.ownerDocument.defaultView.DOMParser().parseFromString(observed.description || observed.serviceDescription, "text/html");
        details.append(node("p", parsed.body.textContent));
      }
      const recorded = [
        ["Catalog name", dataset.name], ["Format", dataset.format],
        ["Current data version", dataset.currentVersionNumber],
        ["Current connection revision", source?.versionNumber], ["Current endpoint", source?.sourceUrl],
        ["Attribution", observed?.copyrightText || source?.configuration?.attribution],
        ["Recorded license", source?.configuration?.license],
        ["Catalog tags", dataset.tags?.length ? dataset.tags.join(", ") : null]
      ].filter(([, value]) => value !== undefined && value !== null && value !== "");
      if (recorded.length) details.append(metadataCard("Recorded Layer metadata", recorded));
      if (knowledge?.document) {
        for (const ref of placeReferences(knowledge.document)) details.append(node("p",
          `${ref.name} · ${ref.relationship} · ${ref.level} · ${ref.provenance.replaceAll("_", " ")}${ref.identity ? ` · ${ref.identity}` : ""}`));
      }
      item.append(details);
    }
    list.append(item);
  }
  root.append(node("h3", "Layers in this Project"), list);
  if (!layers.length) root.append(node("p", "No Layers in this saved Project revision."));
}

function node(tag, text = "") {
  const element = document.createElement(tag);element.textContent = text;return element;
}

export function guardAuthoredMetadata(root) {
  const document = root.ownerDocument, browser = document.defaultView;
  const accountValues = new Map();
  const rememberAccounts = () => {
    for (const field of document.querySelectorAll('select[aria-label="Studio account"]')) {
      if (!accountValues.has(field)) accountValues.set(field, field.value);
    }
    for (const field of accountValues.keys()) if (!field.isConnected) accountValues.delete(field);
  };
  rememberAccounts();
  const blocked = () => root.isConnected && [...root.querySelectorAll(".resource-knowledge, .artifact-releases, .publication-artifact-references, .project-print-editor")].find(editor => editor.shouldBlockNavigation?.());
  const check = () => {
    const editor = blocked();
    if (!editor) return false;
    if (editor.checkDraft) return editor.checkDraft();
    const status = editor.querySelector('[role="status"]');
    if (status) status.textContent = "Save or discard the metadata draft before leaving or refreshing.";
    editor.closest("details.authored-resource-metadata")?.setAttribute("open", "");
    return true;
  };
  const href = browser.location.href;
  const click = event => {
    const link = event.target.closest?.("a[href]");
    const leaves = link && !link.hasAttribute("download") && (!link.target || link.target === "_self")
      && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    if ((leaves || event.target.closest?.(".gis-account-command")) && check()) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const focus = event => {
    if (event.target.matches?.('select[aria-label="Studio account"]')) accountValues.set(event.target, event.target.value);
  };
  const change = event => {
    if (!event.target.matches?.('select[aria-label="Studio account"]')) return;
    if (check()) {
      if (accountValues.has(event.target)) event.target.value = accountValues.get(event.target);
      event.preventDefault(); event.stopImmediatePropagation();
    } else accountValues.set(event.target, event.target.value);
  };
  const unload = event => {if (blocked()) {event.preventDefault(); event.returnValue = "";}};
  const pop = event => {if (root.isConnected && check()) {browser.history.pushState(null, "", href); event.stopImmediatePropagation();}};
  document.addEventListener("click", click, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("change", change, true);
  browser.addEventListener("beforeunload", unload);
  browser.addEventListener("popstate", pop, true);
  let connected = root.isConnected;
  const observer = new browser.MutationObserver(() => {
    rememberAccounts();
    if (root.isConnected) connected = true;
    else if (connected) dispose();
  });
  observer.observe(root.ownerDocument.documentElement, {childList:true, subtree:true});
  function dispose() {
    document.removeEventListener("click", click, true);
    document.removeEventListener("focusin", focus, true);
    document.removeEventListener("change", change, true);
    accountValues.clear(); browser.removeEventListener("beforeunload", unload);
    browser.removeEventListener("popstate", pop, true);observer.disconnect();
  }
  return {check, dispose};
}
