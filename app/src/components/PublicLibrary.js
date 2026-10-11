const SECTION_LABELS = Object.freeze({
  home: "Home",
  toolkit: "Toolkit",
  methods: "Methods",
  datasets: "Datasets",
  pipelines: "Pipelines",
  projects: "Projects",
  playbooks: "Playbooks",
  "field-labs": "Field Labs",
  about: "About"
});

const PUBLICATION_ORIGIN = "https://opengeo.tools";

export function PublicLibrary({library}) {
  const root = document.createElement("section");
  root.className = "public-library";
  const items = Array.isArray(library?.items) ? library.items : [];

  const header = document.createElement("header");
  header.className = "public-library-header";
  const copy = document.createElement("div");
  copy.append(
    text("p", "Legacy publication archive", "start-eyebrow"),
    text("h1", library?.title ?? "OpenGeo.tools publication library"),
    text("p", library?.description ?? "Preserved OpenGeo articles, tutorials, maps, and working methods.")
  );
  const app = link(
    "/workspaces?view=publishing",
    "public-library-app-link",
    "Manage governed publications"
  );
  header.append(copy, app);

  const notice = document.createElement("aside");
  notice.className = "public-library-notice";
  notice.append(
    text("strong", `${items.length} preserved legacy editions`),
    text("span", "These immutable URLs are an archive, not editable project workspaces. Use Publishing in Studio for current listed sites and their source projects.")
  );

  const controls = document.createElement("form");
  controls.className = "public-library-controls";
  const query = document.createElement("input");
  query.type = "search";
  query.placeholder = "Search the public library";
  query.ariaLabel = "Search the public library";
  const section = document.createElement("select");
  section.ariaLabel = "Filter publication section";
  section.append(option("", "All sections"));
  for (const key of Object.keys(SECTION_LABELS)) {
    if (items.some((item) => item.section === key)) section.append(option(key, SECTION_LABELS[key]));
  }
  controls.append(query, section);
  controls.addEventListener("submit", (event) => event.preventDefault());

  const results = document.createElement("div");
  results.className = "public-library-results";
  const status = text("p", "", "public-library-status");
  status.setAttribute("role", "status");

  const render = () => {
    const needle = query.value.trim().toLocaleLowerCase();
    const selectedSection = section.value;
    const matches = items.filter((item) => (
      (!selectedSection || item.section === selectedSection)
      && (!needle || `${item.title} ${item.section}`.toLocaleLowerCase().includes(needle))
    ));
    results.replaceChildren(...matches.map(publicationCard));
    status.textContent = `${matches.length} of ${items.length} publications`;
  };
  query.addEventListener("input", render);
  section.addEventListener("change", render);
  render();

  root.append(header, notice, controls, status, results);
  return root;
}

function publicationCard(item) {
  const card = link(new URL(item.legacyPath ?? item.path, PUBLICATION_ORIGIN).href, "public-library-card");
  const identity = document.createElement("span");
  identity.append(
    text("small", SECTION_LABELS[item.section] ?? item.section),
    text("strong", item.title),
    text("span", "Legacy immutable edition · not an editable project")
  );
  card.append(identity, text("span", "Open →", "public-library-open"));
  return card;
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function link(href, className, label = "") {
  const item = document.createElement("a");
  item.href = href;
  item.className = className;
  if (label) item.textContent = label;
  return item;
}

function text(tag, value, className = "") {
  const item = document.createElement(tag);
  item.textContent = value;
  if (className) item.className = className;
  return item;
}
