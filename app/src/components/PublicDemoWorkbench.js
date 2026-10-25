import {WorkbenchView} from "./WorkbenchView.js";
import {MANAGED_STUDIO_URL} from "./StudioNavigation.js";
import {StaticItemSearch} from "./StaticItemSearch.js";
import {DEMO_PUBLICATIONS, PublicDemoPublication} from "./PublicDemoPublication.js";
import {loadMassgisReferenceGeojson, massgisArchiveUrl as reviewedMassgisArchiveUrl, validateMassgisDemoConfig} from "../lib/massgisDemo.js";
import {
  COMMUNITY_DEMO_PAGE_ID,
  communityDemoPresentation,
  massgisDemoPresentation,
  publicDemoNavigation,
  resolvePublicDemoPageId
} from "../lib/publicDemoProject.js";

const SENSITIVE_QUERY_KEY = /(?:^|[-_])(api[-_]?key|access[-_]?token|token|password|passwd|secret|authorization|cookie|signature|sig|client[-_]?secret)(?:$|[-_])/i;

export function PublicDemoWorkbench({
  catalog,
  geojson,
  massgis: massgisValue,
  massgisArchiveUrl = null,
  mapFontAttachments = null,
  fetchImpl = (...args) => globalThis.fetch(...args)
} = {}) {
  const massgis = validateMassgisDemoConfig(massgisValue);
  const archiveUrl = massgisArchiveUrl ?? reviewedMassgisArchiveUrl(massgis);
  const community = communityDemoPresentation({catalog, geojson});
  const root = document.createElement("section");
  root.className = "public-workbench-demo";

  let captureSession=null,captureDay=null;
  const openCapture=async()=>{
    const {createPublicDemoCaptureSession,openPublicDemoCapture}=await import('./PublicDemoCapture.js');
    const day=new Date().toDateString();
    if(!captureSession||captureDay!==day){captureDay=day;captureSession=createPublicDemoCaptureSession();}
    await openPublicDemoCapture(await captureSession);
  };
  let activePageId = initialPageId(massgis);
  let selectionRevision = 0;
  let massgisGeojson = null;
  let massgisLoadPromise = null;
  let disposed = false;
  const lifetimeController = new AbortController();

  const loadMassgis = () => {
    if (massgisGeojson) return Promise.resolve(massgisGeojson);
    if (!massgisLoadPromise) {
      massgisLoadPromise = loadMassgisReferenceGeojson(massgis, {
        archiveUrl,
        archiveRequired: true,
        fetchImpl,
        signal: lifetimeController.signal
      })
        .then((value) => {
          massgisGeojson = value;
          return value;
        })
        .catch((error) => {
          massgisLoadPromise = null;
          throw error;
        });
    }
    return massgisLoadPromise;
  };

  const massgisSource = catalog.entries.find(entry => entry.id === "massgis-massenviroscreen")?.sourceFiles?.[0];
  const browserCatalog = [{id: COMMUNITY_DEMO_PAGE_ID, title: community.layers[0].title, description: community.noticeSummary, source: community.source, load: async () => ({layer: community.layers[0], geojson: community.geojsonByLayerId.get(community.layers[0].layerId), source: {...community.source, description: community.noticeSummary}})},
    ...massgis.indicatorGroups.flatMap(group => group.maps.map(map => ({id: `massgis-${map.slug}`, title: map.title, description: map.summary, source: massgisSource, load: async () => {
      const data = await loadMassgis();
      const presentation = massgisDemoPresentation({catalog, massgis, geojson: data, pageId: `massgis-${map.slug}`});
      const layer = presentation.layers.find(layer => layer.visible);
      return {layer, geojson: presentation.geojsonByLayerId.get(layer.layerId), source: {...presentation.source, description: map.summary}};
    }})))];

  const showDirectory = () => renderPublishedExamples(root, catalog, massgis, selectPage, browserCatalog, selectLayer);
  const showPersonalProjects = async () => {
    const revision = ++selectionRevision;
    replaceDemoContent(root, directoryActions(), text("p", "Opening Projects on this device…"));
    try {
      const [{LocalProjectLibrary}, {LocalProjectStore}] = await Promise.all([import("./LocalProjectLibrary.js"), import("../lib/localProjectStore.js")]);
      if (disposed || revision !== selectionRevision) return;
      const dialog = LocalProjectLibrary({store: new LocalProjectStore({catalog: browserCatalog}), onClose: () => {writeDemoUrl({view: "examples"});showDirectory();}});
      root.append(dialog);dialog.showModal?.();if (!dialog.open) dialog.open = true;
    } catch (error) {if (!disposed && revision === selectionRevision) root.append(text("p", error.message));}
  };
  const selectLayer = async (entry, {updateUrl = true} = {}) => {
    const revision = ++selectionRevision;
    if (updateUrl) writeDemoUrl({layer: entry.id});
    root.dataset.surface = "catalog-layer-preview";
    replaceDemoContent(root, directoryActions(), text("p", `Loading ${entry.title}…`));
    try {
      const loaded = await entry.load();
      if (disposed || revision !== selectionRevision) return;
      const original = entry.id === COMMUNITY_DEMO_PAGE_ID ? community
        : massgisDemoPresentation({catalog, massgis, geojson: massgisGeojson, pageId: entry.id});
      const layer = {...loaded.layer, visible: true};
      const presentation = {...original, pageId: `catalog-${entry.id}`,
        draftScopeId: `preview-${entry.id}-${crypto.randomUUID()}`, layers: [layer],
        project: {...original.project, layers: [layer], layerTree: [], activeLayerId: layer.layerId},
        geojsonByLayerId: new Map([[layer.layerId, loaded.geojson]]),
        noticeTitle: `${entry.title} · Catalog preview`,
        noticeSummary: "Inspect this Layer in a temporary map. No Project is created or saved."};
      renderPresentation(root, presentation, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture);
      root.dataset.surface = "catalog-layer-preview";
      root.dataset.previewLayerId = layer.layerId;
    } catch {
      if (disposed || revision !== selectionRevision) return;
      replaceDemoContent(root, directoryActions(), text("p", "This Layer could not be loaded. Return to the Catalog or retry its preview."));
    }
  };
  const showPublication = (id) => {
    const project = DEMO_PUBLICATIONS.find(item => item.id === id);
    if (project) {
      selectionRevision += 1;
      root.dataset.surface = "demo-publication-workspace";
      root.dataset.publicationId = project.id;
      replaceDemoContent(root, directoryActions(), PublicDemoPublication({format: project.format}));
      return;
    }
    const publication = demoPublications(massgis).find(item => item.id === id);
    if (!publication) { showDirectory(); return; }
    const revision = ++selectionRevision;
    renderDemoPublication(root, publication, community, massgis, async () => {
      const presentation = publication.id === "community-access" ? community
        : massgisDemoPresentation({catalog, massgis, geojson: await loadMassgis(), pageId: `massgis-${massgis.combinedAnalysis.slug}`});
      if (disposed || revision !== selectionRevision) return null;
      return createDemoWorkbench({...presentation,
        draftScopeId: `publication-${publication.id}-${crypto.randomUUID()}`,
        project: {...presentation.project, basemaps: []}}, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture, root);
    }, selectPage);
  };

  const selectPage = async (requestedPageId, {historyMode = "push", updateUrl = true} = {}) => {
    const pageId = resolvePublicDemoPageId(requestedPageId, massgis);
    const revision = ++selectionRevision;
    activePageId = pageId;
    root.dataset.activePage = pageId;
    if (updateUrl) writePageUrl(pageId, historyMode);

    if (pageId === COMMUNITY_DEMO_PAGE_ID) {
      renderPresentation(root, community, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture);
      return;
    }

    if (!massgisGeojson) renderLoading(root, massgis, pageId, selectPage);
    try {
      const loaded = await loadMassgis();
      if (disposed || revision !== selectionRevision || activePageId !== pageId) return;
      const presentation = massgisDemoPresentation({
        catalog,
        massgis,
        geojson: loaded,
        pageId
      });
      renderPresentation(root, presentation, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture);
    } catch (error) {
      if (disposed || revision !== selectionRevision || activePageId !== pageId) return;
      renderLoadError(root, massgis, pageId, error, selectPage);
    }
  };

  const handleHistory = () => {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    if (params.has("localProject")) {selectionRevision++;renderPresentation(root, community, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture);return;}
    if (params.get("view") === "local-projects") {void showPersonalProjects();return;}
    if (params.has("publication")) { showPublication(params.get("publication")); return; }
    if (params.has("layer")) {
      const entry = browserCatalog.find(item => item.id === params.get("layer"));
      if (entry) { void selectLayer(entry, {updateUrl: false}); return; }
    }
    if (examplesDirectoryRequested()) {
      selectionRevision += 1;
      showDirectory();
      return;
    }
    void selectPage(initialPageId(massgis), {updateUrl: false});
  };
  globalThis.addEventListener?.("popstate", handleHistory);
  observeDemoDisconnection(root, () => {
    disposed = true;
    selectionRevision += 1;
    lifetimeController.abort();
    disposeSatelliteSearch(root);
    globalThis.removeEventListener?.("popstate", handleHistory);
  });

  handleHistory();
  return root;
}

function renderPublishedExamples(root, catalog, massgis, selectPage, browserCatalog, selectLayer) {
  const navigation = publicDemoNavigation(massgis, COMMUNITY_DEMO_PAGE_ID, null);
  const starter = catalog?.entries?.find(({id}) => id === "public-community-facilities");
  const massgisEntry = catalog?.entries?.find(({id}) => id === "massgis-massenviroscreen");
  const main = document.createElement("main");
  main.className = "public-demo-directory";
  main.setAttribute("aria-labelledby", "public-demo-directory-title");

  const header = document.createElement("header");
  header.className = "public-demo-directory-header";
  const heading = text("h1", "Explore OpenGeo Studio");
  heading.id = "public-demo-directory-title";
  header.append(
    text("p", "OpenGeo Studio · browser demo", "public-demo-directory-eyebrow"),
    heading,
    text("p", "General GIS tools optimized for environmental and social baselines, risk analysis, impact assessment and monitoring."),
    text("p", "No account needed: inspect and style data, save and reopen a Project on this device, and export supported outputs. Your changes stay in this browser; download a backup to keep them."),
    directoryActions()
  );

  const projects = document.createElement("div");
  projects.className = "public-demo-project-grid";
  projects.append(
    publishedProjectCard({
      title: "OpenGeo Studio starter project",
      summary: starter?.summary ?? "A small public dataset for learning the Studio workbench.",
      facts: ["1 map", "1 layer", starter?.sourceFiles?.[0]?.license ?? "CC0-1.0"],
      action: exampleLink("Open starter map", COMMUNITY_DEMO_PAGE_ID, selectPage)
    }),
    massgisProjectCard({massgis, publication: massgisEntry, navigation, selectPage}),
    satelliteSearchCard(),
    studioWorkflowsCard()
  );

  const catalogSection = document.createElement("section");
  catalogSection.id = "example-catalog";
  catalogSection.className = "public-demo-example-section";
  catalogSection.append(text("h2", "Example Catalog"), text("p", "Reusable Layers with source and license information. View a Layer on its own before composing a Project."));
  const query = document.createElement("input");
  query.type = "search"; query.placeholder = "Search example Layers"; query.setAttribute("aria-label", "Search example Layers");
  const results = document.createElement("div"); results.className = "public-demo-catalog-results";
  const status = text("p", ""); status.setAttribute("role", "status");
  const renderLayers = () => {
    const matches = browserCatalog.filter(entry => entry.title.toLowerCase().includes(query.value.trim().toLowerCase()));
    status.textContent = `${matches.length} of ${browserCatalog.length} Layers`;
    results.replaceChildren(...matches.map(entry => {
      const source = entry.id === COMMUNITY_DEMO_PAGE_ID ? starter?.sourceFiles?.[0] : massgisEntry?.sourceFiles?.[0];
      const action = directoryLink("View layer", `/?layer=${encodeURIComponent(entry.id)}`);
      action.addEventListener("click", event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void selectLayer(entry);
      });
      const card = publishedProjectCard({title: entry.title, summary: source?.attribution,
        facts: [source?.license, entry.id === COMMUNITY_DEMO_PAGE_ID ? "Synthetic GeoJSON" : "MassGIS archived polygons"], action});
      card.dataset.catalogLayer = entry.id;
      if (source?.sourceUrl) card.append(externalLink("Original source ↗", source.sourceUrl));
      return card;
    }));
  };
  query.addEventListener("input", renderLayers); renderLayers();
  catalogSection.append(query, status, results);
  const publications = document.createElement("section"); publications.id = "example-publications";
  publications.className = "public-demo-example-section";
  publications.append(text("h2", "Example Publications"), text("p", "Try the complete authoring flow: create, edit, preview, choose an address and review a simulated release. Browser drafts reset after five minutes without activity, on leaving, or on reload."));
  const publicationCards = document.createElement("div"); publicationCards.className = "public-demo-catalog-results";
  for (const item of DEMO_PUBLICATIONS) publicationCards.append(publishedProjectCard({
    title: item.title, summary: item.summary, facts: ["Browser authoring", "Simulated release"],
    action: directoryLink("Try publication", `/?publication=${item.id}`)
  }));
  publications.append(publicationCards);
  const view = new URLSearchParams(globalThis.location?.search ?? "").get("view");
  main.append(header);
  if (view !== "publications") main.append(catalogSection);
  if (view !== "catalog") main.append(publications);
  const projectSection = document.createElement("section"); projectSection.className = "public-demo-example-section";
  projectSection.append(text("h2", "Example Projects and data connections"), projects);
  const briefings = document.createElement('nav'); briefings.className = 'public-demo-directory-actions'; briefings.ariaLabel = 'Map briefings';
  for (const item of demoPublications(massgis)) briefings.append(directoryLink(item.title, `/?publication=${item.id}`));
  projectSection.append(text('h3', 'Map briefings'), briefings);
  if (view !== "catalog" && view !== "publications") main.append(projectSection);
  root.dataset.surface = "published-examples";
  root.dataset.activePage = "";
  replaceDemoContent(root, main);
}

function demoPublications(massgis) {
  return [
    {id: "community-access", title: "Community facilities: a spatial briefing",
      summary: "An example report brings five illustrative facilities together with an interactive map, a category summary and its source.", license: "CC0-1.0"},
    {id: "massgis-screening", title: "Reading the MassEnviroScreen screening map",
      summary: "Explore the relationship between environmental burden, population vulnerability and a combined screening index, with the original source and interpretation limits.", license: massgis.collection.license.name}
  ];
}

function renderDemoPublication(root, publication, community, massgis, loadMap, selectPage) {
  const main = document.createElement("main"); main.className = "public-demo-directory";
  const article = document.createElement("article"); article.className = "public-demo-publication";
  article.append(directoryActions(), text("p", "OpenGeo.Tools · example Publication", "public-demo-directory-eyebrow"),
    text("h1", publication.title), text("p", publication.summary), text("h2", "Purpose and findings"));
  if (publication.id === "community-access") {
    article.append(text("p", "This synthetic briefing demonstrates how a Publication can reuse a Catalog Layer: an interactive map, a simple summary and an explanation of the evidence belong together. These invented facilities illustrate the workflow; they do not describe real service availability."));
    const table = document.createElement("table");
    const caption = text("caption", "Facilities by category · synthetic example data");
    const head = document.createElement("thead"); const row = document.createElement("tr");
    row.append(text("th", "Category"), text("th", "Facilities")); head.append(row);
    const body = document.createElement("tbody"); const counts = new Map();
    for (const feature of community.geojsonByLayerId.get(community.layers[0].layerId).features) {
      const category = feature.properties.category ?? "Unspecified";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    for (const [category, count] of counts) { const row = document.createElement("tr"); row.append(text("td", category), text("td", String(count))); body.append(row); }
    table.append(caption, head, body); article.append(table);
  } else {
    article.append(text("p", massgis.collection.summary),
      text("p", "The combined Project displays environmental burden, population vulnerability and the combined screening measure. Its indicator views reuse the same archived census-block-group source. Use the Catalog to inspect an individual indicator and the workbench to compare or restyle the composition."));
  }
  article.append(text("h2", "Interactive map"));
  const map = document.createElement("section"); map.className = "public-demo-publication-map";
  map.setAttribute("aria-label", "Publication map");
  const status = text("p", ""); status.setAttribute("role", "status");
  const button = document.createElement("button"); button.type = "button";
  button.className = "platform-button"; button.textContent = "Load publication map";
  button.addEventListener("click", async () => {
    button.disabled = true; status.textContent = "Loading the referenced map…";
    try {
      const workbench = await loadMap();
      if (!workbench) return;
      map.replaceChildren(workbench); status.textContent = "";
    } catch { button.disabled = false; status.textContent = "The map could not be loaded. Retry or read the original source below."; }
  });
  map.append(button, status); article.append(map,
    exampleLink("Open this Project in the workbench", publication.id === "community-access" ? COMMUNITY_DEMO_PAGE_ID : `massgis-${massgis.combinedAnalysis.slug}`, selectPage),
    text("h2", "Method, sources and limits"));
  if (publication.id === "community-access") {
    article.append(text("p", "Method: count the embedded GeoJSON features by category and plot their supplied coordinates. No external geocoding or processing is used. The same Layer drives the map and table."),
      text("p", `${community.source.attribution} · ${community.source.license}. Fictional locations and verification dates are demonstration data. Map edits remain temporary and do not change this source.`));
  } else {
    article.append(text("p", `${massgis.collection.attribution} · ${massgis.collection.license.name}. Maps use the preserved MassGIS release; source dates and interpretation belong to that release. Screening scores identify areas for further investigation, not a site-specific finding or causal conclusion.`),
      externalLink("MassGIS source and documentation ↗", massgis.collection.officialUrls.program));
  }
  article.append(text("p", "This is an authored public demonstration page. It does not create a private Studio Project or publish changes made in the browser."));
  main.append(article); root.dataset.surface = "example-publication"; root.dataset.publicationId = publication.id;
  replaceDemoContent(root, main);
}

function satelliteSearchCard() {
  const card = document.createElement("article");
  card.className = "public-demo-project-card";
  card.id = "satellite-scenes";
  const search = StaticItemSearch();
  search.open = globalThis.location?.hash === "#satellite-scenes";
  card.append(
    text("h2", "Find Sentinel-2 scenes"),
    text("p", "Search the public scene index by date, area and cloud cover. Inspect assets and download their original references. No account is needed; imagery stays with its provider."),
    search
  );
  return card;
}

function studioWorkflowsCard() {
  const actions = document.createElement("nav");
  actions.className = "public-demo-directory-actions";
  actions.setAttribute("aria-label", "Saved Studio workflows");
  actions.append(
    directoryLink("Catalog and satellite Layers ↗", `${MANAGED_STUDIO_URL}workspaces?view=data`),
    directoryLink("Projects and sharing ↗", `${MANAGED_STUDIO_URL}workspaces`),
    directoryLink("Publishing workbench ↗", `${MANAGED_STUDIO_URL}workspaces?view=publishing`),
    directoryLink("Request free cloud beta access", "mailto:akdennis@gmail.com")
  );
  const card = document.createElement("article");
  card.className = "public-demo-project-card";
  card.append(
    text("h2", "Save, share and publish in Studio"),
    text("p", "Existing members can sign in to keep Catalog Layers and Projects, work with invited colleagues and author Publications. Selected individuals and small teams can request a limited free cloud beta; approval, duration, usage limits and team permissions are agreed before access."),
    actions
  );
  return card;
}

function disposeSatelliteSearch(root) {
  for (const search of root.querySelectorAll(".platform-static-item-search")) search.dispose?.();
}

function replaceDemoContent(root, ...content) {
  disposeSatelliteSearch(root);
  for (const publication of root.querySelectorAll('.public-demo-publication-workspace')) publication.dispose?.();
  root.replaceChildren(...content);
}

function directoryActions() {
  const actions = document.createElement("nav");
  actions.className = "public-demo-directory-actions";
  actions.setAttribute("aria-label", "Demo destinations");
  actions.append(
    directoryLink("Overview", "/"),
    directoryLink("Catalog", "/?view=catalog"),
    directoryLink("Publications", "/?view=publications"),
    directoryLink("On this device", "/?view=local-projects"),
    directoryLink("Open starter workbench", "/?map=community-facilities"),
    directoryLink("Open source & credits", "/credits"),
    directoryLink("Open Studio ↗", MANAGED_STUDIO_URL)
  );
  return actions;
}

function publishedProjectCard({title, summary, facts, action}) {
  const card = document.createElement("article");
  card.className = "public-demo-project-card";
  const factList = document.createElement("p");
  factList.className = "public-demo-project-facts";
  factList.textContent = facts.filter(Boolean).join(" · ");
  card.append(text("h2", title), text("p", summary), factList, action);
  return card;
}

function massgisProjectCard({massgis, publication, navigation, selectPage}) {
  const card = publishedProjectCard({
    title: massgis.project.title,
    summary: publication?.summary ?? massgis.collection.summary,
    facts: [
      `${navigation.mapOptions.length} maps`,
      "33 layers per map",
      "5,109 archived features",
      massgis.collection.license.name
    ],
    action: exampleLink(
      "Open combined analysis",
      navigation.mapOptions[0].pageId,
      selectPage
    )
  });
  card.classList.add("public-demo-project-card-wide");

  const mapDirectory = document.createElement("section");
  mapDirectory.className = "public-demo-map-directory";
  mapDirectory.setAttribute("aria-label", "MassEnviroScreen published maps");
  mapDirectory.append(text("h3", "Choose a MassEnviroScreen map"));
  const grouped = new Map();
  for (const option of navigation.mapOptions.slice(1)) {
    const options = grouped.get(option.group) ?? [];
    options.push(option);
    grouped.set(option.group, options);
  }
  for (const [group, options] of grouped) {
    const disclosure = document.createElement("details");
    disclosure.className = "public-demo-map-group";
    const summary = document.createElement("summary");
    summary.append(text("strong", group), text("small", `${options.length} maps`));
    const links = document.createElement("div");
    links.className = "public-demo-map-links";
    for (const option of options) links.append(exampleLink(option.title, option.pageId, selectPage));
    disclosure.append(summary, links);
    mapDirectory.append(disclosure);
  }
  card.append(mapDirectory);
  return card;
}

function exampleLink(label, pageId, selectPage) {
  const link = directoryLink(label, `/?map=${encodeURIComponent(pageId)}`);
  link.dataset.pageId = pageId;
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void selectPage(pageId);
  });
  return link;
}

function directoryLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  return link;
}

function renderPresentation(root, presentation, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture) {
  const workbench = createDemoWorkbench(presentation, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture, root);
  const notice=demoNotice(presentation);
  const capture=document.createElement('button');capture.type='button';capture.className='platform-button secondary';capture.textContent='Try field capture';
  capture.addEventListener('click',async()=>{
    capture.disabled=true;
    try {await openCapture();}catch {capture.textContent='Retry field capture';}
    finally {capture.disabled=false;}
  });
  const actions=notice.querySelector(".public-demo-actions");
  const secondary=notice.querySelector(".public-demo-secondary-actions");
  secondary.prepend(capture, directoryLink("Publications", "/?view=publications"));
  actions.prepend(directoryLink("Catalog", "/?view=catalog"));
  if (presentation.pageId === COMMUNITY_DEMO_PAGE_ID) {
    actions.prepend(exampleLink("Explore MassGIS", `massgis-${massgis.combinedAnalysis.slug}`, selectPage));
  }
  secondary.append(directoryLink("Satellite scenes", "/?view=examples#satellite-scenes"));
  replaceDemoContent(root, notice, workbench);
}

function createDemoWorkbench(presentation, massgis, selectPage, mapFontAttachments, browserCatalog, openCapture, root) {
  const navigation = publicDemoNavigation(
    massgis,
    presentation.pageId,
    (pageId) => void selectPage(pageId)
  );
  return WorkbenchView({
    mapFontAttachments,
    workspace: presentation.workspace,
    role: "viewer",
    project: presentation.project,
    workspaces: [presentation.workspace],
    layers: presentation.layers,
    datasets: presentation.datasets,
    allDatasets: presentation.datasets,
    browserCatalog,
    onDemoCapture: openCapture,
    onBrowserProjectCreated: () => {
      const notice = root.querySelector(".public-demo-notice");
      if (notice) {
        notice.querySelector("strong").textContent = "New Project";
        notice.querySelector("small").textContent = "Choose Layers from the catalog or register a source. Changes stay in this browser.";
        notice.querySelector(".public-demo-facts")?.replaceChildren(text("small", "Browser draft · daily reset"));
      }
    },
    onLocalProjectLoaded: record => {
      const notice = root.querySelector(".public-demo-notice");
      if (notice) {
        notice.querySelector("strong").textContent = record.title;
        notice.querySelector("small").textContent = "Personal Project saved on this device. Download a backup for another device or browser.";
        notice.querySelector(".public-demo-facts")?.replaceChildren(text("small", `Local revision ${record.revision} · no account upload`));
      }
    },
    objects: [],
    allObjects: [],
    layouts: [],
    jobs: [],
    storage: {
      provider: "browser-only-demo",
      bucket: "",
      prefix: "",
      projectPrefix: "",
      uploadPrefix: ""
    },
    geojsonByLayerId: presentation.geojsonByLayerId,
    registerSource: createPublicDemoSource,
    sources: [],
    persistenceMode: "demo",
    publicDemo: true,
    demoSurface: true,
    projectNavigation: navigation,
    draftScopeId: presentation.draftScopeId
  });
}

function renderLoading(root, massgis, pageId, selectPage) {
  const page = navigationPage(massgis, pageId);
  const state = document.createElement("main");
  state.className = "public-demo-load-state";
  state.setAttribute("role", "status");
  state.append(
    text("strong", "Loading the preserved MassGIS release…"),
    text("p", "OpenGeo Studio is verifying the immutable AWS archive while retaining the authoritative MassGIS source and version record."),
    stateAction("Open the starter map", () => void selectPage(COMMUNITY_DEMO_PAGE_ID))
  );
  replaceDemoContent(root, demoStateNotice(page, massgis), state);
}

function renderLoadError(root, massgis, pageId, error, selectPage) {
  const page = navigationPage(massgis, pageId);
  const state = document.createElement("main");
  state.className = "public-demo-load-state public-demo-load-error";
  state.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "public-demo-state-actions";
  actions.append(
    stateAction("Try MassGIS again", () => void selectPage(pageId, {updateUrl: false})),
    stateAction("Open the starter map", () => void selectPage(COMMUNITY_DEMO_PAGE_ID))
  );
  state.append(
    text("strong", "The current MassGIS release could not be loaded"),
    text("p", boundedErrorMessage(error)),
    text("small", "The starter map and local OpenGeo Studio tools remain available while the external service is unavailable."),
    actions
  );
  replaceDemoContent(root, demoStateNotice(page, massgis), state);
}

function stateAction(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function navigationPage(massgis, pageId) {
  const navigation = publicDemoNavigation(massgis, pageId, null);
  const stack = [...navigation.nodes];
  while (stack.length) {
    const node = stack.shift();
    if (node.kind === "page" && node.id === pageId) return node;
    if (Array.isArray(node.children)) stack.unshift(...node.children);
  }
  return {title: massgis.collection.title, summary: massgis.collection.summary};
}

function initialPageId(massgis) {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get("map");
  return resolvePublicDemoPageId(value, massgis);
}

function examplesDirectoryRequested() {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  return ["examples", "catalog", "publications"].includes(params.get("view"));
}

function writeDemoUrl(values) {
  const url = new URL(globalThis.location.href);
  for (const key of ["view", "map", "layer", "publication", "localProject"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  globalThis.history?.pushState(null, "", `${url.pathname}${url.search}`);
}

function writePageUrl(pageId, historyMode) {
  if (!globalThis.location?.href || !globalThis.history) return;
  let url;
  try {
    url = new URL(globalThis.location.href);
  } catch {
    return;
  }
  url.searchParams.delete("view");
  url.searchParams.delete("layer");
  url.searchParams.delete("publication");
  url.searchParams.delete("localProject");
  url.searchParams.set("map", pageId);
  const method = historyMode === "replace" ? "replaceState" : "pushState";
  try {
    globalThis.history[method]?.(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Sandboxed previews may not allow same-document History API updates.
  }
}

function observeDemoDisconnection(root, dispose) {
  queueMicrotask(() => {
    if (!root.isConnected || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      observer.disconnect();
      dispose();
    });
    observer.observe(root.ownerDocument.documentElement, {childList: true, subtree: true});
  });
}

export async function createPublicDemoSource(metadata) {
  const name = boundedText(metadata?.name, "source name", 160);
  const source = metadata?.source;
  if (!source || !["xyz", "wms", "pmtiles"].includes(source.type)) {
    throw new TypeError("the public demo supports XYZ, WMS, and PMTiles HTTPS sources");
  }
  validatePublicHttpsUrl(source.url);
  const {type, url, ...configuration} = structuredClone(source);
  return {
    datasetId: globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000001",
    name,
    description: null,
    sourceType: type,
    sourceUrl: url,
    versionNumber: 1,
    configuration,
    classification: "browser-only-demo",
    fixtureSource: true
  };
}

function demoNotice(presentation) {
  const {publication, source} = presentation;
  const restored = presentation.project?.browserDraftRestored;
  const notice = document.createElement("aside");
  notice.className = "public-demo-notice";
  notice.setAttribute("aria-label", "Current public demo map");
  const title = text("strong", restored ? presentation.project.title : presentation.noticeTitle);
  const information = document.createElement("details");
  information.className = "public-demo-information";
  information.append(text("summary", "About this map"));
  const panel = document.createElement("div");
  panel.className = "public-demo-information-panel";
  panel.append(text("small", restored ? "Restored browser Project. Changes stay in this browser and reset daily." : presentation.noticeSummary));
  const facts = document.createElement("span");
  facts.className = "public-demo-facts";
  facts.append(...(restored ? [text("small", "Sources and terms belong to each Layer. Inspect a Layer to review its metadata.")] : [
    text("small", `${publication.title} · ${source.license}`),
    text("small", source.attribution)
  ]));
  if (presentation.sourceReceipt?.featureCount) {
    const sourceLabel = presentation.sourceReceipt.sourceMode === "aws-archive"
      ? "AWS archive · MassGIS source linked"
      : "current MassGIS service";
    facts.append(text(
      "small",
      `${presentation.sourceReceipt.featureCount.toLocaleString("en-US")} features · ${sourceLabel}`
    ));
  } else if (presentation.limitations?.length) {
    facts.append(text("small", "Screening map · use as a starting point for project-specific analysis"));
  }
  const actions = document.createElement("span");
  actions.className = "public-demo-actions";
  const secondary = document.createElement("span");
  secondary.className = "public-demo-secondary-actions";
  if (presentation.officialUrls?.program) {
    secondary.append(externalLink("Source and limits", presentation.officialUrls.program));
  }
  const studio = document.createElement("a");
  studio.href = MANAGED_STUDIO_URL;
  studio.textContent = "Open Studio ↗";
  secondary.append(directoryLink("Open source & credits", "/credits"), studio);
  const limits = document.createElement("details");
  limits.className = "public-demo-service-boundaries";
  limits.append(
    text("summary", "Browser demo · service limits"),
    text("p", "Edit, style, import and export locally. Drafts are disposable; export anything you want to keep. This demo does not access your Studio account or upload your files."),
    text("p", "Cloud storage, shared projects, server processing and web publishing are unavailable here. Hosted services require a separate Studio account and acceptance of the applicable agreement and pricing. External data providers may require their own accounts. No paid service starts from this demo.")
  );
  panel.append(facts, secondary, limits);
  information.append(panel);
  notice.append(title, actions, information);
  return notice;
}

function demoStateNotice(page, massgis) {
  return demoNotice({
    noticeTitle: page.title,
    noticeSummary: page.summary ?? massgis.collection.summary,
    publication: {title: massgis.collection.title},
    source: {
      license: massgis.collection.license.name,
      attribution: massgis.collection.attribution
    },
    officialUrls: massgis.collection.officialUrls,
    limitations: massgis.collection.limitations
  });
}

function externalLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = label;
  return link;
}

function boundedErrorMessage(error) {
  const detail = typeof error?.message === "string" && !/[\r\n]/.test(error.message)
    ? error.message.slice(0, 240)
    : "The external data request failed.";
  return `${detail} No access key or account credential was sent.`;
}

function validatePublicHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("https://")) {
    throw new TypeError("demo sources must use a bounded public HTTPS URL");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("demo source URL is invalid");
  }
  if (url.username || url.password || blockedHostname(url.hostname)) {
    throw new TypeError("demo source URL may not contain credentials or target a private host");
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) throw new TypeError("demo source URL may not contain credential-like query parameters");
  }
  return value;
}

function blockedHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".home.arpa") || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.trim();
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}
