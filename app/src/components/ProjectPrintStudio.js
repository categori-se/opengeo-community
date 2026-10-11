export function ProjectPrintStudio({state}) {
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
      "Prepare and retrieve print output from this project's governed site layouts. Print settings remain versioned with the site revision and sealed edition.",
      "platform-subtitle"
    )
  );
  heading.append(
    identity,
    text("p", "Project-scoped · immutable editions · PDF, PNG, and SVG", "project-resources-boundary")
  );
  section.append(heading);

  const sites = state.sites ?? [];
  if (!sites.length) {
    section.append(
      text("h3", "No print layout yet"),
      text(
        "p",
        "Create a governed site in Publishing, select its pages and layout, then return here for project print output.",
        "project-resource-feedback"
      ),
      projectLink(state, "Open Publishing", "publishing")
    );
    return section;
  }

  const list = document.createElement("div");
  list.className = "project-print-catalog";
  for (const site of sites) list.append(printSiteCard(state, site));
  section.append(list);
  return section;
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
