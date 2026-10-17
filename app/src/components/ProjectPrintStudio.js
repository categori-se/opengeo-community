import {ProjectPrintEditor} from "./ProjectPrintEditor.js";
import {compositionHref} from "../lib/applicationRoutes.js";

export function ProjectPrintStudio({state, workbench = null, editFrame = null, canSave = false, onSaved = () => {}}) {
  if (state.selectedMap && workbench && editFrame) return ProjectPrintEditor({state, workbench, editFrame, canSave, onSaved});
  const section = document.createElement("section");
  section.className = "project-print-studio";
  section.id = "project-print-studio";
  section.dataset.state = "ready";

  const heading = document.createElement("header");
  heading.className = "project-resources-heading";
  const identity = document.createElement("div");
  identity.append(
    text("p", "Project output", "platform-eyebrow"),
    text("h2", "Print Studio"),
    text(
      "p",
      "Choose a saved map Project to arrange a page, map frames, legend and measured map furniture.",
      "platform-subtitle"
    )
  );
  heading.append(
    identity,
    text("p", "Saved Project layouts · paper and web output", "project-resources-boundary")
  );
  section.append(heading);
  section.append(projectMapChoices(state, section));

  const sites = state.sites ?? [];
  if (!sites.length) {
    section.append(
      projectDirectoryLink(state)
    );
    return section;
  }

  const list = document.createElement("div");
  list.className = "project-print-catalog";
  for (const site of sites) list.append(printSiteCard(state, site));
  const editions = text("details", "");editions.append(text("summary", "Published edition downloads"), list);
  section.append(editions);
  return section;
}

function projectMapChoices(state, section) {
  const root = text("section", ""), list = text("div", ""), status = text("p", "");status.setAttribute("role", "status");
  root.append(text("h3", "Choose a map Project"), status, list);
  const known = new Set();let offset = 0, busy = false, disposed = false;
  const append = maps => {
    for (const map of maps) {
      if (known.has(map.id)) continue;known.add(map.id);
      const row = text("p", ""), link = text("a", map.name || "Saved map Project");
      link.href = compositionHref(map.id, {adapterKind: state.adapter?.kind, management: "print"});row.append(link);list.append(row);
    }
  };
  append(state.maps ?? []);
  const load = text("button", "Load map Projects");load.type = "button";load.className = "print-button secondary";
  load.disabled = typeof state.adapter.listMaps !== "function";
  load.onclick = async () => {
    if (busy || disposed || !section.isConnected) return;
    const current = async () => !disposed && section.isConnected
      && (typeof state.adapter.organizationProvider !== "function" || await state.adapter.organizationProvider() === state.organization.id);
    busy = true;load.disabled = true;status.textContent = "Loading saved map Projects…";
    try {
      if (!await current()) return;
      const maps = await state.adapter.listMaps(state.project.id, {limit: 50, offset});
      if (!await current()) return;
      append(maps);offset += maps.length;load.hidden = maps.length < 50;load.textContent = "Load more map Projects";
      status.textContent = known.size ? "Select the map Project whose layout you want to compose." : "No readable map Projects were found in this access workspace.";
    } catch {if (await current()) status.textContent = "Map Projects could not load. Check access and try again.";}
    finally {busy = false;if (!disposed) load.disabled = false;}
  };
  section.dispose = () => {disposed = true;};root.append(load);return root;
}

function projectDirectoryLink(state) {
  const link = text("a", "Open Projects", "platform-button secondary");
  link.href = state.adapter?.kind === "fixture" ? "/workspaces?adapter=fixture" : "/workspaces";
  return link;
}

function printSiteCard(state, site) {
  const card = document.createElement("article");
  card.className = "project-site-card project-print-card";
  const layout = site.printLayout ?? {};
  const settings = printSettings(site);
  card.append(
    text("p", site.state, `badge ${site.state}`),
    text("h3", site.title),
    text("p", `/${site.slug} · revision ${site.versionNumber}`),
    text(
      "p",
      [
        settings.pageSize ?? layout.pageSize ?? "A4",
        settings.orientation ?? layout.orientation ?? "portrait",
        `${site.pages?.length ?? 0} page${site.pages?.length === 1 ? "" : "s"}`,
        site.activeEdition ? `edition ${site.activeEdition.editionNumber ?? site.activeEdition.id}` : "no active edition"
      ].join(" · "),
      "project-resource-feedback"
    )
  );

  const actions = document.createElement("div");
  actions.className = "project-site-actions";
  if (site.activeEdition && typeof state.adapter.publicSitePrintUrl === "function") {
    actions.append(
      externalLink(
        "Open print PDF",
        state.adapter.publicSitePrintUrl(state.organization.id, state.project.id, site.slug)
      ),
      externalLink(
        "Open published site",
        state.adapter.publicSiteUrl(state.organization.id, state.project.id, site.slug)
      )
    );
    const pages = site.pages ?? [];
    if (pages.length) {
      const downloads = document.createElement("details");
      downloads.className = "project-site-downloads";
      downloads.append(text("summary", "Downloads"));
      const pageLinks = document.createElement("div");
      pageLinks.className = "project-site-actions";
      for (const page of pages) pageLinks.append(externalLink(
        `PNG · ${page.navigationLabel}`,
        state.adapter.publicSitePagePngUrl(
          state.organization.id,
          state.project.id,
          site.slug,
          page.slug
        )
      ));
      downloads.append(pageLinks);
      actions.append(downloads);
    }
  } else {
    actions.append(
      text(
        "p",
        "Submit, review, and publish this site before durable print files are available.",
        "project-resource-feedback"
      )
    );
  }
  card.append(actions);
  return card;
}

function printSettings(site) {
  const options = site.themeOptions ?? {};
  const print = options.print ?? {};
  const legacy = options.printSettings ?? {};
  return {
    pageSize: print.pageSize
      ?? print.printPageSize
      ?? legacy.pageSize
      ?? legacy.printPageSize
      ?? options.printPageSize,
    orientation: print.orientation
      ?? print.printOrientation
      ?? legacy.orientation
      ?? legacy.printOrientation
      ?? options.printOrientation
  };
}

function projectLink(state, label, management) {
  const link = document.createElement("a");
  const query = new URLSearchParams({project: state.project.id, manage: management});
  if (state.adapter?.kind === "fixture") query.set("adapter", "fixture");
  link.className = "platform-button secondary";
  link.href = `/workspaces?${query}#project-${management}`;
  link.textContent = label;
  return link;
}

function externalLink(label, href) {
  const link = document.createElement("a");
  link.className = "platform-button secondary";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function text(tag, value, className = null) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
