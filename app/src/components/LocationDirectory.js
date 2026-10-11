import {ProviderContext} from "./ProviderContext.js";
import {LocationResourceLinks} from "./LocationResourceLinks.js";
import {LocationHierarchy} from "./LocationHierarchy.js";
import {ResourceSharing} from "./CollectionSharing.js";
import {locationHref, layerHref} from "../lib/applicationRoutes.js";
import {geoIdentity, geoPath} from "d3";
import {geojsonBounds} from "../lib/mapLayers.js";
import {placeIdentity} from "../lib/geographicReferences.js";

const BOUNDARY_METHOD = "Boundary source selected in Geographic tags";
const SOURCE_PROPERTY = "http://purl.org/dc/terms/source";
const DERIVED_PROPERTY = "http://www.w3.org/ns/prov#wasDerivedFrom";

const emptyDocument = title => ({title, canonical_uri: null, aliases: [], identifiers: [], geometry: null,
  knowledge: {schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []}});

export function LocationDirectory({adapter, onSearchTaggedLayers, onUseSavedSearchArea}) {
  const root = node("section"), status = node("p"), controls = node("fieldset"), list = node("div"), editor = node("div");
  root.className = "location-directory"; status.setAttribute("role", "status");
  const browser = root.ownerDocument.defaultView;
  let busy = false, dirty = false, parentDirty = false, linksDirty = false, disposed = false, record = null, offset = 0;
  let searchTagged = null, useArea = null, resourceLinks = null;
  const title = field("input", "New Geographic tag name"); title.maxLength = 200;
  const more = button("Load Geographic tags", () => run(load));
  controls.append(title, button("Create Geographic tag", () => {
    if (!title.value.trim()) {status.textContent = "Enter a Geographic tag name."; return;}
    void run(async () => {
      const receipt = await adapter.saveLocation(emptyDocument(title.value));
      title.value = "";
      list.append(button("Reopen created Geographic tag", () => {if (!dirty && !parentDirty && !linksDirty) void run(() => open(receipt.id));}));
      await open(receipt.id);
    }, "Geographic tag created. Its geometry and metadata are not yet recorded.");
  }));
  const create = disclosure("New Geographic tag", controls);
  list.className = "location-list"; editor.className = "location-selected";
  root.append(status, create, list, more, editor);
  root.shouldBlockNavigation = () => dirty || parentDirty || linksDirty || busy;
  root.hasUnsavedChanges = () => dirty || parentDirty || linksDirty;
  root.currentHref = () => record ? locationHref(record.id, {adapterKind: adapter.kind}) : browser.location.href;
  const leaving = event => {if (dirty || parentDirty || linksDirty || busy) {event.preventDefault(); event.returnValue = "";}};
  browser.addEventListener("beforeunload", leaving);
  root.dispose = () => {disposed = true; resourceLinks?.dispose?.(); browser.removeEventListener("beforeunload", leaving);};
  if (typeof adapter?.listLocations !== "function") {
    controls.disabled = true; status.textContent = "Geographic tags require a connected Studio account.";
  } else void run(async () => {
    const query = new URL(browser.location.href).searchParams, id = query.get("location");
    await load();
    if (query.get("view") === "locations" && id) {locationHref(id); await open(id);}
  });
  return root;

  async function run(action, success = "") {
    if (busy || disposed) return;
    busy = true; lock(); status.textContent = "Loading…";
    try {await action(); if (!disposed) status.textContent = success;}
    catch (error) {if (!disposed) status.textContent = error?.status === 409
      ? "The Geographic tag changed. Your draft is retained. Discard and reload to review the saved revision."
      : error instanceof SyntaxError ? "A JSON field is invalid or a provider observation is unfinished. Add or clear it before saving. Your draft is retained."
      : error?.code === "boundary_source_review_required" ? "Review the boundary source before saving edited geometry. Your draft is retained."
      : "The request could not finish. Your draft is retained; check the fields and your account access, then retry.";}
    finally {busy = false; if (!disposed) lock();}
  }
  function lock() {
    controls.disabled = busy || dirty || parentDirty || linksDirty;
    more.disabled = busy || dirty || parentDirty || linksDirty;
    editor.querySelectorAll("fieldset").forEach(item => {item.disabled = busy || (item.dataset.edit === "true" && record?.role === "reader")
      || (item.dataset.content === "true" && (parentDirty || linksDirty))
      || (item.dataset.hierarchy === "true" && (dirty || linksDirty))
      || (item.dataset.links === "true" && (dirty || parentDirty));});
    if (searchTagged) searchTagged.disabled = busy || dirty || parentDirty || linksDirty || !recognizedPlace(record?.document.canonical_uri);
    if (useArea) useArea.disabled = busy || dirty || parentDirty || linksDirty || !savedBounds(record?.document.geometry);
  }
  async function load() {
    const page = await adapter.listLocations({limit: 50, offset});
    if (disposed) return;
    if (!offset) list.replaceChildren();
    if (!offset) {
      const table = node("table"); table.setAttribute("aria-label", "Saved Geographic tags");
      table.append(node("tbody")); list.append(table);
    }
    for (const item of page) {
      const row = node("tr"), cell = node("td"), revision = node("td", `v${item.revision}`);
      const select = button(item.title, () => {
      if (dirty || parentDirty || linksDirty) {status.textContent = "Save or discard your draft before opening another Geographic tag."; return;}
      void run(() => open(item.id));
      });
      select.dataset.locationId = item.id; select.setAttribute("aria-pressed", String(item.id === record?.id));
      cell.append(select); row.append(cell, revision); list.querySelector("tbody").append(row);
    }
    offset += page.length; more.hidden = page.length < 50; more.textContent = "Load more Geographic tags";
    if (!offset) list.textContent = "No Geographic tags yet.";
  }
  async function open(id) {
    const next = await adapter.getLocation(id);
    if (disposed) return;
    record = next; dirty = false; parentDirty = false; linksDirty = false;
    browser.history.replaceState(null, "", locationHref(id, {adapterKind: adapter.kind}));
    list.querySelectorAll("button[data-location-id]").forEach(item => {
      item.setAttribute("aria-pressed", String(item.dataset.locationId === id));
      if (item.dataset.locationId === id) {item.textContent = next.document.title; item.closest("tr").lastElementChild.textContent = `v${next.revision}`;}
    });
    await render();
  }
  async function render() {
    resourceLinks?.dispose?.(); resourceLinks = null;
    let pendingObservation = false;
    let selectedBoundary = null;
    let manualGeometryEdited = false;
    const document = record.document, form = node("fieldset"), recovery = node("fieldset");
    form.dataset.edit = "true"; form.dataset.content = "true";
    const name = field("input", "Geographic tag name", document.title); name.maxLength = 200;
    const uri = field("input", "Canonical URI", document.canonical_uri ?? ""); uri.maxLength = 2048;
    const aliases = field("textarea", "Other names, one per line", document.aliases.join("\n"));
    const initialAliases = aliases.value;
    const geometry = field("textarea", "Geometry GeoJSON", JSON.stringify(document.geometry, null, 2));
    geometry.maxLength = 300000;
    const identifiers = field("textarea", "External identifiers JSON", JSON.stringify(document.identifiers, null, 2));
    identifiers.maxLength = 270000;
    const knowledge = field("textarea", "Recorded knowledge JSON", JSON.stringify(document.knowledge, null, 2)); knowledge.maxLength = 100000;
    const previousSource = document.knowledge.metadata.curated.find(claim => claim.method === BOUNDARY_METHOD)?.value;
    const source = field("input", "Boundary source URI", previousSource?.["@id"] ?? ""); source.maxLength = 2048;
    const sourceVersion = field("input", "Boundary source revision", previousSource?.revision ?? ""); sourceVersion.maxLength = 200;
    const sourceReview = field("input", "I reviewed the boundary source for this edited geometry"); sourceReview.type = "checkbox";
    const sourceReviewLabel = node("label"); sourceReviewLabel.append(sourceReview, node("span", "I reviewed the boundary source for this edited geometry")); sourceReviewLabel.hidden = true;
    const advanced = node("details"); advanced.append(node("summary", "Identifiers and retained knowledge"), identifiers, knowledge);
    const context = ProviderContext({geometry: document.geometry, canEdit: record.role !== "reader",
      getKnowledge: () => JSON.parse(knowledge.value),
      setKnowledge: value => {knowledge.value = JSON.stringify(value, null, 2); dirty = true; lock();},
      onPending: value => {pendingObservation = value; if (value) dirty = true; lock();},
      feedback: message => {status.textContent = message;}
    });
    const revision = node("p", `Saved revision ${record.revision}.`), history = node("div");
    const version = field("input", "Historical revision", String(record.revision)); version.type = "number"; version.min = "1"; version.max = String(record.currentRevision);
    for (const input of [name, uri, aliases, geometry, identifiers, knowledge, source, sourceVersion]) input.addEventListener("input", () => {
      if (input === geometry || input === source || input === sourceVersion) selectedBoundary = null;
      if (input === geometry) {manualGeometryEdited = true; sourceReview.checked = false; sourceReviewLabel.hidden = !previousSource;}
      dirty = true; lock(); if (input === knowledge) context.refresh(); status.textContent = "Unsaved Geographic tag changes.";
    });
    const boundary = disclosure("Choose boundary from a Layer", boundaryPicker(),
      disclosure("Advanced: manual GeoJSON and source", geometry, source, sourceVersion, sourceReviewLabel));
    form.append(name, disclosure("Place identity and other names", uri, aliases), boundary,
      advanced, disclosure("Street imagery and provider context", context),
      button("Save Geographic tag", () => run(async () => {
        if (pendingObservation) {throw new SyntaxError("Add or clear the pending provider observation before saving.");}
        if (manualGeometryEdited && previousSource && !sourceReview.checked) throw Object.assign(Error("Boundary source review required"), {code: "boundary_source_review_required"});
        const draft = {...structuredClone(document), title: name.value, canonical_uri: uri.value || null,
          aliases: aliases.value === initialAliases ? document.aliases : aliases.value.split("\n").filter(value => value.trim()),
          geometry: JSON.parse(geometry.value), identifiers: JSON.parse(identifiers.value), knowledge: JSON.parse(knowledge.value)};
        if (selectedBoundary || (manualGeometryEdited && previousSource) || source.value !== (previousSource?.["@id"] ?? "") || sourceVersion.value !== (previousSource?.revision ?? "")) {
          if (!source.value.trim() && sourceVersion.value.trim()) throw new SyntaxError("A boundary revision needs a source URI.");
          if (source.value.trim()) {
            const parsed = new URL(source.value.trim());
            if (!["http:", "https:", "urn:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new SyntaxError("Use a source URI without credentials.");
          }
          draft.knowledge.metadata.curated = draft.knowledge.metadata.curated.filter(claim => claim.method !== BOUNDARY_METHOD);
          let origin = selectedBoundary;
          if (!origin && manualGeometryEdited && previousSource) origin = {"@id": source.value.trim(), revision: sourceVersion.value.trim() || null,
            geometryEdited: true, editMethod: "Manual GeoJSON edit reviewed by curator",
            ...(source.value.trim() === previousSource["@id"] ? {datasetId: previousSource.datasetId ?? null, datasetName: previousSource.datasetName ?? null,
              datasetVersionId: previousSource.datasetVersionId ?? null, datasetVersionNumber: previousSource.datasetVersionNumber ?? null, layerUri: previousSource.layerUri ?? null} : {})};
          if (source.value.trim()) draft.knowledge.metadata.curated.push({subject: "resource", property: origin ? DERIVED_PROPERTY : SOURCE_PROPERTY,
            value: origin ?? {"@id": source.value.trim(), revision: sourceVersion.value.trim() || null}, provenance: "curator_asserted",
            method: BOUNDARY_METHOD, timestamp: new Date().toISOString(), ...(origin ? {evidence: [origin["@id"], ...(origin.layerUri ? [origin.layerUri] : [])]} : {})});
        }
        await adapter.saveLocation(draft, {id: record.id, revision: record.revision});
        await open(record.id);
      }, "Geographic tag saved.")));
    recovery.append(button("Discard draft and reload", () => run(() => open(record.id))), version,
      button("Inspect revision", () => run(async () => {
        const saved = await adapter.getLocation(record.id, Number(version.value));
        if (!disposed) history.replaceChildren(node("h4", `Historical revision ${saved.revision}`), node("pre", JSON.stringify(saved.document, null, 2)));
      }, "Historical revision loaded. Your current draft is unchanged.")));
    const link = node("a", "Link to this Geographic tag"); link.href = root.currentHref();
    const overview = node("section"); overview.className = "location-overview";
    overview.append(node("h3", document.title), revision);
    const identity = document.canonical_uri;
    if (identity) {const label = node("p", identity); label.className = "location-identity"; overview.append(label);}
    else overview.append(node("p", "Place identity not recorded."));
    overview.append(boundaryPreview(document.geometry, document.title));
    if (previousSource?.["@id"]) {
      const summary = node("p"); summary.className = "location-boundary-source";
      const label = typeof previousSource.datasetName === "string" ? previousSource.datasetName
        : typeof previousSource.localFileName === "string" ? previousSource.localFileName : "Boundary source recorded";
      let linked = false;
      if (previousSource.datasetId) try {const layer = node("a", label); layer.href = layerHref(previousSource.datasetId, {adapterKind: adapter.kind}); summary.append(layer); linked = true;} catch { /* Keep incomplete source knowledge readable. */ }
      if (!linked) summary.append(node("span", label));
      if (Number.isSafeInteger(previousSource.datasetVersionNumber)) summary.append(node("span", ` · v${previousSource.datasetVersionNumber}`));
      if (previousSource.geometryEdited) summary.append(node("span", " · edited search area"));
      else if (typeof previousSource.label === "string") summary.append(node("span", ` · ${previousSource.label}`));
      overview.append(summary, disclosure("Exact boundary source", node("pre", JSON.stringify(previousSource, null, 2))));
    }
    const actions = node("div"); actions.className = "location-search-actions";
    searchTagged = button("Search tagged layers", () => search("tags", onSearchTaggedLayers));
    useArea = button("Use saved search area", () => search("area", onUseSavedSearchArea));
    actions.append(searchTagged, useArea, link); overview.append(actions);
    const editing = disclosure("Edit Geographic tag", form);
    if (record.role !== "reader") actions.append(button("Choose boundary", () => {
      editing.open = true; boundary.open = true;
      boundary.querySelector("input")?.focus();
    }));
    editor.replaceChildren(overview);
    if (typeof adapter.getLocationLinks === "function") {
      resourceLinks = LocationResourceLinks({
      adapter, id: record.id, role: record.role, run,
      onDirty: value => {linksDirty = value; lock();}, feedback: message => {status.textContent = message;}
      });
      editor.append(resourceLinks);
    }
    editor.append(editing, disclosure("Revision history and recovery", recovery, history));
    if (typeof adapter.getLocationParent === "function") editor.append(disclosure("Parent relationship", LocationHierarchy({
      adapter, id: record.id, role: record.role, run,
      onDirty: value => {parentDirty = value; lock();},
      feedback: message => {status.textContent = message;}
    })));
    if (record.role === "owner" && typeof adapter.listLocationGrants === "function") editor.append(disclosure("Access to this tag", ResourceSharing({
      label: "Geographic tag", id: record.id, listGrants: (id, page) => adapter.listLocationGrants(id, page),
      grant: (id, userId, body) => adapter.grantLocation(id, userId, body),
      listMembers: page => adapter.listOrganizationMembers(page), getRevision: () => record.accessRevision,
      setRevision: revision => {record.accessRevision = revision;}, isDirty: () => dirty || parentDirty || linksDirty, run,
      feedback: message => {status.textContent = message;}
    })));
    lock();
    if (resourceLinks) await resourceLinks.load();

    function boundaryPicker() {
      const picker = node("div"); picker.className = "location-boundary-picker";
      if (typeof adapter.searchDatasets !== "function" || typeof adapter.getDatasetSpatialPreview !== "function") {
        picker.append(node("p", "Boundary selection requires an accessible Layer with a saved spatial preview.")); return picker;
      }
      const query = field("input", "Find boundary Layers", "countries"); query.maxLength = 200;
      query.placeholder = "Layer name or search terms, e.g. countries";
      const datasets = node("select"); datasets.setAttribute("aria-label", "Boundary Layer");
      const features = node("select"); features.setAttribute("aria-label", "Boundary feature");
      const feedback = node("p"); feedback.setAttribute("role", "status");
      const preview = node("div"); preview.className = "location-boundary-candidate";
      let records = new Map(), available = new Map(), loaded = null;
      const placeholder = (select, label) => {const option = node("option", label); option.value = ""; select.replaceChildren(option);};
      placeholder(datasets, "Choose a Layer"); placeholder(features, "Choose a polygon feature");
      const resetFeatures = () => {loaded = null; available = new Map(); placeholder(features, "Choose a polygon feature"); preview.replaceChildren(); use.disabled = true;};
      const search = button("Search boundary Layers", () => run(async () => {
        if (!query.value.trim()) {feedback.textContent = "Enter a Layer name or search terms, such as countries or boundary."; return;}
        const result = await adapter.searchDatasets({query: query.value.trim(), limit: 50, offset: 0});
        if (disposed) return;
        records = new Map(); placeholder(datasets, "Choose a Layer"); resetFeatures();
        for (const item of result) {
          if (records.has(item.id)) continue;
          records.set(item.id, item);
          const option = node("option", `${item.name}${item.currentVersionId ? "" : " · no saved preview version"}`); option.value = item.id; datasets.append(option);
        }
        loadFeatures.disabled = true;
        feedback.textContent = result.length ? `${records.size} accessible Layers${result.length === 50 ? " · refine the search for more" : ""}. Choose a saved Layer version.` : "No matching accessible boundary Layers. Register or select an existing boundary Layer first.";
      }));
      const loadFeatures = button("Load boundary features", () => run(async () => {
        const dataset = records.get(datasets.value);
        if (!dataset?.projectId || !dataset.currentVersionId) return;
        const result = await adapter.getDatasetSpatialPreview(dataset.projectId, dataset.id, dataset.currentVersionId);
        if (disposed) return;
        if (result.datasetVersionId !== dataset.currentVersionId || result.geojson?.type !== "FeatureCollection"
          || !Array.isArray(result.geojson.features) || result.geojson.features.length > 5000
          || result.numberReturned !== result.geojson.features.length) throw Error("Boundary preview identity changed");
        resetFeatures(); loaded = {dataset, result};
        for (const [index, feature] of result.geojson.features.entries()) {
          if (!["Polygon", "MultiPolygon"].includes(feature.geometry?.type)) continue;
          const properties = feature.properties ?? {};
          const name = [properties.NAME, properties.ADMIN, properties.NAME_EN, properties.name].find(value => typeof value === "string" && value.trim());
          const label = `${name?.slice(0, 200) ?? "Polygon"} · ${feature.id == null ? `feature #${index + 1}` : `id ${String(feature.id).slice(0, 100)} · #${index + 1}`}`;
          available.set(String(index), {feature, index, label});
          const option = node("option", label); option.value = String(index); features.append(option);
        }
        const complete = result.mayBeTruncated === false && result.numberMatched === result.numberReturned;
        feedback.textContent = `${dataset.name} · version ${dataset.currentVersionNumber ?? dataset.currentVersionId} · ${available.size} selectable polygons · ${complete ? "complete preview" : "sample preview; other source features may be absent"}. Select the intended feature; country identity is not inferred.`;
      }));
      const use = button("Use boundary in draft", () => {
        const selected = available.get(features.value);
        if (!loaded || !selected || busy || parentDirty || linksDirty) return;
        try {validateBoundaryGeometry(selected.feature.geometry);} catch (error) {feedback.textContent = error.message; return;}
        const {dataset, result} = loaded;
        const reference = `urn:opengeo:dataset:${dataset.id}:version:${result.datasetVersionId}`;
        selectedBoundary = {"@id": reference, datasetId: dataset.id, datasetVersionId: result.datasetVersionId,
          datasetName: dataset.name, datasetVersionNumber: dataset.currentVersionNumber ?? null,
          revision: result.datasetVersionId, featureId: selected.feature.id ?? null, featureIndex: selected.index,
          layerUri: new URL(layerHref(dataset.id, {adapterKind: adapter.kind}), browser.location.href).href,
          label: selected.label, previewMayBeTruncated: result.mayBeTruncated};
        geometry.value = JSON.stringify(selected.feature.geometry, null, 2);
        manualGeometryEdited = false; sourceReview.checked = false; sourceReviewLabel.hidden = true;
        source.value = reference; sourceVersion.value = result.datasetVersionId;
        dirty = true; lock(); status.textContent = "Boundary selected in draft. Save Geographic tag to retain it.";
      });
      use.disabled = true; loadFeatures.disabled = true;
      datasets.addEventListener("change", () => {
        resetFeatures(); const dataset = records.get(datasets.value);
        loadFeatures.disabled = !dataset?.projectId || !dataset.currentVersionId;
        feedback.textContent = dataset ? `${dataset.name} · ${dataset.currentVersionId ? `saved version ${dataset.currentVersionNumber ?? dataset.currentVersionId}` : "no saved spatial preview version available"}` : "Choose a Layer.";
      });
      features.addEventListener("change", () => {
        const selected = available.get(features.value); preview.replaceChildren(); use.disabled = true;
        if (!selected) return;
        try {validateBoundaryGeometry(selected.feature.geometry); preview.append(boundaryPreview(selected.feature.geometry, selected.label)); use.disabled = false;}
        catch (error) {feedback.textContent = error.message;}
      });
      const fields = node("div"); fields.className = "location-boundary-picker-fields";
      const labeled = (label, control) => {const field = node("label"); field.append(node("span", label), control); return field;};
      fields.append(labeled("Find Layer", query), search, labeled("Layer", datasets), loadFeatures, labeled("Feature", features), use);
      picker.append(fields, feedback, preview);
      return picker;
    }
  }
  function search(mode, callback) {
    if (busy || dirty || parentDirty || linksDirty || !record) return;
    const saved = structuredClone(record);
    if (typeof callback === "function") callback(saved);
    else root.dispatchEvent(new browser.CustomEvent("opengeo-location-search", {bubbles: true, detail: {mode, record: saved}}));
  }
}
function recognizedPlace(value) {try {return Boolean(value && placeIdentity(value));} catch {return false;}}
function savedBounds(geometry) {try {return geometry ? geojsonBounds(geometry) : null;} catch {return null;}}
function validateBoundaryGeometry(geometry) {
  if (!["Polygon", "MultiPolygon"].includes(geometry?.type)) throw Error("Choose a Polygon or MultiPolygon boundary.");
  if (new TextEncoder().encode(JSON.stringify(geometry)).length > 262144) throw Error("Boundary exceeds 262,144 bytes. Choose a simplified boundary Layer.");
  let count = 0;
  function visit(value) {
    if (!Array.isArray(value)) throw Error("Boundary coordinates are invalid.");
    if (typeof value[0] === "number") {
      count++; if (count > 10000 || value.length < 2 || value.length > 3 || value.some(n => !Number.isFinite(n)) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) throw Error("Boundary exceeds coordinate limits or is not longitude/latitude.");
    } else for (const child of value) visit(child);
  }
  visit(geometry.coordinates);
  if (!count || !savedBounds(geometry)) throw Error("Boundary has no usable coordinates.");
}
function boundaryPreview(geometry, title) {
  const bounds = savedBounds(geometry);
  if (!bounds) return node("p", "No boundary selected. Add a saved search area to reuse geographic bounds.");
  const section = node("figure"); section.className = "location-boundary-preview";
  const width = 360, height = 160, pad = 10;
  const [[west, south], [east, north]] = bounds;
  const scale = Math.min((width - 2 * pad) / Math.max(east - west, 1e-6), (height - 2 * pad) / Math.max(north - south, 1e-6));
  const projection = geoIdentity().reflectY(true).scale(scale).translate([width / 2 - (west + east) / 2 * scale, height / 2 + (south + north) / 2 * scale]);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("width", "100%"); svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${title}: saved ${geometry.type} search area`);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", geoPath(projection).pointRadius(3)(geometry) ?? "");
  path.setAttribute("fill", /Polygon|Point/.test(geometry.type) ? "#5390c855" : "none");
  path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5"); path.setAttribute("fill-rule", "evenodd"); svg.append(path);
  section.append(svg, node("figcaption", `Saved ${geometry.type} · ${bounds.flat().map(n => Number(n.toFixed(4))).join(", ")}. Search uses its enclosing rectangle.`));
  return section;
}
function disclosure(label, ...content) {const details = node("details"); details.append(node("summary", label), ...content); return details;}
function node(tag, text = "") {const element = document.createElement(tag); element.textContent = text; return element;}
function field(tag, label, value = "") {const element = node(tag); element.setAttribute("aria-label", label); element.placeholder = label; element.value = value; return element;}
function button(label, action) {const element = node("button", label); element.type = "button"; element.addEventListener("click", action); return element;}
