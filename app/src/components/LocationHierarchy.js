import {locationHref} from "../lib/applicationRoutes.js";

export function LocationHierarchy({adapter, id, role, run, onDirty, feedback}) {
  const root = node("section"), body = node("div"), loadControls = node("fieldset");
  root.className = "location-hierarchy";
  loadControls.dataset.hierarchy = "true";
  const reload = button("Load parent relationship", () => run(refresh));
  loadControls.append(reload); root.append(node("h4", "Optional parent relationship"), loadControls, body);
  let current;
  async function refresh() {
    const value = await adapter.getLocationParent(id);
    current = value; onDirty(false); render(); reload.textContent = "Discard parent draft and reload";
  }
  function summary(value) {
    const result = node("div");
    result.append(node("p", `Parent relationship revision ${value.revision}.`));
    if (!value.parentAvailable) result.append(node("p", "Parent unavailable. Its details require separate access."));
    else if (!value.parent) result.append(node("p", "No parent recorded."));
    else {
      const link = node("a", value.parent.title); link.href = locationHref(value.parent.id, {adapterKind: adapter.kind}); result.append(link);
      result.append(node("pre", JSON.stringify({evidence: value.evidence, confidence: value.confidence}, null, 2)));
    }
    return result;
  }
  function render() {
    body.replaceChildren(summary(current));
    const history = node("fieldset"), historical = node("div"), version = input("Parent relationship revision", String(current.revision));
    version.type = "number"; version.min = "0"; version.max = String(current.currentRevision);
    history.append(version, button("Inspect parent history", () => run(async () => {
      const value = await adapter.getLocationParent(id, Number(version.value));
      historical.replaceChildren(node("h5", "Historical parent relationship"), summary(value));
    })), historical); body.append(history);
    if (role === "reader") return;
    const edit = node("fieldset"); edit.dataset.hierarchy = "true"; edit.dataset.edit = "true";
    const select = node("select"); select.setAttribute("aria-label", "Parent Geographic tag");
    const empty = node("option", "Choose a parent Geographic tag"); empty.value = ""; select.append(empty);
    const known = new Set(); let offset = 0;
    function add(item) {if (item.id === id || known.has(item.id)) return; known.add(item.id); const option = node("option", item.title); option.value = item.id; select.append(option);}
    if (current.parentAvailable && current.parent) {add(current.parent); select.value = current.parent.id;}
    const more = button("Browse parent Geographic tags", () => run(async () => {
      const page = await adapter.listLocations({limit: 50, offset}); page.forEach(add); offset += page.length;
      more.hidden = page.length < 50; more.textContent = "Load more parent Geographic tags";
    }));
    const evidence = node("textarea"); evidence.setAttribute("aria-label", "Parent evidence URIs, one per line"); evidence.maxLength = 33000;
    evidence.value = (current.evidence ?? []).join("\n");
    const confidence = input("Parent relationship confidence", current.confidence == null ? "" : String(current.confidence));
    confidence.type = "number"; confidence.min = "0"; confidence.max = "1"; confidence.step = "any";
    for (const control of [select, evidence, confidence]) control.addEventListener("input", () => {onDirty(true); feedback("Unsaved parent relationship changes.");});
    select.addEventListener("change", () => {onDirty(true); feedback("Unsaved parent relationship changes.");});
    edit.append(node("p", "This records a curated parent relationship, not a geometric containment test. Access to each Geographic tag stays separate."), select, more, evidence, confidence,
      button("Save parent relationship", () => {
        if (!select.value) {feedback("Choose a parent Geographic tag first."); return;}
        void run(async () => {
          await adapter.setLocationParent(id, {revision: current.revision, parentId: select.value,
            evidence: evidence.value.split("\n").map(value => value.trim()).filter(Boolean),
            confidence: confidence.value === "" ? null : Number(confidence.value)});
          await refresh();
        }, "Parent relationship saved.");
      }), button("Remove parent relationship", () => run(async () => {
        await adapter.setLocationParent(id, {revision: current.revision, parentId: null}); await refresh();
      }, "Parent relationship removed. Both Geographic tags are retained.")));
    body.append(edit);
  }
  return root;
}
function node(tag, text = "") {const element = document.createElement(tag); element.textContent = text; return element;}
function input(label, value) {const element = node("input"); element.setAttribute("aria-label", label); element.value = value; return element;}
function button(label, action) {const element = node("button", label); element.type = "button"; element.addEventListener("click", action); return element;}
