import {projectHref, publicationHref, directoryHref} from "../lib/applicationRoutes.js";
import {isRetainedTestRecord} from "../lib/retainedTestRecords.js";

export function PublicationWorkspaceDirectory({records = [], editions = [], apiBase = "/api", adapterKind = null, loading = false, loadPage = null, projectContext = null}) {
  const root = document.createElement("section");
  root.className = "publication-workspace-directory";
  root.append(text("p", "Publications accessible in this account. Open a title to edit or preview."));
  if (projectContext) root.append(link("Show all publications", directoryHref({view: "publishing", adapterKind})));
  if (loading) {root.append(text("p", "Loading publications…")); return root;}
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search publications or URLs";
  search.ariaLabel = search.placeholder;
  const testing = document.createElement("input"); testing.type = "checkbox";
  testing.setAttribute("aria-label", "Show testing publications");
  const testingLabel = text("label", "Show testing publications");
  testingLabel.className = "publication-testing-filter"; testingLabel.prepend(testing);
  const searchLabel = text("label", "Search"); searchLabel.className = "publication-search-filter"; searchLabel.append(search);
  const filters = document.createElement("div"); filters.className = "platform-controls publication-directory-controls";
  filters.append(searchLabel, testingLabel);
  const count = text("p", "");
  count.setAttribute("role", "status");
  let loaded = [...records], offset = records.length, hasMore = records.length === 100;
  const more = text("button", "Load more publications");
  more.type = "button"; more.className = "platform-button platform-button-secondary";
  more.hidden = !loadPage || !hasMore;
  const feedback = text("p", ""); feedback.setAttribute("role", "status");
  const table = document.createElement("table");
  table.className = "data-table publication-workspace-table";
  const caption = text("caption", "Accessible publications"); table.append(caption);
  const region = document.createElement("div"); region.className = "publication-workspace-scroll";
  region.tabIndex = 0; region.setAttribute("role", "region"); region.setAttribute("aria-label", "Publications table");
  const empty = text("p", ""); empty.className = "publication-directory-empty"; empty.hidden = true;
  const head = document.createElement("thead"), row = document.createElement("tr");
  for (const label of ["Publication", "Public access / endpoint", "Source"]) {const heading = text("th", label); heading.scope = "col"; row.append(heading);}
  head.append(row);
  const body = document.createElement("tbody");
  const show = () => {
    const term = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const record of [...loaded, ...editions.map(edition => ({
      ...edition, id: edition.editionId, kind: "site", status: "published", canManage: edition.canManage ?? false,
      publicUrl: `${apiBase.replace(/\/$/, "")}${edition.href}`, currentRevision: null
    }))]) {
      const key = record.siteId ? `site:${record.siteId}` : record.sourceProjectId ? `source:${record.sourceProjectId}` : `destination:${record.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const grouped = [...groups.values()].filter(group => !projectContext || group.some(record => record.projectId === projectContext));
    const isTest = group => group.some(record => isRetainedTestRecord(record) || isRetainedAcceptancePublication(record));
    const testCount = grouped.filter(isTest).length;
    const matches = grouped.filter(group => (testing.checked || !isTest(group)) && group.some(r =>
      `${r.title} ${r.projectName ?? ""} ${r.hostname ?? ""}${r.mountPath ?? ""} ${r.publicUrl ?? ""}`.toLowerCase().includes(term)));
    count.textContent = `${matches.length} publication${matches.length === 1 ? "" : "s"}${testCount ? ` · ${testCount} testing publication${testCount === 1 ? "" : "s"} ${testing.checked ? "included" : "hidden"}` : ""}${hasMore ? " · more available" : ""}.`;
    empty.hidden = matches.length > 0;
    empty.textContent = term ? "No publications match this search in the loaded records." : testCount && !testing.checked
      ? "Only retained testing publications are loaded. Show testing publications or load more to continue."
      : projectContext ? "No publications are linked to this project in the loaded records." : "No publications are registered for this account.";
    body.replaceChildren(...matches.map(group => {
      const record = group.find(record => record.sourceProjectId) ?? group[0];
      const row = document.createElement("tr");
      row.dataset.status = record.status;
      const identity = document.createElement("td"), destination = document.createElement("td"), source = document.createElement("td");
      const editorHref = record.projectId ? record.siteId
        ? publicationHref(record.siteId, {adapterKind})
        : projectHref(record.projectId, {
          adapterKind, management: "publishing", fragment: record.kind === "site" ? "project-sites" : "framework-source"
        }) : null;
      const title = text("strong", "");
      title.append(editorHref ? text("a", record.title) : document.createTextNode(record.title));
      if (editorHref) title.firstChild.href = editorHref;
      identity.append(title,
        text("small", record.kind === "framework" ? "Publication files" : record.kind === "site" ? "Maps and pages" : "Existing hosted site"));
      if (isTest(group)) identity.append(text("small", "Testing publication"));
      const urls = new Set();
      for (const endpoint of group) {
        const label = endpoint.hostname ? `${endpoint.hostname}${endpoint.mountPath ?? ""}` : endpoint.publicUrl;
        if (urls.has(label)) continue;
        urls.add(label);
        const item = document.createElement("div"); item.className = "publication-endpoint";
        item.append(endpoint.publicUrl ? link(label, endpoint.publicUrl, true) : text("span", label ?? "No destination assigned"));
        const state = endpoint.publishedRevision ? `Public · Published revision ${endpoint.publishedRevision}`
          : endpoint.status === "draft" ? "Draft · not published"
          : endpoint.status === "adopted" ? "Existing hosted release · source changes not published"
          : endpoint.publicUrl ? "Public" : "Not shared publicly";
        item.append(text("small", `${state}${endpoint.isPrimary ? " · Primary home" : ""}`));
        destination.append(item);
      }
      source.append(record.projectId && record.projectName
        ? link(record.projectName, projectHref(record.projectId, {adapterKind, management: "data"}))
        : text("span", record.projectName ?? "No source linked to this destination"));
      if (record.sourceProjectId) source.append(text("small", `Source revision ${record.currentRevision}`));
      if (!record.projectId) {
        const details = document.createElement("details"); details.className = "publication-source-details";
        details.append(text("summary", "Source details"), text("p", "The editable source may already appear as a separate draft. Register a source only if it is missing; destination linking is a separate step."));
        source.append(details);
        if (record.kind === "hosted_site") source.append(link("Set up source project", directoryHref({adapterKind, create: "publication"})));
      }
      row.append(identity, destination, source);
      return row;
    }));
  };
  search.addEventListener("input", show);
  testing.addEventListener("change", show);
  more.addEventListener("click", async () => {
    if (more.disabled) return;
    more.disabled = true; feedback.textContent = "Loading more publications…";
    try {
      const page = await loadPage({limit: 100, offset});
      const ids = new Set(loaded.map(record => record.id));
      loaded.push(...page.filter(record => !ids.has(record.id)));
      offset += page.length; hasMore = page.length === 100 && offset <= 100_000;
      more.hidden = !hasMore; feedback.textContent = ""; show();
    } catch {feedback.textContent = "More publications could not be loaded. Retry to continue from this page.";}
    finally {more.disabled = false;}
  });
  table.append(head, body);
  region.append(table); root.append(filters, count, region, empty, more, feedback);
  show();
  return root;
}

// The dedicated acceptance namespace and project label identify retained tests;
// a title containing "test" alone never removes a user's publication from view.
function isRetainedAcceptancePublication(record) {
  const knownEndpoint = record.hostname === "pages.studio.opengeo.tools"
    && /^\/[ps]\/publisher-check-(framework|html|jupyter|map|notebook)\/$/.test(record.mountPath ?? "")
    || record.hostname === "opengeo.tools"
    && /^\/publisher-check\/(framework|html|jupyter|map|notebook)\/$/.test(record.mountPath ?? "");
  return knownEndpoint && /^Publisher acceptance · /.test(record.projectName ?? "");
}

function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function link(label, href, external = false) {
  const node = text("a", label); node.href = href;
  node.className = external ? "publication-endpoint-link" : "publication-source-link";
  if (external) {node.target = "_blank"; node.rel = "noopener noreferrer";}
  return node;
}
