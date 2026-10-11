import {ckanUrl} from "../lib/ckan.js";

export function CkanCatalog({adapter, projects = [], organization}) {
  if (!["searchCkan", "inspectCkan", "importCkan"].every(name => typeof adapter[name] === "function")) return null;
  const eligible = projects.filter(project => project.status === "active"
    && (organization?.callerRole === "admin" || ["owner", "editor", "reviewer", "viewer"].includes(project.callerRole)));
  if (!eligible.length) return null;
  const root = node("details"); root.className = "catalog-source-registration ckan-catalog";
  root.append(node("summary", "Connect a CKAN catalog"), node("p", "Search a public CKAN catalog, inspect its metadata and register selected records. Data files stay with their provider. Maps and downloads depend on each distribution."));
  const form = node("form"), workspace = node("select"), source = node("input"), query = node("input"), owner = node("input");
  for (const project of eligible) {const option = node("option", project.name); option.value = project.id; workspace.append(option);}
  source.type = "url"; source.required = true; source.maxLength = 2048; source.placeholder = "https://catalog.example.org";
  query.type = "search"; query.maxLength = 400; owner.maxLength = 100;
  const submit = node("button", "Search CKAN"); submit.type = "submit";
  const status = node("p", "Choose an access workspace and enter a catalog address."); status.setAttribute("role", "status");
  const results = node("div"), inspection = node("div"), more = node("button", "Load more CKAN datasets"); more.type = "button"; more.hidden = true;
  form.append(label("Access workspace", workspace), label("CKAN catalog URL", source), label("CKAN search", query), label("CKAN organization name (optional)", owner), submit);
  root.append(form, status, results, more, inspection);
  let generation = 0, disposed = false, current = null, selection = null, writePending = false, writeHref, reader;
  const live = ticket => !disposed && ticket === generation;
  async function context() {
    if (!adapter.tokenProvider && !adapter.organizationProvider) return null;
    if (typeof adapter.tokenProvider !== "function" || typeof adapter.organizationProvider !== "function"
      || typeof adapter.assertCollectionContext !== "function") throw Error("account_context_unavailable");
    const value = {tokenProvider: adapter.tokenProvider, organizationProvider: adapter.organizationProvider,
      baseUrl: adapter.baseUrl, token: await adapter.tokenProvider(), organization: String(await adapter.organizationProvider()).toLowerCase()};
    await adapter.assertCollectionContext(value); return value;
  }
  async function guard(value, ticket) {
    if (value) await adapter.assertCollectionContext(value);
    if (!live(ticket)) throw Error("ckan_selection_changed");
  }
  function invalidate() {
    if (writePending) return;
    reader?.abort(); submit.disabled = more.disabled = false;
    generation++; current = selection = null; results.replaceChildren(); inspection.replaceChildren(); more.hidden = true;
    status.textContent = "Search again to use the current catalog and workspace.";
  }
  for (const input of [workspace, source, query, owner]) input.addEventListener("input", invalidate);
  async function search(append) {
    if (writePending || !form.reportValidity()) return;
    reader?.abort(); reader = new AbortController();
    const ticket = ++generation, signal = reader.signal; selection = null; inspection.replaceChildren(); submit.disabled = more.disabled = true;
    try {
      const scope = await context();
      const snapshot = {projectId: workspace.value, sourceUrl: ckanUrl(source.value), query: query.value.trim(), organization: owner.value.trim() || null};
      const start = append ? current?.nextStart : 0;
      if (start === null || start > 10000) return;
      await guard(scope, ticket); status.textContent = "Searching CKAN…";
      const page = await adapter.searchCkan(snapshot.projectId, {...snapshot, start}, {signal});
      await guard(scope, ticket);
      if (page.sourceUrl !== snapshot.sourceUrl || page.start !== start) throw Error("ckan_search_mismatch");
      if (!append) results.replaceChildren();
      current = {...snapshot, scope, nextStart: page.nextStart};
      for (const dataset of page.datasets) {
        const row = node("article"), inspect = node("button", "Inspect dataset"); inspect.type = "button";
        row.append(node("h4", dataset.title), inspect); results.append(row);
        inspect.addEventListener("click", () => show(dataset, current));
      }
      more.hidden = page.nextStart === null || page.nextStart > 10000;
      status.textContent = `${page.start + page.datasets.length} of ${page.total} matching datasets shown. Results can change upstream between pages.`;
    } catch (error) {if (live(ticket)) status.textContent = `CKAN search failed (${error.code ?? error.message ?? "unavailable"}).`;}
    finally {if (live(ticket)) submit.disabled = more.disabled = false;}
  }
  async function show(dataset, snapshot) {
    if (writePending || !snapshot) return;
    reader?.abort(); reader = new AbortController();
    const ticket = ++generation, signal = reader.signal; submit.disabled = more.disabled = false;
    status.textContent = "Inspecting CKAN dataset…"; inspection.replaceChildren();
    try {
      await guard(snapshot.scope, ticket);
      const value = await adapter.inspectCkan(snapshot.projectId, {sourceUrl: snapshot.sourceUrl, datasetId: dataset.id}, {signal});
      await guard(snapshot.scope, ticket);
      selection = {snapshot, dataset, value, ticket};
      inspection.append(node("h3", value.package.title || value.package.name), node("p", value.package.notes || "No description supplied."),
        node("p", `Dataset licence: ${value.package.license_title || value.package.license_id || "unknown"}. Distribution terms are separate.`));
      const metadata = node("details"); metadata.append(node("summary", "DCAT metadata and conversion report"), node("pre", JSON.stringify({dcat: value.dcat, report: value.report}, null, 2))); inspection.append(metadata);
      for (const resource of value.package.resources ?? []) {
        const row = node("div"); row.append(node("p", `${resource.name || resource.id} · ${resource.format || "format unknown"}`));
        if (resource.datastore_active === true && typeof adapter.previewCkan === "function") {
          const preview = node("button", "Preview table"); preview.type = "button"; row.append(preview);
          preview.addEventListener("click", async () => {
            preview.disabled = true;
            try {
              await guard(snapshot.scope, ticket);
              const table = await adapter.previewCkan(snapshot.projectId, {sourceUrl: snapshot.sourceUrl, datasetId: dataset.id, resourceId: resource.id}, {signal});
              await guard(snapshot.scope, ticket);
              const container = node("div"); container.style.overflowX = "auto";
              const element = node("table"), head = node("tr"); for (const field of table.fields) head.append(node("th", field));
              const thead = node("thead"); thead.append(head); element.append(thead); const tbody = node("tbody");
              for (const record of table.records) {const tr = node("tr"); for (const field of table.fields) {const v = record[field]; tr.append(node("td", v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)));} tbody.append(tr);}
              element.append(tbody); container.append(element); row.append(container, node("p", "Up to 20 rows from the provider. No dataset file was copied."));
            } catch (error) {if (live(ticket)) status.textContent = `Table preview failed (${error.code ?? error.message}).`;}
            finally {if (live(ticket)) preview.disabled = false;}
          });
        }
        inspection.append(row);
      }
      const project = eligible.find(item => item.id === snapshot.projectId);
      if (organization?.callerRole === "admin" || ["owner", "editor"].includes(project?.callerRole)) {
        const register = node("button", "Register private metadata record"); register.type = "button"; inspection.append(register);
        register.addEventListener("click", async () => {
          if (writePending || selection?.ticket !== ticket) return;
          writePending = true; writeHref = root.ownerDocument.defaultView.location.href; register.disabled = true;
          for (const control of form.elements) control.disabled = true;
          try {
            await guard(snapshot.scope, ticket);
            const result = await adapter.importCkan(snapshot.projectId, {sourceUrl: snapshot.sourceUrl, datasetId: dataset.id, packageSha256: value.packageSha256});
            await guard(snapshot.scope, ticket);
            const link = node("a", "View saved metadata record"); link.href = `/workspaces?project=${encodeURIComponent(snapshot.projectId)}&manage=resources#resource-${encodeURIComponent(result.resource.id)}`;
            inspection.append(link); status.textContent = `${result.idempotent ? "Existing record reused" : "Private metadata registered"}. Data access and map rendering require the selected distribution's own connection.`;
          } catch (error) {if (live(ticket)) status.textContent = `Registration failed (${error.code ?? error.message}). Inspect again if the provider metadata changed.`;}
          finally {writePending = false; if (live(ticket)) {register.disabled = false; for (const control of form.elements) control.disabled = false;}}
        });
      }
      status.textContent = "Metadata ready. Registration keeps a source snapshot and does not publish or download data.";
    } catch (error) {if (live(ticket)) status.textContent = `CKAN inspection failed (${error.code ?? error.message}).`;}
  }
  form.addEventListener("submit", event => {event.preventDefault(); void search(false);});
  more.addEventListener("click", () => {void search(true);});
  root.dispose = () => {disposed = true; generation++; reader?.abort(); current = selection = null; results.replaceChildren(); inspection.replaceChildren();};
  root.shouldBlockNavigation = ({restoreUrl = false} = {}) => {
    if (!writePending) return false;
    status.textContent = "Registration is in progress. Wait for its result before leaving or changing accounts.";
    const browser = root.ownerDocument.defaultView;
    if (restoreUrl && writeHref && new URL(writeHref).origin === browser.location.origin) browser.history.pushState(null, "", writeHref);
    return true;
  };
  return root;
}
function node(tag, text) {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element;}
function label(text, control) {const element = node("label"); element.append(node("span", text), control); control.setAttribute("aria-label", text); return element;}
