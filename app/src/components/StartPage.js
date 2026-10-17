import {WorkbenchView} from "./WorkbenchView.js";
import {StartRecentProjects} from "./StartRecentProjects.js";
import {directoryHref} from "../lib/applicationRoutes.js";
import {createCognitoBrowserAuth} from "../lib/cognitoAuth.js";
import {browserSessionState} from "../lib/auth.js";
import {browserStartupPreference, WELCOME_CHOICES} from "../lib/startupPreference.js";
import {retainStudioAreas} from "../lib/retainedStudioAreas.js";

const FIXTURE_PROJECT_ROUTES = Object.freeze({
  "workspace-nepal-energy": "50000000-0000-4000-8000-000000000001",
  "workspace-midwest-resilience": "50000000-0000-4000-8000-000000000002",
  "workspace-public-demo": "50000000-0000-4000-8000-000000000003"
});

const PUBLICATION_ORIGIN = "https://opengeo.tools";

const ICONS = Object.freeze({
  new: "M12 5v14M5 12h14",
  open: "M3 7.5h6l2 2H21v9.5H3z M3 7.5V5h7l2 2.5",
  project: "M4 5h16v14H4z M8 9h8M8 13h5",
  map: "M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z M9 4v14M15 6v14",
  data: "M5 6c0-2 14-2 14 0s-14 2-14 0zm0 0v12c0 2 14 2 14 0V6M5 12c0 2 14 2 14 0",
  learn: "M4 5h7a3 3 0 013 3v11a3 3 0 00-3-3H4zm16 0h-7a3 3 0 00-3 3v11a3 3 0 013-3h7z",
  settings: "M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zm0-5v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6l-1.5 1.5m-9 9L6 18m12 0l-1.5-1.5m-9-9L6 6",
  chevron: "M9 6l6 6-6 6"
});

export function StartPage({catalog, library = null, adapter = null, mapFontAttachments = null, auth = null, retainNavigation = true, loadRecentProjects = true}) {
  const shell = document.createElement("section");
  shell.className = "opengeo-start";
  shell.dispose = () => shell.querySelector(".start-workbench-frame")?.dispose?.();
  if (!adapter) {
    render((catalog?.workspaces ?? []).map(fixtureProject), "fixture", null);
    return shell;
  }
  // Build the usable shell immediately. Updating history must not reconstruct
  // the workbench and discard a map the user has already started editing.
  render([], adapter.kind, {status: "loading"});
  if (loadRecentProjects) shell.querySelector(".start-project-list")?.replaceWith(StartRecentProjects({
    adapter, render: project => projectRow(project, adapter.kind)
  }));
  else shell.querySelector(".start-project-list")?.replaceChildren(
    link(directoryHref({adapterKind: adapter.kind}), "start-text-link", "Browse saved projects")
  );
  if (adapter.kind === "api" && retainNavigation) shell.dispose = retainStudioAreas({
    root: shell,
    mapSurface: shell.querySelector(".start-workbench-frame"),
    createDirectory: async target => {
      const [{PlatformDirectory}, {loadBrowserAuthConfig}] = await Promise.all([
        import("./PlatformDirectory.js"), import("../lib/authConfig.js")
      ]);
      const config = await loadBrowserAuthConfig().catch(() => null);
      return PlatformDirectory({adapter, auth: auth ?? createCognitoBrowserAuth(), navigationManagedExternally: true,
        deployment: config?.deployment, federation: config?.federation,
        view: target.searchParams.get("view")});
    }
  });
  return shell;

  function render(projects, adapterKind, state) {
    const defaultRoute = projectRoute(projects[0], adapterKind);
    const account = adapterKind === "api" ? {
      session: state?.session,
      signedIn: Boolean(state?.session) || browserSessionState().status === "signed_in",
      auth: auth ?? createCognitoBrowserAuth()
    } : null;
    shell.replaceChildren(startWorkbench(projects, defaultRoute, library, adapterKind, state, mapFontAttachments, account, adapter));
    wireRecentSearch(shell);
  }
}

function startWorkbench(projects, defaultRoute, library, adapterKind, state, mapFontAttachments, account, adapter) {
  const startup = browserStartupPreference();
  const showWelcome = startup.shouldShow() && !new URLSearchParams(globalThis.location?.search ?? "").has("localProject");
  const frame = document.createElement("section");
  frame.className = "start-workbench-frame";
  const workspace = {
    tenantId: "opengeo-local",
    workspaceId: "studio-start-map",
    title: "Untitled local map",
    description: "A local scratch map that can be used before a project is created."
  };
  const project = {
    mapViews: [{id: "start", title: "World", center: [0, 20], zoom: 2, pitch: 0, bearing: 0}],
    basemaps: [{basemapId: "openfreemap-positron", visible: true, opacity: 1}],
    bookmarks: [],
    layers: []
  };
  const workbench = WorkbenchView({
    account,
    projectSwitcher: adapterKind === "api" ? {load: async () => {
      const session = await adapter.getSession({signal: AbortSignal.timeout(20_000)});
      const organizationId = session.selectedOrganizationId
        ?? (session.memberships.length === 1 ? session.memberships[0].organizationId : null);
      if (!organizationId) return [];
      adapter.selectOrganization(organizationId);
      return adapter.listCompositions({limit: 100, signal: AbortSignal.timeout(20_000)});
    }} : null,
    mapFontAttachments,
    workspace,
    role: "local",
    project,
    workspaces: [workspace],
    layers: [],
    datasets: [],
    allDatasets: [],
    objects: [],
    allObjects: [],
    layouts: [],
    jobs: [],
    geojsonByLayerId: new Map(),
    persistenceMode: "local",
    startBlank: true,
    publicDemo: true,
    landingMode: true
  });
  frame.dispose = () => workbench.dispose();
  workbench.inert = true;

  const overlay = document.createElement("div");
  overlay.className = "start-map-overlay";
  const dialog = startMain(projects, defaultRoute, library, adapterKind, state);
  dialog.classList.add("start-map-dialog");
  dialog.role = "dialog";
  dialog.ariaModal = "true";
  dialog.setAttribute("aria-label", "OpenGeo Studio start");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "start-map-close";
  close.setAttribute("aria-label", "Close start panel and use an empty map");
  close.textContent = "×";
  dialog.prepend(close);

  const continueEmpty = document.createElement("button");
  continueEmpty.type = "button";
  continueEmpty.className = "start-empty-map";
  continueEmpty.textContent = "Continue with an empty map";
  dialog.querySelector(".start-action-grid")?.append(continueEmpty);

  const preference = document.createElement("label");
  preference.className = "start-welcome-preference";
  preference.textContent = "Show this welcome screen ";
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Show welcome screen");
  for (const choice of WELCOME_CHOICES) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    selector.append(option);
  }
  selector.value = startup.mode();
  selector.addEventListener("change", () => startup.setMode(selector.value));
  preference.append(selector);
  // Keep the preference beside the entry action, not below all the recent
  // projects and publication links where returning users cannot find it.
  dialog.querySelector(".start-action-grid")?.after(preference);

  const dismiss = () => {
    startup.remember();
    overlay.hidden = true;
    workbench.inert = false;
    workbench.querySelector('[data-primary-command="point"]')?.focus();
    workbench.querySelector(".gis-map")?.dispatchEvent(new Event("workbench:resize"));
  };
  close.addEventListener("click", dismiss);
  continueEmpty.addEventListener("click", dismiss);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
  });
  const openFile = dialog.querySelector(".start-action-card:nth-child(2)");
  openFile?.addEventListener("click", (event) => {
    event.preventDefault();
    dismiss();
    workbench.querySelector('[data-primary-command="open-file"]')?.click();
  });

  overlay.append(dialog);
  frame.append(workbench, overlay);
  workbench.addEventListener("workbench:welcome", () => {
    overlay.hidden = false;
    workbench.inert = true;
    selector.value = startup.mode();
    close.focus();
  });
  // Retain only the last active time, never project content or authentication.
  let lastRemembered = 0;
  const rememberActivity = () => {
    if (!overlay.hidden || Date.now() - lastRemembered < 30_000) return;
    lastRemembered = Date.now();
    startup.remember();
  };
  frame.addEventListener("pointerdown", rememberActivity, {passive: true});
  frame.addEventListener("keydown", rememberActivity);
  frame.addEventListener("wheel", rememberActivity, {passive: true});
  if (showWelcome) requestAnimationFrame(() => close.focus());
  else {
    overlay.hidden = true;
    workbench.inert = false;
    startup.remember();
  }
  return frame;
}

function startHeader(state = null) {
  const header = document.createElement("header");
  header.className = "start-header";
  const brand = link("/", "start-brand");
  brand.append(icon("map"), text("strong", "OpenGeo Studio"));
  const search = document.createElement("label");
  search.className = "start-global-search";
  search.append(icon("project"));
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search recent projects";
  input.ariaLabel = "Search recent projects";
  search.append(input);
  const actions = document.createElement("div");
  actions.className = "start-header-actions";
  actions.append(
    link("https://demo.studio.opengeo.tools/", "start-text-link", "Public demo"),
    link(state?.status === "ready" ? "/workspaces" : "/login", "start-account", state?.status === "ready" ? state.session.displayName : "Sign in")
  );
  header.append(brand, search, actions);
  return header;
}

function startRail(adapterKind = null) {
  const rail = document.createElement("aside");
  rail.className = "start-rail";
  const nav = document.createElement("nav");
  nav.ariaLabel = "OpenGeo Studio navigation";
  nav.append(
    railLink("/", "map", "Start", true),
    railLink(directoryRoute(adapterKind), "project", "Projects"),
    railLink("https://demo.studio.opengeo.tools/", "data", "Public demo"),
    railLink(`${PUBLICATION_ORIGIN}/`, "learn", "Published site")
  );
  const lower = document.createElement("div");
  lower.className = "start-rail-lower";
  lower.append(railLink(adapterKind === "fixture" ? "/admin?adapter=fixture" : "/admin", "settings", "Administration"));
  rail.append(nav, lower);
  return rail;
}

function startMain(workspaces, defaultRoute, library, adapterKind, state) {
  const main = document.createElement("main");
  main.className = "start-main";

  const intro = document.createElement("header");
  intro.className = "start-intro";
  intro.append(
    text("p", "Connect once. Curate once. Reuse continuously.", "start-eyebrow"),
    text("h1", "OpenGeo Studio, the geospatial workspace from OpenGeo.Tools"),
    text("p", "An open workspace for geospatial analysis and publishing."),
    text("p", "Discover reusable data, preserve what you know about it, compose maps, and explain your findings in publications.")
  );

  const actions = document.createElement("div");
  actions.className = "start-action-grid";
  const newRoute = `${directoryRoute(adapterKind)}${directoryRoute(adapterKind).includes("?") ? "&" : "?"}new=1`;
  const openFileRoute = workspaces.length
    ? `${defaultRoute}${defaultRoute.includes("?") ? "&" : "?"}panel=add`
    : `${newRoute}&intent=open-file`;
  actions.append(
    actionCard(newRoute, "new", "New project", "Create a durable project and its first authoritative map.", "Create project"),
    actionCard(openFileRoute, "open", "Open a file", "Inspect local data in the map workbench.", "Choose data"),
    actionCard(directoryRoute(adapterKind), "project", "Open a project", "Continue a saved map and its data and style choices.", "Browse projects")
  );

  const recent = document.createElement("section");
  recent.className = "start-recent";
  const recentHeader = document.createElement("header");
  recentHeader.append(text("h2", "Recent projects"), link(directoryRoute(adapterKind), "start-text-link", "View all"));
  const list = document.createElement("div");
  list.className = "start-project-list";
  for (const workspace of workspaces.slice(0, 5)) list.append(projectRow(workspace, adapterKind));
  if (!workspaces.length) {
    list.append(text(
      "p",
      state?.status === "ready"
        ? "No project activity has been recorded for this account yet."
        : "Sign in to load recent projects from your OpenGeo Studio activity history.",
      "start-search-empty"
    ));
  }
  recent.append(recentHeader, list);

  const publicationStrip = libraryStrip(library, adapterKind);

  const more = document.createElement("details");
  more.className = "start-more";
  const summary = document.createElement("summary");
  summary.append(icon("settings"), text("span", "More OpenGeo Studio tools"), icon("chevron"));
  const moreGrid = document.createElement("div");
  moreGrid.className = "start-more-grid";
  moreGrid.append(
    compactLink("https://demo.studio.opengeo.tools/", "map", "Public map demo", "Anonymous, permissively licensed sample"),
    compactLink(directoryHref({view: "data", adapterKind}), "data", "Data catalog", "Find reusable datasets and services; adding data does not require an upload"),
    compactLink(directoryHref({view: "sources", adapterKind}), "data", "Sources", "Manage connections to supported remote services and storage"),
    compactLink(adapterKind === "fixture" ? "/admin?adapter=fixture" : "/admin", "settings", "Team administration", "Memberships, roles, and invitations"),
    compactLink(`${PUBLICATION_ORIGIN}/methods/index.html`, "learn", "Methods and tutorials", "Published on OpenGeo.Tools")
  );
  more.append(summary, moreGrid);

  const guide = document.createElement("details");
  guide.className = "start-more";
  guide.append(text("summary", "How Studio connects your GIS workflow"),
    text("p", "Use familiar GIS tasks together: discover data, connect sources, compose maps and publish explanations. The products below are references for those tasks; supported formats and services let you continue work across tools."));
  const tasks = document.createElement("div");
  tasks.className = "start-more-grid";
  tasks.append(
    compactLink(directoryHref({view: "data", adapterKind}), "data", "Discover and inspect", "Catalog workflows familiar from GeoLens, GeoNode and ArcGIS. Layers retain their own identity and can be reused in maps."),
    compactLink(directoryHref({view: "sources", adapterKind}), "data", "Connect and reuse", "Work with supported database, storage and service sources, including PostGIS and GeoServer workflows. A connection and a stored copy are different choices."),
    compactLink(directoryRoute(adapterKind), "map", "Compose a map", "Layer and style workflows familiar from QGIS and GeoLibre, with browser mapping built around open formats."),
    compactLink(directoryHref({view: "publishing", adapterKind}), "learn", "Explain and publish", "Narrative and analytical work inspired by Observable and Jupyter. Publications have their own purpose alongside map Projects.")
  );
  guide.append(tasks,
    text("p", "Available tools depend on your account access and the services enabled on this Studio. Support is specific to each format and workflow; Studio does not claim full parity with every application."),
    text("p", "In progress: reusable Project Artifact embeds, Collections for related work, and independent Location records. The connected workflow is being delivered incrementally."));
  main.append(intro, actions, recent, publicationStrip, guide, more);
  return main;
}

function libraryStrip(library, adapterKind) {
  const panel = document.createElement("section");
  panel.className = "start-library-strip";
  const copy = document.createElement("span");
  copy.append(
    text("strong", "Publications"),
    text("small", "Write articles and analytical pages; manage their published editions")
  );
  panel.append(icon("learn"), copy,
    link(directoryHref({view: "publishing", adapterKind}), "start-text-link", "Browse publications"),
    link(`${PUBLICATION_ORIGIN}/`, "start-text-link", "View OpenGeo.Tools"));
  return panel;
}

function wireRecentSearch(shell) {
  const input = shell.querySelector(".start-global-search input");
  const rows = [...shell.querySelectorAll(".start-project-row")];
  const list = shell.querySelector(".start-project-list");
  if (!input || !list) return;

  const empty = text("p", "No recent projects match your search.", "start-search-empty");
  empty.hidden = true;
  empty.setAttribute("role", "status");
  list.append(empty);

  input.addEventListener("input", () => {
    const query = input.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const row of rows) {
      const visible = !query || row.textContent.toLocaleLowerCase().includes(query);
      row.hidden = !visible;
      if (visible) matches += 1;
    }
    empty.hidden = matches !== 0;
  });
}

function actionCard(href, iconName, title, description, action) {
  const card = link(href, "start-action-card");
  card.append(
    icon(iconName),
    text("strong", title),
    text("span", description),
    text("small", action),
    icon("chevron")
  );
  return card;
}

function projectRow(workspace, adapterKind) {
  const row = link(projectRoute(workspace, adapterKind), "start-project-row");
  const access = workspace.callerRole ?? (adapterKind === "fixture" ? "fixture" : "admin");
  const identity = document.createElement("div");
  identity.className = "start-project-identity";
  identity.append(icon("map"), text("strong", workspace.name), text("span", workspace.description ?? "No description"));
  row.append(
    identity,
    text("span", access, `start-classification ${access}`),
    text("time", formatDate(workspace.lastActivityAt ?? workspace.updatedAt)),
    icon("chevron")
  );
  return row;
}

function compactLink(href, iconName, title, description) {
  const item = link(href, "start-compact-link");
  item.append(icon(iconName));
  const copy = document.createElement("span");
  copy.append(text("strong", title), text("small", description));
  item.append(copy, icon("chevron"));
  return item;
}

function railLink(href, iconName, label, active = false) {
  const item = link(href, `start-rail-link${active ? " active" : ""}`);
  item.append(icon(iconName), text("span", label));
  return item;
}

function projectRoute(workspace, adapterKind = null) {
  const id = workspace?.id
    ?? FIXTURE_PROJECT_ROUTES[workspace?.workspaceId]
    ?? "50000000-0000-4000-8000-000000000001";
  const query = new URLSearchParams({project: id});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  return `/workspaces?${query}`;
}

function directoryRoute(adapterKind) {
  return `/workspaces${adapterKind === "fixture" ? "?adapter=fixture" : ""}`;
}

function fixtureProject(workspace) {
  return {
    id: FIXTURE_PROJECT_ROUTES[workspace?.workspaceId],
    workspaceId: workspace?.workspaceId,
    name: workspace?.title,
    description: workspace?.description,
    callerRole: "fixture",
    updatedAt: workspace?.updatedAt,
    lastActivityAt: workspace?.updatedAt,
    lastEventType: "fixture.project.opened"
  };
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", year: "numeric"}).format(new Date(value));
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("opengeo-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function link(href, className, label = "") {
  const element = document.createElement("a");
  element.href = href;
  element.className = className;
  if (label) element.textContent = label;
  return element;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
