// Project presentation only: catalog identity, source metadata and grants stay intact.
export function LayerFolders({tree = [], layers, onApply, onSort = null, readOnly = false}) {
  const root = document.createElement("details"); root.className = "gis-layer-folders";
  const node = (tag, text = "") => {const e = document.createElement(tag); e.textContent = text; return e;};
  root.append(node("summary", "Organize folders"));
  const form = node("form");
  const destination = node("select"); destination.setAttribute("aria-label", "Destination folder");
  const addOption = (value, title) => {const option = node("option", title); option.value = value; destination.append(option);};
  addOption("", "Project root");
  function options(nodes, prefix = "") {
    for (const item of nodes) if (item.kind === "group") {
      addOption(item.id, `${prefix}${item.title}`); options(item.children, `${prefix}${item.title} / `);
    }
  }
  options(tree);
  const name = node("input"); name.placeholder = "New folder name"; name.maxLength = 200;
  name.setAttribute("aria-label", "New folder name");
  const list = node("fieldset"); list.append(node("legend", "Layers to move"));
  const inputs = layers.map(layer => {
    const label = node("label"), checkbox = node("input"); checkbox.type = "checkbox"; checkbox.value = layer.layerId;
    label.append(checkbox, document.createTextNode(layer.title ?? layer.name ?? layer.layerId)); list.append(label); return checkbox;
  });
  const all = node("button", "Select all"); all.type = "button";
  all.addEventListener("click", () => {const checked = !inputs.every(input => input.checked); for (const input of inputs) input.checked = checked; all.textContent = checked ? "Clear selection" : "Select all";});
  const apply = node("button", "Move selected layers"); apply.type = "submit";
  const create = node("button", "Create folder"); create.type = "button";
  const feedback = node("p"); feedback.setAttribute("role", "status");
  function submit(createFolder) {
    if (readOnly) return;
    const ids = inputs.filter(input => input.checked).map(input => input.value);
    if (createFolder && !name.value.trim()) {feedback.textContent = "Enter a folder name."; name.focus(); return;}
    if (!createFolder && !ids.length) {feedback.textContent = "Select layers to move."; return;}
    try {
      const result = editLayerFolders(tree, layers, {ids, destination: destination.value,
        ...(createFolder ? {name: name.value.trim(), id: globalThis.crypto.randomUUID()} : {})});
      onApply(result);
    } catch (error) {feedback.textContent = error.message;}
  }
  create.addEventListener("click", () => submit(true));
  form.addEventListener("submit", event => {event.preventDefault(); submit(false);});
  form.append(node("p", "Choose a destination, then move layers or create a folder there. Save the Project to keep your changes."), destination, name, create, all, list, apply, feedback);
  if (onSort) {
    const direction = node("select"); direction.setAttribute("aria-label", "Folder sort order");
    for (const [value, label] of [["ascending", "Name A to Z"], ["descending", "Name Z to A"]]) {
      const option = node("option", label); option.value = value; direction.append(option);
    }
    const sort = node("button", "Sort folder by name"); sort.type = "button";
    sort.addEventListener("click", () => {
      if (readOnly) return;
      onSort({parentId: destination.value, direction: direction.value});
    });
    form.append(node("p", "Sort only the chosen folder. Unfiled Layers stay first when sorting the Project root."), direction, sort);
  }
  if (readOnly) for (const control of form.querySelectorAll("input, select, button")) control.disabled = true;
  root.append(form); return root;
}

export function editLayerFolders(tree, layers, {ids = [], destination = "", name, id}) {
  const known = new Set(layers.map(layer => layer.layerId));
  const selected = new Set(ids.filter(value => known.has(value)));
  const next = structuredClone(tree);
  let target = destination ? null : next, count = 0;
  function visit(nodes, depth) {
    if (depth > 8) throw Error("This folder would exceed the supported nesting depth.");
    for (const item of nodes) {
      count++;
      if (item.kind === "group") {
        if (item.id === destination) target = item.children;
        visit(item.children, depth + 1);
      }
    }
  }
  visit(next, 0);
  if (!target) throw Error("Choose an existing destination folder.");
  function remove(nodes) {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const item = nodes[index];
      if (item.kind === "layer" && selected.has(item.layerId)) nodes.splice(index, 1);
      else if (item.kind === "group") remove(item.children);
    }
  }
  remove(next);
  if (name) {const folder = {kind: "group", id, title: name, children: []}; target.push(folder); target = folder.children;}
  // Preserve the current drawing order when combining layers from several folders.
  target.push(...layers.filter(layer => selected.has(layer.layerId)).map(layer => ({kind: "layer", layerId: layer.layerId})));
  count = 0; visit(next, 0);
  if (count > 256) throw Error("This Project has reached its folder and layer tree limit.");
  return next;
}
