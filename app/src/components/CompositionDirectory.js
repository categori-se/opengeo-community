import {compositionHref, projectHref, directoryHref} from "../lib/applicationRoutes.js";
import {isRetainedTestRecord} from "../lib/retainedTestRecords.js";

// Lists authored records without fetching definitions, Layers or provider data.
export function CompositionDirectory({adapter, loading = false, includeTesting = false}) {
  const root = node("section"); root.className = "composition-directory";
  root.append(node("h2", "Projects"), node("p", "Saved spatial compositions reuse Layers and Styles."));
  const search = node("input"); search.type = "search"; search.maxLength = 200;
  search.placeholder = "Search Projects"; search.setAttribute("aria-label", "Search authored Projects");
  const status = node("select"); status.setAttribute("aria-label", "Authored Project status");
  for (const [value, label] of [["active", "Active"], ["archived", "Archived"], ["all", "All"]]) {
    const option = node("option", label); option.value = value; status.append(option);
  }
  const controls = node("div"); controls.className = "platform-controls"; controls.append(search, status);
  const testing = node("input"); testing.type = "checkbox"; testing.checked = includeTesting;
  testing.setAttribute("aria-label", "Show testing Projects");
  const testingLabel = node("label", "Show testing Projects"); testingLabel.prepend(testing); controls.append(testingLabel);
  const feedback = node("p", "Loading Projects…"); feedback.setAttribute("role", "status");
  const table = node("table"); table.className = "data-table"; table.style.width = "100%";
  const head = node("thead"), titles = node("tr"), body = node("tbody");
  for (const title of ["Project", "Access settings", "Version", "Status", "Updated"]) titles.append(node("th", title));
  head.append(titles); table.append(head, body);
  const more = node("button", "Load more Projects"); more.type = "button"; more.hidden = true;
  const retry = node("button", "Retry Projects"); retry.type = "button"; retry.hidden = true;
  root.append(controls, feedback, table, more, retry);
  let records = [], offset = 0, generation = 0, pending, timer, disposed = false;
  let selection = {query: "", status: "active"};
  function render() {
    const visible = records.filter(record => testing.checked || !isRetainedTestRecord(record));
    if (root.dataset.state === "ready") feedback.textContent = `${visible.length} Projects shown${records.length > visible.length ? ` · ${records.length - visible.length} testing records hidden` : ""}${more.hidden ? "." : "; more available."}`;
    body.replaceChildren(...visible.map(record => {
      const row = node("tr"); row.dataset.compositionId = record.id;
      const title = node("td"); title.append(link(record.name, compositionHref(record.id, {adapterKind: adapter?.kind})));
      if (record.description) title.append(node("small", record.description));
      title.append(link("Related publications", directoryHref({view: "publishing", adapterKind: adapter?.kind, projectContext: record.accessContainerId})));
      const access = node("td"); access.append(link(record.accessContainerName,
        projectHref(record.accessContainerId, {adapterKind: adapter?.kind, management: "settings"})));
      row.append(title, access, node("td", String(record.version)), node("td", record.status), node("td", new Date(record.updatedAt).toLocaleString()));
      return row;
    }));
  }
  async function load(reset = false) {
    if (disposed) return;
    pending?.abort(); const current = ++generation; pending = new AbortController();
    if (reset) {records = []; offset = 0; selection = {query: search.value.trim(), status: status.value}; render();}
    feedback.textContent = "Loading Projects…"; root.dataset.state = "loading";
    more.disabled = true; retry.hidden = true;
    try {
      if (typeof adapter?.listCompositions !== "function") throw Error("unavailable");
      const page = await adapter.listCompositions({...selection, limit: 50, offset, signal: pending.signal});
      if (disposed || current !== generation) return;
      const known = new Set(records.map(record => record.id));
      for (const record of page) if (!known.has(record.id)) {records.push(record); known.add(record.id);}
      offset += page.length;
      render(); more.hidden = page.length < 50 || offset > 10_000;
      feedback.textContent = records.length ? `${records.length} Projects loaded${more.hidden ? "." : "; more available."}` : "No Projects match this search. Create a Project or check another account.";
      root.dataset.state = "ready"; render();
    } catch {
      if (disposed || current !== generation) return;
      feedback.textContent = "Projects could not load. Your saved work has not changed. Retry to continue.";
      retry.hidden = false; root.dataset.state = "error";
    } finally {if (!disposed && current === generation) more.disabled = false;}
  }
  function reset() {clearTimeout(timer); void load(true);}
  search.addEventListener("input", () => {clearTimeout(timer); pending?.abort(); ++generation; more.disabled = true; retry.hidden = true; timer = setTimeout(reset, 300);});
  status.addEventListener("change", reset);
  testing.addEventListener("change", render);
  more.addEventListener("click", () => void load()); retry.addEventListener("click", () => void load());
  root.dispose = () => {disposed = true; ++generation; pending?.abort(); clearTimeout(timer);};
  if (!loading) void load(true);
  else {search.disabled = true; status.disabled = true;}
  return root;
}
function node(tag, text = "") {const element = document.createElement(tag); element.textContent = text; return element;}
function link(label, href) {const element = node("a", label); element.href = href; return element;}
