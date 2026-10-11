import {publicDemoNavigation, COMMUNITY_DEMO_PAGE_ID} from "../lib/publicDemoProject.js";
import {StudioNavigation} from "./StudioNavigation.js";

// Anonymous discovery is scoped to this deployment, never the fixture catalog.
export function InstanceCatalog({publicCatalog = null, auth = null} = {}) {
  const root = document.createElement("section");
  root.className = "platform-surface platform-directory instance-catalog";
  const navigation = StudioNavigation({active: "data"});
  root.append(navigation, text("h1", "Catalog"));
  const signIn = document.createElement("button");
  signIn.className = "platform-button";
  signIn.textContent = "Sign in to your catalog";
  const status = text("p", "");
  status.setAttribute("role", "status");
  signIn.addEventListener("click", async () => {
    if (!auth?.beginSignIn) {globalThis.location.href = "/login?returnTo=%2Fworkspaces%3Fview%3Ddata"; return;}
    signIn.disabled = true;
    try {await auth.beginSignIn("/workspaces?view=data");}
    catch {status.textContent = "Sign-in could not open. Please try again."; signIn.disabled = false;}
  });
  if (!publicCatalog) {
    root.append(text("p", "Your browser draft is not part of an account catalog. Sign in to browse projects and files saved to your OpenGeo instance."),
      text("h2", "Projects"), text("p", "No account projects loaded."),
      text("h2", "Data and files"), text("p", "No account data loaded. Opening a local file on the map does not upload it."), signIn, status);
    return root;
  }
  const {catalog, massgis} = publicCatalog;
  const demo = publicDemoNavigation(massgis, COMMUNITY_DEMO_PAGE_ID, null);
  root.append(text("p", "Published projects and data in the OpenGeo public demo. Sign in to see additional projects your account can access."), signIn, status,
    text("h2", "Projects"));
  const projects = document.createElement("div");
  projects.className = "platform-project-directory-results";
  for (const item of demo.workspaceOptions) {
    const row = document.createElement("article");
    row.append(link(item.title, `/?map=${encodeURIComponent(item.pageId)}`));
    projects.append(row);
  }
  root.append(projects, text("h2", "Maps, data and source records"));
  const records = [
    ...demo.mapOptions.map(item => ({title: item.title, kind: "Map", href: `/?map=${encodeURIComponent(item.pageId)}`, summary: "MassGIS · MassEnviroScreen"})),
    ...catalog.entries.map(item => ({title: item.title, kind: "Data", href: item.id === "massgis-massenviroscreen" ? `/?map=${encodeURIComponent(demo.mapOptions[0].pageId)}` : `/?map=${COMMUNITY_DEMO_PAGE_ID}`,
      summary: item.summary, sources: item.sourceFiles}))
  ];
  const query = document.createElement("input");
  query.type = "search";
  query.placeholder = "Search maps and data";
  query.setAttribute("aria-label", "Search demo catalog");
  const results = document.createElement("div");
  results.className = "instance-catalog-results";
  const summary = text("p", "");
  summary.setAttribute("role", "status");
  const previous = document.createElement("button");
  previous.textContent = "Previous page";
  const next = document.createElement("button");
  next.textContent = "Next page";
  const pager = document.createElement("nav");
  pager.className = "platform-controls";
  pager.setAttribute("aria-label", "Catalog pages");
  pager.append(previous, next);
  let page = 0;
  function render() {
    const matches = records.filter(item => `${item.title} ${item.summary} ${item.kind}`.toLowerCase().includes(query.value.trim().toLowerCase()));
    const selected = matches.slice(page * 12, (page + 1) * 12);
    results.replaceChildren(...selected.map(item => {
      const row = document.createElement("article");
      row.append(text("small", item.kind), link(item.title, item.href), text("p", item.summary));
      for (const source of item.sources ?? []) {
        row.append(text("p", `${source.license} · ${source.attribution}`));
        if (typeof source.sourceUrl === "string" && source.sourceUrl.startsWith("https://")) row.append(link("Provider source record", source.sourceUrl));
      }
      return row;
    }));
    summary.textContent = matches.length ? `${page * 12 + 1}–${page * 12 + selected.length} of ${matches.length} records` : "No matching maps or data.";
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 12 >= matches.length;
  }
  query.addEventListener("input", () => {page = 0; render();});
  previous.addEventListener("click", () => {page--; render();});
  next.addEventListener("click", () => {page++; render();});
  root.append(query, summary, results, pager);
  render();
  return root;
}

function text(tag, content) {const node = document.createElement(tag); node.textContent = content; return node;}
function link(label, href) {const node = text("a", label); node.href = href; return node;}
