import {layerHref, compositionHref, publicationHref, collectionHref} from "../lib/applicationRoutes.js";
const hrefs = {layer: layerHref, project: compositionHref, publication: publicationHref, collection: collectionHref};
export function LocationResourceLinks({adapter, id, role, run, onDirty, feedback}) {
  const root = node("section"), body = node("div"), controls = node("fieldset");
  root.className = "location-resource-links"; controls.dataset.links = "true";
  const reload = button("Load resource links", () => run(refresh)); controls.append(reload);
  root.append(node("h4", "Related resources"), controls, body);
  let current;
  let disposed = false;
  root.load = refresh;
  root.dispose = () => {disposed = true;};
  async function refresh() {
    const value = await adapter.getLocationLinks(id);
    if (disposed) return;
    current = value; onDirty(false); render(); reload.textContent = "Discard link draft and reload";
  }
  function listing(entries, mutable = false) {
    const list = node("ol");
    for (const [index, entry] of entries.entries()) {
      const row = node("li");
      if (entry.available) {
        const link = node("a", `${entry.kind}: ${entry.title}`); link.href = hrefs[entry.kind](entry.target_id, {adapterKind: adapter.kind}); row.append(link);
        const details = node("details"); details.append(node("summary", "Relationship"), node("pre", JSON.stringify({relationship: entry.relationship, evidence: entry.evidence, confidence: entry.confidence}, null, 2))); row.append(details);
      } else row.append(node("span", "Resource unavailable. Separate access is required."));
      if (mutable) {
        const up = button("Move link up", () => { [entries[index-1], entries[index]] = [entries[index], entries[index-1]]; changed(); redraw(); }); up.disabled = index === 0;
        const down = button("Move link down", () => { [entries[index+1], entries[index]] = [entries[index], entries[index+1]]; changed(); redraw(); }); down.disabled = index === entries.length-1;
        row.append(up, down, button("Remove resource link", () => {entries.splice(index, 1); changed(); redraw();}));
      }
      list.append(row);
    }
    return list;
    function redraw() {list.replaceWith(listing(entries, mutable));}
  }
  function changed() {onDirty(true); feedback("Unsaved resource link changes.");}
  function render() {
    body.replaceChildren(node("p", current.entries.length ? `Linked resources · revision ${current.revision}` : "No related Layers or resources linked."));
    const entries = structuredClone(current.entries), edit = node("fieldset"); edit.dataset.edit = "true"; edit.dataset.links = "true";
    const rows = node("div"); rows.append(listing(entries, role !== "reader")); edit.append(rows);
    if (role !== "reader") {
      const kind = node("select"); kind.setAttribute("aria-label", "Related resource type");
      for (const value of Object.keys(hrefs)) {const option = node("option", value); option.value = value; kind.append(option);}
      const candidates = node("select"); candidates.setAttribute("aria-label", "Related resource");
      let offset = 0, records = new Map(), pendingAssertion = false;
      function reset() {offset = 0; records = new Map(); candidates.replaceChildren(); more.hidden = false;}
      const more = button("Browse related resources", () => run(async () => {
        const page = kind.value === "layer" ? await adapter.searchDatasets({limit: 50, offset})
          : kind.value === "collection" ? await adapter.listCollections({limit: 50, offset})
          : await adapter.listCollectionCandidates(kind.value, {limit: 50, offset});
        for (const item of page) {
          if (records.has(item.id)) continue;
          records.set(item.id, item); const option = node("option", item.title ?? item.name); option.value = item.id; candidates.append(option);
        }
        offset += page.length; more.hidden = page.length < 50;
      }));
      kind.addEventListener("change", reset);
      const relationship = input("Relationship URI", "http://purl.org/dc/terms/relation"); relationship.maxLength = 2048;
      const evidence = node("textarea"); evidence.setAttribute("aria-label", "Resource link evidence URIs, one per line"); evidence.maxLength = 33000;
      const confidence = input("Resource link confidence", ""); confidence.type = "number"; confidence.min = "0"; confidence.max = "1"; confidence.step = "any";
      for (const control of [relationship, evidence, confidence]) control.addEventListener("input", () => {pendingAssertion = true; changed();});
      const manage = node("details"); manage.append(node("summary", "Add a resource link"));
      manage.append(kind, more, candidates, relationship, evidence, confidence, button("Add resource link", () => {
        const item = records.get(candidates.value);
        if (!item) {feedback("Browse and select a resource first."); return;}
        if (entries.length >= 200) {feedback("A Geographic tag supports up to 200 resource links."); return;}
        if (entries.some(entry => entry.kind === kind.value && entry.target_id === item.id && entry.relationship === relationship.value)) {feedback("That relationship is already listed."); return;}
        entries.push({available: true, kind: kind.value, target_id: item.id, title: item.title ?? item.name, relationship: relationship.value,
          evidence: evidence.value.split("\n").map(value => value.trim()).filter(Boolean), confidence: confidence.value === "" ? null : Number(confidence.value)});
        pendingAssertion = false; changed(); rows.replaceChildren(listing(entries, true));
      }), button("Save resource links", () => {
        if (pendingAssertion) {feedback("Add the pending relationship before saving, or discard and reload."); return;}
        return run(async () => {
        await adapter.saveLocationLinks(id, {revision: current.revision, entries}); await refresh();
      }, "Resource links saved.");}));
      edit.append(manage);
    }
    const history = node("fieldset"), historical = node("div"), version = input("Resource link history revision", String(current.revision)); version.type = "number"; version.min = "0"; version.max = String(current.currentRevision);
    history.append(version, button("Inspect resource link history", () => run(async () => {
      const saved = await adapter.getLocationLinks(id, Number(version.value)); historical.replaceChildren(node("h5", `Resource links at revision ${saved.revision}`), listing(saved.entries));
    })), historical);
    const historyDetails = node("details"); historyDetails.append(node("summary", "Resource link history"), history);
    body.append(edit, historyDetails);
  }
  return root;
}
function node(tag, text = "") {const element = document.createElement(tag); element.textContent = text; return element;}
function input(label, value) {const element = node("input"); element.setAttribute("aria-label", label); element.value = value; return element;}
function button(label, action) {const element = node("button", label); element.type = "button"; element.addEventListener("click", action); return element;}
