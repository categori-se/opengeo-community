import {AuthoredResourceMetadata} from "./AuthoredResourceMetadata.js";
import {PublicationArtifactReferences} from "./PublicationArtifactReferences.js";
import {insertPublicArtifact} from "../lib/publicationArtifactEmbed.js";
import {verifyPortableMapArtifact, readPortableMapManifest} from "../lib/portableMapArtifact.js";
import {parseSitePrintLayout, normalizeObservableSourceFiles, normalizeObservableRevisionAttachments, normalizeObservableRevisionReferencedFiles, validateStaticPublicationTree, validateJupyterPublicationTree, canReuseDeferredObservableSourceFile} from "../lib/apiClient.js";
import {FrameworkDataAttachments} from "./FrameworkDataAttachments.js";
import {FrameworkRevisionData} from "./FrameworkRevisionData.js";
import {FrameworkBuildHistory} from "./FrameworkBuildHistory.js";
import {FrameworkPublications} from "./FrameworkPublications.js";
import {FrameworkWorkflowStatus} from "./FrameworkWorkflowStatus.js";
import {FrameworkGitHubConnection} from "./FrameworkGitHubConnection.js";
import {PublicationPanels} from "./PublicationPanels.js";
import {SourceFileExplorer} from "./SourceFileExplorer.js";
import {PublicationCommands} from "./PublicationCommands.js";
import {PublicationSourceHistory} from "./PublicationSourceHistory.js";
import {FrameworkProjectPreview} from "./FrameworkProjectPreview.js";
import {PublicationCodeEditor} from "./PublicationCodeEditor.js";
import {NotebookImportReview} from "./NotebookImportReview.js";
import {convertLegacyNotebook} from "./ObservableNotebookPreview.js";
import {publicationMapInsert} from "../lib/publicationMapInsert.js";
import {openPublicationMapPicker} from "./PublicationMapPicker.js";
import {publicationFormats, publicationStarter, publicationFormatEnabled} from "../lib/publicationDrafts.js";
import {sourceRevisionChanges} from "../lib/sourceRevisionChanges.js";
import {publicationSourceRoot} from "../lib/publicationSourceRoot.js";
import {planPublicationSourceDownload, createPublicationSourceDownloadReader} from "../lib/publicationSourceDownload.js";
import {SitePagePreview} from "./SitePagePreview.js";
import {reconcileFrameworkArchiveFiles, planFrameworkDataSeparation, createFrameworkAttachmentReader,
  publicationFileAttachmentSnippet} from "../lib/frameworkArchiveInputs.js";
import {projectHref} from "../lib/applicationRoutes.js";
import {
  convertGeoMoosePrintLayout,
  GEOMOOSE_PRINT_CONVERSION_LIMITS
} from "../lib/geomoosePrintLayout.js";

const PAGE_KINDS = new Set(["document", "story", "dashboard", "map"]);

/** A site has one authoring surface, chosen by its actual source binding. */
export function ProjectPublishingWorkspace({state, refresh, initialResourceTarget = null}) {
  const root = document.createElement("section");
  root.className = "project-publishing-workspace";
  root.id = "project-sites";
  const sourceAnchor = document.createElement("span"); sourceAnchor.id = "framework-source";
  root.append(sourceAnchor);
  const sites = state.sites ?? [];
  const sources = new Map((state.observableSourceProjects ?? []).map(source => [source.siteId, source]));
  const heading = document.createElement("header");
  heading.append(text("h2", "Publications"));
  const choice = document.createElement("select");
  choice.setAttribute("aria-label", "Publication");
  for (const site of sites) {
    const option = text("option", site.title);
    option.value = site.id; choice.append(option);
  }
  const selectionKey = `opengeo:publication:${state.project.id}`;
  try {
    const selected = root.ownerDocument.defaultView.sessionStorage.getItem(selectionKey);
    if (sites.some(site => site.id === selected)) choice.value = selected;
  } catch { /* Selection still works when browser storage is unavailable. */ }
  choice.hidden = sites.length < 2;
  heading.append(choice); root.append(heading);
  const handoff = resolveSiteResourceHandoff(state, initialResourceTarget);
  if (handoff) root.append(siteResourceHandoffNotice(root, handoff, sites));
  const content = document.createElement("div"), opened = new Map();
  function show() {
    const site = sites.find(site => site.id === choice.value) ?? sites[0];
    if (!site) return;
    try {root.ownerDocument.defaultView.sessionStorage.setItem(selectionKey,site.id);} catch { /* Optional preference. */ }
    if (!opened.has(site.id)) {
      const source = sources.get(site.id);
      opened.set(site.id, source ? observableSourceProjectCard(state, refresh, site, source)
        : siteCard(state, refresh, site, {workspace: true}));
      if (typeof state.adapter.getAuthoredKnowledge === "function") {
        opened.get(site.id).append(AuthoredResourceMetadata({adapter:state.adapter, kind:"publication", id:site.id}));
      }
      content.append(opened.get(site.id));
    }
    for (const [id, element] of opened) element.hidden = id !== site.id;
  }
  root.addEventListener("opengeo-reveal-draft", event => {
    const entry = [...opened].find(([, element]) => element.contains(event.target));
    if (entry) {choice.value = entry[0]; show();}
  });
  choice.addEventListener("change", show); show();
  const selectedCard = () => opened.get(choice.value || sites[0]?.id);
  const hasSource = () => canManage(state) && sources.has(choice.value || sites[0]?.id);
  const command = name => selectedCard()?.runPublicationCommand?.(name);
  let setupDialog = null;
  const openSetup = () => {
    if (!canManage(state)) return;
    if (!setupDialog) {
      setupDialog = document.createElement('dialog'); setupDialog.className = 'publication-new-dialog';
      setupDialog.ariaLabel = 'New publication';
      const close = button('Close', 'platform-button secondary'); close.ariaLabel = 'Close new publication';
      close.onclick = () => {if (setupDialog.close) setupDialog.close(); else setupDialog.open = false;};
      setupDialog.append(close, PublicationPanels({label: 'New publication type',
        initial: handoff?.status === 'ready' ? 'pages' : 'framework', panels: [
          {id: 'framework', label: 'Files and notebooks', render: () => frameworkPublicationSetup(state, refresh)},
          {id: 'pages', label: 'Maps and pages', render: () => siteCreator(state, refresh, handoff)}
        ]}));
      root.append(setupDialog);
    }
    if (setupDialog.showModal) setupDialog.showModal(); else setupDialog.open = true;
  };
  const commands = PublicationCommands({menus: [
    {label: 'File', commands: [
      {label: 'New publication…', enabled: () => canManage(state), run: openSetup},
      {label: 'New page…', enabled: hasSource, run: () => command('new-page')},
      {label: 'Save draft', enabled: hasSource, run: () => command('save')},
      {label: 'Import files or folder…', enabled: hasSource, run: () => command('import')},
      {label: 'Export source…', enabled: hasSource, run: () => command('export')}
    ]},
    {label: 'View', commands: [
      ...['files', 'preview', 'publish', 'settings'].map(name => ({label: `Show ${name}`,
        enabled: () => Boolean(selectedCard()?.runPublicationCommand), run: () => command(name)})),
      {label: 'Toggle explorer', enabled: hasSource, run: () => command('explorer')},
      {label: 'Version history', enabled: hasSource, run: () => command('history')}
    ]},
    {label: 'Insert', commands: [{label: 'Studio map…', enabled: hasSource, run: () => command('map')}]},
    {label: 'Settings', commands: [{label: 'Public addresses…',
      enabled: () => Boolean(selectedCard()?.runPublicationCommand), run: () => command('addresses')}]}
  ]});
  root.append(commands);
  root.append(content);
  if (canManage(state) || canPublish(state)) {
    const collaborators = document.createElement('details'); collaborators.className = 'publication-collaborators';
    collaborators.append(text('summary', 'Workspace access'));
    collaborators.addEventListener('toggle', () => {
      if (collaborators.open && !collaborators.dataset.loaded) {
        collaborators.dataset.loaded = 'true'; collaborators.append(projectCollaboratorInvite(state));
      }
    });
    root.append(collaborators);
  }
  if (!sites.length) {
    const empty = text('p', 'Create a publication to start writing.');
    if (canManage(state)) empty.append(button('New publication…'));
    empty.querySelector('button')?.addEventListener('click', openSetup);
    root.append(empty);
    if (handoff?.status === 'ready') queueMicrotask(openSetup);
  }
  return root;
}

export function ProjectSites({state, refresh, initialResourceTarget = null}) {
  const section = document.createElement("section");
  section.className = "project-sites";
  section.id = "project-sites";
  section.dataset.state = "ready";
  const resourceHandoff = resolveSiteResourceHandoff(state, initialResourceTarget);
  const sites = state.sites ?? [];

  const heading = document.createElement("header");
  heading.className = "project-resources-heading";
  const identity = document.createElement("div");
  identity.append(
    text("p", "General site publishing", "platform-eyebrow"),
    text("h2", "Project sites and portable editions"),
    text(
      "p",
      `${state.sites?.length ?? 0} site identities · shared auth.categori.se`,
      "platform-subtitle"
    )
  );
  heading.append(
    identity,
    text(
      "p",
      "Mixed content · map optional · reviewed releases · static ZIP",
      "project-resources-boundary"
    )
  );
  section.append(heading);
  if (resourceHandoff) {
    section.append(siteResourceHandoffNotice(section, resourceHandoff, sites));
  }

  if (typeof state.adapter.listSites !== "function") {
    section.append(text(
      "p",
      "Durable site publishing is unavailable in this fixture adapter.",
      "project-resource-feedback"
    ));
    return section;
  }
  if (canManage(state)) section.append(siteCreator(state, refresh, resourceHandoff));
  if (canManage(state) || canPublish(state)) section.append(projectCollaboratorInvite(state));

  const catalog = document.createElement("div");
  catalog.className = "project-site-catalog";
  if (!sites.length) {
    catalog.append(text(
      "p",
      "No site exists yet. Create one from governed stories, documents, dashboards, or maps; maps are never required.",
      "project-resource-feedback"
    ));
  } else {
    catalog.append(...sites.map((site) => siteCard(state, refresh, site)));
  }
  section.append(catalog);
  return section;
}

export function FrameworkSourceWorkspace({state, refresh, legacyConverter = convertLegacyNotebook}) {
  const workspace = document.createElement("section");
  workspace.className = "project-resource-editor-panel observable-source-workspace";
  workspace.id = "framework-source";
  workspace.append(
    text("h2", "Publication workspace"),
    text(
      "p",
      "Edit files, preview your changes, and publish to a configured destination.",
      "project-resource-feedback"
    )
  );
  if (typeof state.adapter.listObservableSourceProjects !== "function") {
    workspace.append(text(
      "p",
      "Durable Observable Framework authoring is unavailable in this adapter.",
      "project-resource-feedback"
    ));
    return workspace;
  }
  const projects = state.observableSourceProjects ?? [];
  const bySite = new Map(projects.map((project) => [project.siteId, project]));
  if (!state.sites?.length) {
    if (canManage(state) && ["createResource", "createSite", "createObservableSourceProject"].every(method => typeof state.adapter[method] === "function")) {
      workspace.append(frameworkPublicationSetup(state, refresh));
    } else workspace.append(text("p", "An owner or editor can set up a private Framework publication in this project. No new GIS project is required.", "project-resource-feedback"));
    return workspace;
  }
  for (const site of state.sites) {
    const sourceProject = bySite.get(site.id);
    if (sourceProject) {
      workspace.append(observableSourceProjectCard(state, refresh, site, sourceProject, legacyConverter));
    } else if (canManage(state)) {
      workspace.append(observableSourceProjectCreator(state, refresh, site));
    } else {
      workspace.append(text(
        "p",
        `${site.title} has no multi-file source project. Site manage permission is required to create one.`,
        "project-resource-feedback"
      ));
    }
  }
  return workspace;
}

function publicationWorkflowSummary(state) {
  const panel = document.createElement("section");
  panel.className = "framework-workflow-summary";
  panel.append(text("h3", "Your publication workspace"));
  const steps = document.createElement("ol");
  const sourceProjects = state.observableSourceProjects ?? [];
  for (const description of [
    sourceProjects.length ? 'Open Files to edit the saved source or import a folder.' : 'Choose a publication format and start a private draft.',
    'Add maps and data, save your changes, then open Preview.',
    'In Publish, choose a public address and approve the exact build to release.'
  ]) steps.append(text("li", description));
  const data = document.createElement("a");
  data.href = projectHref(state.project.id, {adapterKind: state.adapter.kind, management: "data"});
  data.className = "platform-button secondary";
  data.textContent = "Review this project's data";
  panel.append(steps, data);
  return panel;
}

function frameworkPublicationSetup(state, refresh) {
  const panel = document.createElement("section");
  panel.className = "project-resource-editor-panel framework-publication-setup";
  panel.append(text("h3", "New publication"), text("p", "Choose a format. Your draft starts private.", "project-resource-feedback"));
  const title = labeledInput("Publication title", state.project.name, 300);
  const slug = labeledInput("Publication identifier", siteSlug(state.project.name), 160);
  const format = document.createElement("select"); format.ariaLabel = "Publication format";
  for (const [value, label] of publicationFormats) {
    const item = text("option", label); item.value = value;
    item.disabled = !publicationFormatEnabled(value) || value !== "framework" && typeof state.adapter.saveObservableSourceRevision !== "function";
    if (item.disabled) item.textContent += " · server update pending";
    format.append(item);
  }
  const setup = button("Set up private publication");
  const reload = button("Reload setup status", "platform-button secondary");
  reload.hidden = true;
  const feedback = text("p", "An editable home page is created first. You can also import an existing folder or insert a Studio map export.", "project-resource-feedback");
  feedback.setAttribute("role", "status");
  let started = false;
  let phase = "home document";
  reload.addEventListener("click", async () => {
    reload.disabled = true;
    try { await refresh(); }
    catch { feedback.textContent = "Setup status could not be reloaded. Your existing project and any completed steps remain saved."; }
    finally { reload.disabled = false; }
  });
  setup.addEventListener("click", async () => {
    if (started) return;
    if (!publicationFormatEnabled(format.value)) {feedback.textContent = "This format requires the pending publishing-service update. Nothing was created."; return;}
    const name = title.control.value.trim();
    const identifier = slug.control.value.trim();
    if (!name || name.length > 300 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identifier) || identifier.length > 140) {
      feedback.textContent = "Enter a title and an identifier of at most 140 lowercase letters, digits and separating hyphens.";
      return;
    }
    started = true;
    setup.disabled = title.control.disabled = slug.control.disabled = format.disabled = true;
    try {
      feedback.textContent = "Step 1 of 3: creating the private publication home…";
      const home = await state.adapter.createResource(state.project.id, {
        kind: "document", slug: `${identifier}-home`, visibility: "restricted",
        metadata: {title: name, abstract: `Private publication home for ${name}.`, language: "en", license: null, attribution: null, keywords: ["Observable Framework", "publication"], profile: "opengeo.core.v1"},
        content: {blocks: [{id: "introduction", type: "markdown", markdown: "Publication source will be imported and reviewed in Studio."}]},
        provenance: {creationIntent: "file-publication", initialPublicationFormat: format.value}
      });
      phase = "site identity";
      feedback.textContent = "Step 2 of 3: creating the draft site identity…";
      const site = await state.adapter.createSite(state.project.id, {
        slug: identifier, title: name, description: state.project.description ?? null,
        language: "en", theme: "minimal", themeOptions: {accentColor: "#176b87"},
        pages: [{slug: "home", navigationLabel: "Home", resourceId: home.id, resourceVersion: home.versionNumber, isHome: true}]
      });
      phase = "Framework source project";
      feedback.textContent = "Step 3 of 3: creating the private Framework source project…";
      const source = await state.adapter.createObservableSourceProject(state.project.id, site.id, {title: `${name} source`});
      if (typeof state.adapter.saveObservableSourceRevision === "function") {
        phase = "initial source files";
        await state.adapter.saveObservableSourceRevision(state.project.id, source.id, publicationStarter({format: format.value, title: name, sourceProject: source}));
      }
      phase = "workspace refresh";
      feedback.textContent = "Private publication setup saved. Loading the source editor… Nothing has been published.";
      await refresh();
    } catch (error) {
      // A lost response may follow a committed write. Never replay setup here.
      feedback.textContent = phase === 'initial source files' && error?.status === 422
        ? 'The source files were rejected. Your publication identity is saved. Reload setup status, then open Files to review or import the source. Do not create another publication.'
        : phase === 'initial source files' && error?.code === 'upload_network_unavailable'
        ? 'The browser could not upload the source files. Your publication identity is saved. Check your connection and reload setup status before retrying; do not create another publication.'
        : `Could not confirm ${phase}. Completed steps remain in this project. Reload setup status before continuing; do not create another project. If only the home document exists, use it in the draft-site form below. If the site exists, continue with its source-project setup.`;
      reload.hidden = false;
    }
  });
  const formatLabel = document.createElement('label'); formatLabel.append(text('span', 'Format'), format);
  const identity = document.createElement('details'); identity.append(text('summary', 'Publication identifier'), slug.label);
  let customSlug = false;
  slug.control.addEventListener('input', () => {customSlug = true;});
  title.control.addEventListener('input', () => {if (!customSlug) slug.control.value = siteSlug(title.control.value);});
  panel.append(title.label, formatLabel, identity, setup, reload, feedback);
  return panel;
}

function observableSourceProjectCreator(state, refresh, site) {
  const card = document.createElement("article");
  card.className = "project-site-card observable-source-project";
  const title = labeledInput("Source project title", `${site.title} source`, 300);
  const submit = button(`Create source project for ${site.slug}`);
  const feedback = text(
    "p",
    "The server pins the compiler image digest and deny-all network policy.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Creating the site-bound source identity…";
    try {
      await state.adapter.createObservableSourceProject(state.project.id, site.id, {
        title: title.control.value
      });
      await refresh();
    } catch (error) {
      feedback.textContent = `Source project creation failed safely (${error?.code ?? error?.message ?? "invalid_source_project"}).`;
      submit.disabled = false;
    }
  });
  card.append(
    text("h4", `${site.title} · ${site.slug}`),
    text("p", "No multi-file source project is attached.", "project-resource-feedback"),
    title.label,
    submit,
    feedback
  );
  return card;
}

function observableSourceProjectCard(state, refresh, site, sourceProject, legacyConverter = convertLegacyNotebook) {
  const card = document.createElement("article");
  card.className = "project-site-card observable-source-project";
  card.dataset.rightsStatus = sourceProject.rightsStatus;
  const versionNote = text("p", `Draft version ${sourceProject.currentRevisionNumber}`, "project-resource-feedback");
  card.append(text("h3", sourceProject.title), versionNote);
  card.addEventListener('opengeo-publication-draft-saved', () => {
    versionNote.textContent = `Draft version ${sourceProject.currentRevisionNumber}`;
    for (const preview of card.querySelectorAll('.framework-project-preview')) preview.sourceDraftSaved?.();
  });
  let sourceEditor = null;
  let publicationReleases = null;
  let addressSettings = null;
  const editable = canManage(state);
  const draftSurface = editable ? 'draft' : undefined;
  const draftEditor = () => sourceEditor ??= observableRevisionEditor(state, refresh, sourceProject, legacyConverter);
  const panels = PublicationPanels({onSelect: id => sourceEditor?.setPreviewOnly(id === 'preview'), panels: [
    {id: "files", label: "Files", surface: draftSurface, render: () => editable
      ? draftEditor()
      : text("p", "Your access is read-only. Ask a project editor to revise the source.")},
    {id: "preview", label: "Preview", surface: draftSurface,
      render: () => editable ? draftEditor() : frameworkPreviewWorkspace(state, sourceProject)},
    {id: "publish", label: "Publish", render: () => (publicationReleases = FrameworkPublications({adapter: state.adapter,
      projectId: state.project.id, sourceProjectId: sourceProject.id, mode: 'releases',
      onConfigure: () => card.runPublicationCommand('addresses')}))},
    {id: "settings", label: "Settings", render: () => {
      const settings = document.createElement("div");
      addressSettings = document.createElement('details');
      addressSettings.className = 'publication-address-settings';
      addressSettings.append(text('summary', 'Public addresses'));
      addressSettings.addEventListener('toggle', () => {
        if (addressSettings.open && !addressSettings.dataset.loaded) {
          addressSettings.dataset.loaded = 'true';
          addressSettings.append(FrameworkPublications({adapter: state.adapter, projectId: state.project.id,
            sourceProjectId: sourceProject.id, mode: 'addresses'}));
        }
      });
      settings.append(addressSettings);
      settings.append(FrameworkGitHubConnection({adapter: state.adapter, projectId: state.project.id,
        sourceProjectId: sourceProject.id, canManage: canManage(state)}),
      FrameworkDataAttachments({state, sourceProject, canManage: canManage(state)}));
      const technical = document.createElement("details");
      technical.append(text("summary", "Build configuration and source details"),
        text("p", `Source ${sourceProject.id} · site ${site.slug} · rights ${sourceProject.rightsStatus}`),
        text("code", `${sourceProject.buildPolicy.compilerImageDigest} · network ${sourceProject.buildPolicy.networkPolicy}`, "observable-source-policy"),
        publicationWorkflowSummary(state));
      technical.addEventListener("toggle", () => {
        if (technical.open && !technical.dataset.loaded) {
          technical.dataset.loaded = "true";
          technical.append(FrameworkWorkflowStatus({adapter: state.adapter, projectId: state.project.id}));
        }
      });
      settings.append(PublicationArtifactReferences({adapter: state.adapter, projectId: state.project.id,
        sourceProjectId: sourceProject.id, sourceRevisionId: sourceProject.currentRevisionId, canManage: canManage(state),
        onInsertPublicRelease: async release => {
          if (!sourceEditor) throw Error('Open the Publication files first');
          await sourceEditor.insertPublicRelease(release);
          panels.selectPanel('files');
        }}), technical); return settings;
    }}
  ]});
  card.runPublicationCommand = name => {
    if (name === 'addresses') {
      panels.selectPanel('settings'); addressSettings.open = true;
      addressSettings.querySelector('summary').focus();
    } else if (['files', 'preview', 'publish', 'settings'].includes(name)) panels.selectPanel(name);
    else if (canManage(state)) {panels.selectPanel('files'); sourceEditor.runPublicationCommand(name);}
  };
  card.addEventListener('opengeo-publication-destinations-changed', event => publicationReleases?.refreshStatus(event.detail));
  card.append(panels);
  return card;
}

function frameworkPreviewWorkspace(state, sourceProject) {
  const card = document.createElement("section");
  card.className = "framework-preview-workspace";
  const savedPreview = FrameworkProjectPreview({adapter: state.adapter, projectId: state.project.id,
    sourceProject, canManage: canManage(state)});
  card.append(savedPreview);
  card.closePreview = () => savedPreview.closePreview();
  const history = document.createElement("details");
  history.append(text("summary", "Build history"));
  history.addEventListener("toggle", () => {
    if (!history.open || history.dataset.loaded) return;
    history.dataset.loaded = "true";
    history.append(FrameworkBuildHistory({adapter: state.adapter, projectId: state.project.id,
      sourceProjectId: sourceProject.id, canManage: canManage(state)}));
  });
  card.append(history);
  return card;
}

function observableRevisionEditor(state, refresh, sourceProject, legacyConverter) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "observable-source-revision-editor";
  fieldset.append(text("legend", "Source files"));
  const title = labeledInput("Source revision title", sourceProject.title, 300);
  const entry = labeledInput("Publication entry path", "index.md", 512);
  const lockfile = labeledInput("Lockfile path (optional)", "package-lock.json", 512);
  const summary = labeledInput("Draft change note", "Update draft", 500);
  const rights = labeledSelect("Source publication rights", ["unreviewed", "approved", "rejected"]);
  rights.control.ariaLabel = "Source publication rights";
  rights.control.value = sourceProject.rightsStatus ?? "unreviewed";
  const rightsLabels = ["Not reviewed", "I have permission to publish these source files", "Do not publish"];
  [...rights.control.options].forEach((option, index) => {option.textContent = rightsLabels[index];});
  const rightsNote = text("p", "Saving a draft keeps its version history. Use Publish to update the public version after reviewing your changes.", "project-resource-feedback");
  let dataAttachments = [];
  let referencedFiles = [];
  const boundData = text("p", "No archived data is bound in this working revision.", "project-resource-feedback");
  const fileLabel = document.createElement("label");
  fileLabel.append(text("span", "Source files"));
  const files = document.createElement("input");
  files.type = "file";
  files.multiple = true;
  fileLabel.append(files);
  const directoryLabel = document.createElement("label");
  directoryLabel.append(text("span", "Source project directory (optional)"));
  const directory = document.createElement("input");
  directory.type = "file";
  directory.multiple = true;
  directory.setAttribute("webkitdirectory", "");
  directory.setAttribute("directory", "");
  directoryLabel.append(directory);
  const sourceArchive = document.createElement("input");
  sourceArchive.type = "file"; sourceArchive.accept = ".zip,application/zip";
  sourceArchive.ariaLabel = "OpenGeo Studio source project ZIP";
  const sourceArchiveLabel = document.createElement("label");
  sourceArchiveLabel.append(text("span", "OpenGeo Studio source project ZIP"), sourceArchive);
  const archiveReview = document.createElement("section"); archiveReview.hidden = true;
  const archiveFeedback = text("p", "Choose a ZIP made by Download source project to verify its files before importing.", "project-resource-feedback");
  archiveFeedback.setAttribute("role", "status");
  const importedTitle = labeledInput("Imported revision title", "", 300);
  const importedEntry = labeledSelect("Imported entry path", []);
  const importedLock = labeledSelect("Imported lockfile path", []);
  const applyArchive = button("Use imported source", "platform-button secondary"); applyArchive.disabled = true;
  const legacyImport = document.createElement("details");
  const legacyFile = document.createElement("input"); legacyFile.type = "file";
  legacyFile.accept = ".js,.mjs,.json"; legacyFile.ariaLabel = "Observable JavaScript or JSON export";
  const legacyFolder = document.createElement("input"); legacyFolder.type = "file"; legacyFolder.multiple = true;
  legacyFolder.setAttribute("webkitdirectory", ""); legacyFolder.setAttribute("directory", "");
  legacyFolder.ariaLabel = "Original Observable export folder";
  const legacyReview = button("Review Observable conversion", "platform-button secondary");
  legacyImport.append(text("summary", "Convert an Observable export"),
    text("p", "Choose the original JavaScript module or hosted source JSON. If it uses local attachments, also choose the original export folder containing them. Conversion keeps the original export and a loss report; it does not run the module, fetch remote files or save anything."),
    legacyFile, text("p", "Original export folder (optional, for attachments)"), legacyFolder, legacyReview);
  const selected = text(
    "p",
    "Open saved files or import a Framework project folder or static HTML files. You can include Studio map exports as HTML assets. Up to 128 files, 4 MiB each and 16 MiB total.",
    "project-resource-feedback"
  );
  const sourceFile = document.createElement("select");
  sourceFile.ariaLabel = "Framework source file";
  sourceFile.hidden = true;
  const sourceSearch = document.createElement("input");
  sourceSearch.type = "search";
  sourceSearch.ariaLabel = "Find source file";
  sourceSearch.placeholder = "Find a page or file, e.g. src/methods/";
  sourceSearch.hidden = true;
  const importReview = text("p", "", "project-resource-feedback");
  importReview.setAttribute("role", "status");
  const importGuidance = document.createElement("section");
  importGuidance.className = "framework-import-guidance";
  importGuidance.hidden = true;
  const sourceText = document.createElement("textarea");
  sourceText.rows = 18;
  sourceText.spellcheck = false;
  sourceText.ariaLabel = "Framework source editor";
  sourceText.hidden = true;
  const codeEditor = PublicationCodeEditor({textarea: sourceText, onSave: () => submit.click(),
    onDispose: () => attachmentReader.dispose(),
    preview: () => frameworkPreviewWorkspace(state, sourceProject),
    getSourceContext: () => {
      const records = new Map(workingFiles.map(record => [record.relativePath, record]));
      const loader = savedFileLoader;
      const draftPath = activePath, draftText = sourceText.value;
      const bindings = new Map(dataAttachments.map(record => [record.relativePath, record]));
      const publicPaths = new Set(referencedFiles.map(record => record.relativePath));
      const dataReader = attachmentReader;
      const tree = treeGeneration, generation = editorGeneration;
      const contextAdapter = state.adapter, contextProject = state.project;
      const contextUserId = state.session?.userId, contextOrganizationId = state.organization?.id;
      const checkCurrent = () => {
        if (state.adapter !== contextAdapter || state.project !== contextProject
          || state.session?.userId !== contextUserId || state.organization?.id !== contextOrganizationId) {
          throw Error('The publication account changed');
        }
        if (!fieldset.isConnected) throw Error('The publication editor is closed');
        if (tree !== treeGeneration || generation !== editorGeneration || draftPath !== activePath
          || draftText !== sourceText.value) throw Error('The publication draft changed');
      };
      return {sourceRoot: publicationSourceRoot(entry.control.value, [...records.keys()]),
        assertStandaloneExport: () => {
          checkCurrent();
          if (publicPaths.size) throw Error('Use Saved preview to download a publication with connected public files.');
        },
        readFileMetadata: async path => {
          checkCurrent();
          // Local edits have no immutable registry pin; export derives their
          // actual byte facts instead of retaining a saved object's identity.
          if (records.has(path)) return null;
          if (publicPaths.has(path)) throw Error('Use Saved preview to download a publication with connected public files.');
          const binding = bindings.get(path);
          if (!binding) throw Error(`Source file not found: ${path}`);
          const metadata = await dataReader.metadata(path);
          checkCurrent();
          if (metadata.attachmentId !== binding.attachmentId) throw Error('The draft file reference changed');
          return metadata;
        },
        readFile: async path => {
          checkCurrent();
          if (publicPaths.has(path)) return dataReader.read(path);
          if (path === draftPath) return new Blob([draftText], {type: records.get(path)?.contentType ?? 'text/plain'});
          const record = records.get(path);
          if (!record && bindings.has(path)) return dataReader.read(path);
          if (!record) throw Error(`Source file not found: ${path}`);
          if (!record.blob) await loader(record);
          return record.blob;
        }};
    }});
  codeEditor.onSelect(path => {sourceFile.value = path; void openWorkingFile(path);});
  const explorer = SourceFileExplorer({onSelect: path => {
    sourceFile.value = path; void openWorkingFile(path);
  }, onNewPage: folder => openNewPage(folder)});
  const breadcrumb = text("p", "Select a file", "source-editor-path");
  const editorFeedback = text(
    "p",
    "Text, Markdown, JavaScript, CSS, JSON, CSV, HTML, and SVG files can be edited here. Images remain exact binary files.",
    "project-resource-feedback"
  );
  editorFeedback.hidden = true;
  /** @type {Array<{relativePath: string, blob: Blob, contentType: string}>} */
  let workingFiles = [];
  const newAttachmentReader = () => createFrameworkAttachmentReader({adapter: state.adapter,
    projectId: state.project.id, sourceProjectId: sourceProject.id,
    getBindings: () => dataAttachments, getFiles: () => workingFiles, getReferencedFiles: () => referencedFiles});
  let attachmentReader = newAttachmentReader();
  let savedFileLoader = null;
  let activePath = null;
  let activeTextBaseline = null;
  let activeTextBom = false;
  let activeLineEnding = "\n";
  let editorGeneration = 0;
  let treeGeneration = 0;
  let importGeneration = null;
  let committing = false;
  let revisionCommitted = false;
  let openedRevisionBaseline = null;
  const draftStatus = text("span", "Open or import a draft", "publication-draft-status");
  draftStatus.setAttribute("role", "status"); draftStatus.setAttribute("aria-live", "polite");
  const draftAdapter = state.adapter, draftProject = state.project, draftUserId = state.session?.userId;
  const draftOrganizationId = state.organization?.id;
  const draftProjectId = draftProject.id, draftSourceId = sourceProject.id;
  const draftEditorCurrent = () => fieldset.isConnected && state.adapter === draftAdapter && state.project === draftProject
    && state.project.id === draftProjectId && state.session?.userId === draftUserId
    && state.organization?.id === draftOrganizationId && sourceProject.id === draftSourceId;
  const contextProviders = {tokenProvider: draftAdapter.tokenProvider,
    organizationProvider: draftAdapter.organizationProvider, baseUrl: draftAdapter.baseUrl};
  const canAutosave = typeof contextProviders.tokenProvider === 'function'
    && typeof contextProviders.organizationProvider === 'function';
  // Capture the editor's authority before edits, never the next account's token.
  const draftContext = canAutosave ? (async () => {
    const token = await contextProviders.tokenProvider.call(draftAdapter);
    const organization = String(await contextProviders.organizationProvider.call(draftAdapter)).toLowerCase();
    if (draftAdapter.tokenProvider !== contextProviders.tokenProvider
      || draftAdapter.organizationProvider !== contextProviders.organizationProvider
      || draftAdapter.baseUrl !== contextProviders.baseUrl) throw Error('The draft session changed');
    return {context: Object.freeze({...contextProviders, token, organization})};
  })().catch(error => ({error})) : Promise.resolve({context: null});
  let autosaveTimer = null, autosavePaused = false, draftDirty = false;
  const clearAutosave = () => { clearTimeout(autosaveTimer); autosaveTimer = null; };
  const scheduleAutosave = () => {
    clearAutosave();
    if (!canAutosave || autosavePaused || !draftDirty || revisionCommitted) return;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (!fieldset.isConnected) return;
      if (!canManage(state)) {
        autosavePaused = true;
        draftStatus.textContent = 'Autosave paused · edit access changed';
        return;
      }
      void saveDraft(true);
    }, 8000);
    autosaveTimer.unref?.();
  };
  const markDraftChanged = () => {
    draftDirty = true;
    draftStatus.textContent = autosavePaused ? 'Autosave paused · changes remain in this editor' : 'Unsaved changes';
    scheduleAutosave();
  };
  let importedMapEditor = null;
  const importedMapReview = document.createElement("details");
  importedMapReview.append(text("summary", "Reconnect imported map paths"));
  importedMapReview.hidden = true;
  const checkImportedMapDraft = (checkLayout = false) => importedMapEditor?.assertImportReady({checkLayout});
  const clearImportedMaps = () => { importedMapEditor?.remove(); importedMapEditor = null; importedMapReview.hidden = true; };
  const notebookReview = NotebookImportReview({getSource: () => activePath && !sourceText.hidden && !sourceText.disabled
    ? {path: activePath, source: sourceText.value,
      availablePaths: [...workingFiles, ...dataAttachments, ...referencedFiles].map(file => file.relativePath)} : null});
  sourceText.addEventListener("input", () => notebookReview.update());
  const showBindings = () => {
    const archived = dataAttachments.length
      ? `Linked files: ${dataAttachments.map(item => item.relativePath).join(", ")}. ${entry.control.value.endsWith(".ipynb") ? "Jupyter displays saved outputs; linking a file does not execute Python or refresh outputs." : "Live preview reads each exact file once; saving retains references without copying data."}`
      : entry.control.value.endsWith(".ipynb") ? "Link exact data versions for provenance. Jupyter displays saved outputs; execute Python locally before importing." : "Link a registered data file to use it with FileAttachment in this draft.";
    boundData.textContent = referencedFiles.length
      ? `${archived} Connected public files: ${referencedFiles.map(item => item.relativePath).join(", ")}. ${entry.control.value.endsWith(".ipynb") ? "Jupyter displays saved outputs; linking a file does not execute Python or refresh outputs." : "Live preview reads each source once and reuses its verified bytes. Saving retains references."}`
      : archived;
  };
  const archiveEditor = FrameworkRevisionData({state, sourceProject,
    canManage: canManage(state),
    getBindings: () => dataAttachments, getFiles: () => workingFiles,
    getReferencedFiles: () => referencedFiles,
    getFormat: () => entry.control.value.endsWith(".ipynb") ? "jupyter" : "framework",
    getSourceRoot: () => publicationSourceRoot(entry.control.value, workingFiles.map(file => file.relativePath)),
    onInsert: ({relativePath, readMethod}) => {
      if (/\.ipynb$/i.test(entry.control.value)) throw Error("Jupyter publishes saved outputs. Execute Python locally with the selected data version, then import the executed notebook.");
      if (/\.html$/i.test(activePath ?? '') && !/<notebook(?:\s|>)/i.test(sourceText.value)) {
        throw Error('Open a Framework or Observable notebook page to insert FileAttachment code');
      }
      codeEditor.insert(publicationFileAttachmentSnippet(activePath, relativePath, readMethod, sourceText.value));
    },
    isLocked: () => committing || revisionCommitted,
    onReload: async (records, sources) => { if (await attachmentReader.reload(records, sources)) codeEditor.refreshPreview(); },
    onConnected: async () => { if (await attachmentReader.invalidateInventory()) codeEditor.refreshPreview(); },
    onChange: bindings => {
      ++treeGeneration; dataAttachments = bindings; showBindings(); notebookReview.update(); markDraftChanged();
      void attachmentReader.invalidateBindings().then(current => {if (current) codeEditor.refreshPreview();}).catch(() => {});
    },
    onReferencesChange: bindings => {
      ++treeGeneration; referencedFiles = bindings; showBindings(); notebookReview.update(); markDraftChanged();
      void attachmentReader.invalidateBindings().then(current => {if (current) codeEditor.refreshPreview();}).catch(() => {});
    }
  });
  for (const control of [sourceText, title.control, entry.control, lockfile.control, summary.control]) {
    // A saved-revision request begun before a new edit no longer owns the draft.
    control.addEventListener("input", () => { ++treeGeneration; markDraftChanged(); });
  }
  rights.control.addEventListener('change', () => { ++treeGeneration; markDraftChanged(); });
  const isTextFile = (record) => record.contentType.startsWith("text/")
    || ["application/json", "application/geo+json", "application/x-ipynb+json", "image/svg+xml"].includes(record.contentType);
  const saveActiveText = () => {
    if (activePath === null || sourceText.hidden || sourceText.disabled || sourceText.value === activeTextBaseline) return;
    const index = workingFiles.findIndex(({relativePath}) => relativePath === activePath);
    if (index < 0) return;
    const current = workingFiles[index];
    const editedText = (activeTextBom ? "\uFEFF" : "")
      + (activeLineEnding === "\r\n" ? sourceText.value.replace(/\n/g, "\r\n") : sourceText.value);
    workingFiles[index] = {
      ...current,
      blob: new Blob([editedText], {type: current.contentType})
    };
    activeTextBaseline = sourceText.value;
  };
  const downloadSource = button("Download source", "platform-button secondary");
  const downloadProject = button("Download source project", "platform-button secondary");
  const downloadBackup = button("Download complete input backup", "platform-button secondary");
  const cancelDownload = button("Cancel download", "platform-button secondary");
  cancelDownload.hidden = true;
  const downloadEstimate = text("p", "Open a source draft to estimate its export.", "project-resource-feedback");
  downloadEstimate.setAttribute("aria-live", "polite");
  const downloadFeedback = text("p", "Download the selected source file, including its current edits.", "project-resource-feedback");
  downloadFeedback.setAttribute("role", "status");
  let downloading = false;
  let downloadAbort = null;
  cancelDownload.addEventListener("click", () => {
    downloadAbort?.abort();
    cancelDownload.disabled = true;
    downloadFeedback.textContent = "Download cancelled. Your working draft is unchanged.";
  });
  const reflectDownload = () => {
    downloadSource.disabled = downloading || committing || !activePath
      || (!sourceText.hidden && sourceText.disabled) || importGeneration !== null;
    downloadProject.disabled = downloading || committing || !workingFiles.length
      || (!sourceText.hidden && sourceText.disabled) || importGeneration !== null;
    downloadBackup.disabled = downloadProject.disabled;
    cancelDownload.hidden = !downloading;
    cancelDownload.disabled = downloadAbort?.signal.aborted ?? false;
    try {
      const estimateFiles = workingFiles.map(record => record.relativePath === activePath
        && !sourceText.hidden && !sourceText.disabled && sourceText.value !== activeTextBaseline
        ? {...record, blob: new Blob([(activeTextBom ? "\uFEFF" : "")
          + (activeLineEnding === "\r\n" ? sourceText.value.replace(/\n/g, "\r\n") : sourceText.value)])} : record);
      const plan = planPublicationSourceDownload(estimateFiles);
      const size = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
      downloadEstimate.textContent = `Source ZIP: ${plan.fileCount} files · ${size(plan.totalBytes)} source bytes · ${plan.fileReads} unloaded file reads (${size(plan.transferBytes)}). Current edits are included; linked data and map bytes are excluded. Encrypted storage reads may incur S3/KMS charges; actual charges are unknown. Complete input backup also reads its linked inputs, within the 16 MiB limit.`;
    } catch (error) {
      downloadEstimate.textContent = workingFiles.length ? error.message : "Open a source draft to estimate its export.";
      downloadProject.disabled = downloadBackup.disabled = true;
    }
  };
  sourceText.addEventListener("input", reflectDownload);
  const startSourceDownload = isCurrent => {
    const revisionId = sourceProject.currentRevisionId, revisionNumber = sourceProject.currentRevisionNumber;
    const organizationId = state.organization?.id;
    const controller = new AbortController();
    downloadAbort = controller;
    return {controller, reader: createPublicationSourceDownloadReader({adapter: draftAdapter,
      projectId: draftProjectId, sourceProjectId: draftSourceId,
      sourceRevisionId: openedRevisionBaseline?.reuseRevision?.id,
      isSavedFile: file => openedRevisionBaseline?.files.includes(file) ?? false,
      // Delivery configuration must explicitly assert both ticket API and S3 CORS.
      transport: state.publicationSourceDownloadTransport ?? "compatible-get", signal: controller.signal,
      isCurrent: () => isCurrent() && state.adapter === draftAdapter && state.project === draftProject
        && state.project.id === draftProjectId && state.session?.userId === draftUserId
        && state.organization?.id === organizationId && sourceProject.id === draftSourceId
        && sourceProject.currentRevisionId === revisionId && sourceProject.currentRevisionNumber === revisionNumber})};
  };
  downloadSource.disabled = true;
  downloadProject.disabled = true;
  downloadBackup.disabled = true;
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename;
    try {
      document.body.append(anchor); anchor.click();
    } finally {
      anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
  downloadSource.addEventListener("click", async () => {
    reflectDownload();
    if (downloadSource.disabled) return;
    saveActiveText();
    const path = activePath, generation = editorGeneration, tree = treeGeneration;
    const record = workingFiles.find(file => file.relativePath === path);
    if (!record) return;
    const current = () => fieldset.isConnected && !committing && generation === editorGeneration
      && tree === treeGeneration && path === activePath && workingFiles.includes(record);
    const {controller, reader} = startSourceDownload(current);
    downloading = true; reflectDownload();
    downloadFeedback.textContent = `Preparing ${path}…`;
    try {
      await reader.readFile(record);
      if (!current()) return;
      const blob = record.blob.type === record.contentType ? record.blob : new Blob([record.blob], {type: record.contentType});
      downloadBlob(blob, path.split("/").at(-1));
      const saved = openedRevisionBaseline?.files.includes(record);
      downloadFeedback.textContent = `Downloaded ${path} · ${saved ? `saved revision ${openedRevisionBaseline.revisionNumber}` : "current draft"}.`;
    } catch {
      if (current() && !controller.signal.aborted) downloadFeedback.textContent = `Could not download ${path}. Your source remains in place; retry Download source.`;
    } finally {
      downloading = false; downloadAbort = null;
      if (fieldset.isConnected) {
        if (controller.signal.aborted) downloadFeedback.textContent = "Download cancelled. Your working draft is unchanged.";
        else if (!current() && path === activePath) downloadFeedback.textContent = "The source selection changed. Choose Download source again for the current file.";
        reflectDownload();
      }
    }
  });
  const downloadWorkingProject = async (completeBackup = false) => {
    reflectDownload();
    if (downloadProject.disabled) return;
    saveActiveText();
    const records = [...workingFiles];
    const tree = treeGeneration, generation = editorGeneration, draftText = sourceText.value;
    const settings = () => ({projectId: state.project.id, sourceProjectId: sourceProject.id,
      siteId: sourceProject.siteId, routeNamespace: sourceProject.routeNamespace,
      title: title.control.value, entryPath: entry.control.value.trim(),
      lockfilePath: lockfile.control.value.trim() || null, rightsStatus: rights.control.value,
      changeSummary: summary.control.value, buildPolicy: sourceProject.buildPolicy});
    const metadata = settings(), signature = JSON.stringify(metadata);
    const bindings = dataAttachments.map(item => ({...item}));
    const baseRevision = openedRevisionBaseline?.reuseRevision ?? null;
    const current = () => fieldset.isConnected && !committing && tree === treeGeneration
      && generation === editorGeneration && draftText === sourceText.value
      && signature === JSON.stringify(settings()) && records.length === workingFiles.length
      && records.every((record, index) => record === workingFiles[index]);
    const {controller, reader} = startSourceDownload(current);
    downloading = true; reflectDownload();
    downloadFeedback.textContent = completeBackup
      ? "Preparing current source files and exact saved data and map inputs. This explicitly copies accessible dependency bytes; it does not save, build or publish."
      : "Preparing source project. Saved data and map references stay as references; their external contents are not copied.";
    try {
      if (referencedFiles.length) throw new TypeError("Project ZIP export for connected public files is not available yet. Download individual source files instead.");
      if (completeBackup) checkImportedMapDraft();
      normalizeObservableRevisionAttachments(bindings, records);
      planPublicationSourceDownload(records);
      await reader.assertCurrent();
      const bytes = record => record.blob?.size ?? record.sizeBytes ?? 0;
      const withinBounds = () => records.every(record => bytes(record) <= 4_194_304)
        && records.reduce((total, record) => total + bytes(record), 0) <= 16_777_216;
      if (!withinBounds()) throw new TypeError("Source export exceeds the existing file or tree limit");
      const {createPublicationSourceArchive, createPublicationSourceBackup} = await import("../lib/publicationSourceArchive.js");
      await reader.assertCurrent();
      const artifactReferences = typeof state.adapter.readPublicationArtifactReferences === "function"
        ? await reader.wait(state.adapter.readPublicationArtifactReferences(state.project.id, sourceProject.id)) : null;
      await reader.assertCurrent();
      for (const [index, record] of records.entries()) {
        downloadFeedback.textContent = `Preparing source file ${index + 1} of ${records.length}: ${record.relativePath}`;
        await reader.readFile(record);
        if (!withinBounds()) throw new TypeError("Source export exceeds the existing file or tree limit");
      }
      let dependencies;
      if (completeBackup) {
        const {readPublicationSourceBackupInputs} = await import("../lib/publicationSourceBackupInputs.js");
        await reader.assertCurrent();
        dependencies = await reader.wait(readPublicationSourceBackupInputs({adapter: state.adapter, projectId: state.project.id,
          sourceProjectId: sourceProject.id, files: records, dataAttachments: bindings, artifactReferences,
          entryPath: metadata.entryPath, signal: controller.signal,
          isCurrent: () => current() && !controller.signal.aborted,
          onProgress: message => {if (current() && !controller.signal.aborted) downloadFeedback.textContent = message;}}));
      }
      if (!current()) return;
      const {blob} = await (completeBackup ? createPublicationSourceBackup : createPublicationSourceArchive)({files: records, metadata,
        dataAttachments: bindings, artifactReferences, baseRevision, ...(completeBackup ? {dependencies} : {})});
      await reader.assertCurrent();
      const name = String(sourceProject.routeNamespace ?? "publication").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "publication";
      downloadBlob(blob, `${name}-${completeBackup ? "input-backup" : "source"}.zip`);
      downloadFeedback.textContent = completeBackup
        ? `Downloaded ${records.length} current source files and ${dependencies.length} frozen data/map inputs with provenance. Saved map selections are included; other unsaved panels, account history and permissions are excluded. Review this ZIP before restoring and saving. Publication rights still require review.`
        : `Downloaded ${records.length} source files with current edits and reference metadata. Reopen this ZIP under Import files or a project folder. External data and map contents, permissions and revision history are not included.`
        + (artifactReferences === null ? " Saved map reference metadata is unavailable in this workspace." : " Map references reflect their saved state; unsaved edits in other panels are not included.");
    } catch (error) {
      if (current() && !controller.signal.aborted) downloadFeedback.textContent = completeBackup
        ? `Could not make the complete input backup: ${error instanceof TypeError ? error.message : "a saved input could not be read"}. No partial archive was downloaded; your working files remain here.`
        : error instanceof TypeError ? error.message
          : "Could not download the source project. No partial archive was downloaded; your files remain here. Retry Download source project.";
    } finally {
      downloading = false; downloadAbort = null;
      if (fieldset.isConnected) {
        if (controller.signal.aborted) downloadFeedback.textContent = "Download cancelled. Your working draft is unchanged.";
        else if (!current()) downloadFeedback.textContent = completeBackup
          ? "The source project changed. Choose the download again for the current draft."
          : "The source project changed. Choose Download source project again for the current draft.";
        reflectDownload();
      }
    }
  };
  downloadProject.addEventListener("click", () => void downloadWorkingProject());
  downloadBackup.addEventListener("click", () => void downloadWorkingProject(true));
  const openWorkingFile = async (relativePath) => {
    if (committing) return;
    saveActiveText();
    activePath = relativePath;
    explorer.select(relativePath);
    breadcrumb.textContent = relativePath ?? "Select a file";
    const record = workingFiles.find((candidate) => candidate.relativePath === relativePath);
    const generation = ++editorGeneration;
    const openingTree = treeGeneration;
    activeTextBaseline = null;
    activeTextBom = false;
    activeLineEnding = "\n";
    sourceText.value = "";
    notebookReview.update();
    downloadFeedback.textContent = relativePath ? `Download ${relativePath} with its current edits.` : "Select a source file to download.";
    if (!record || !isTextFile(record)) {
      codeEditor.hide();
      sourceText.hidden = true;
      editorFeedback.hidden = false;
      editorFeedback.textContent = record
        ? `${record.relativePath} is an exact ${record.contentType} binary file and is not changed by this editor.`
        : "Select a source file to edit.";
      reflectDownload();
      return;
    }
    sourceText.hidden = false;
    sourceText.disabled = true;
    codeEditor.loading(relativePath);
    reflectDownload();
    editorFeedback.hidden = false;
    editorFeedback.textContent = `Opening ${record.relativePath}…`;
    let value, prefix;
    try {
      if (!record.blob) await savedFileLoader(record);
      value = await record.blob.text();
      prefix = new Uint8Array(await record.blob.slice(0, 3).arrayBuffer());
    } catch {
      if (generation === editorGeneration) editorFeedback.textContent = `Could not read ${relativePath}. Your other edits remain in place.`;
      return;
    }
    if (generation !== editorGeneration || openingTree !== treeGeneration) return;
    activeTextBom = prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
    activeLineEnding = value.includes("\r\n") && !/(?:^|[^\r])\n/.test(value) ? "\r\n" : "\n";
    sourceText.value = value;
    // Textarea display normalizes line endings; Blob.text() also strips a UTF-8
    // BOM. Retain the original Blob unless the displayed text actually changes.
    activeTextBaseline = sourceText.value;
    sourceText.disabled = false;
    reflectDownload();
    notebookReview.update();
    void codeEditor.open(relativePath, sourceText.value);
    editorFeedback.textContent = `Editing ${record.relativePath}. Draft changes do not update the public version.`;
  };
  const renderWorkingFiles = (records, label, {deferred = false} = {}) => {
    codeEditor.reset();
    attachmentReader.dispose(); attachmentReader = newAttachmentReader();
    workingFiles = deferred ? records : normalizeObservableSourceFiles(records);
    activePath = null;
    sourceSearch.value = "";
    sourceSearch.hidden = false;
    sourceFile.replaceChildren(...workingFiles.map(({relativePath}) => {
      const item = document.createElement("option");
      item.value = relativePath;
      item.textContent = relativePath;
      return item;
    }));
    sourceFile.hidden = true;
    explorer.update(workingFiles.map(file => file.relativePath));
    editorFeedback.hidden = false;
    const bytes = workingFiles.reduce((total, file) => total + (file.blob?.size ?? file.sizeBytes ?? 0), 0);
    selected.textContent = `${label} · ${workingFiles.length} source file${workingFiles.length === 1 ? "" : "s"} · ${bytes} bytes`;
    const first = workingFiles.find(file => file.relativePath === entry.control.value)
      ?? workingFiles.find(file => file.relativePath === "src/index.md") ?? workingFiles[0];
    void openWorkingFile(first?.relativePath ?? null);
    if (!deferred) markDraftChanged();
  };
  sourceSearch.addEventListener("input", () => {
    explorer.search(sourceSearch.value);
    const query = sourceSearch.value.trim().toLowerCase();
    for (const option of sourceFile.options) {
      option.hidden = !option.value.toLowerCase().includes(query);
    }
    // Filtering is navigation only: keep the active editor and its draft untouched.
    const matches = [...sourceFile.options].filter(option => !option.hidden).length;
    importReview.textContent = `${matches} matching source file${matches === 1 ? "" : "s"}. Select a file to open it.`;
  });
  const chooseBrowserFiles = async (fromDirectory) => {
    if (committing) return;
    const generation = ++treeGeneration;
    importGuidance.hidden = true;
    importGuidance.replaceChildren();
    try {
      checkImportedMapDraft();
      if (fromDirectory) files.value = "";
      else directory.value = "";
      let selection;
      if (dataAttachments.length) {
        const chosen = selectObservableBrowserFiles(files.files, directory.files);
        const bindings = dataAttachments.map(item => ({...item}));
        importGeneration = generation;
        reflectDownload();
        selected.textContent = "Checking selected files against their exact registered archives…";
        const inventory = await archiveEditor.readForImport();
        if (generation !== treeGeneration || committing) return;
        const reconciled = await reconcileFrameworkArchiveFiles(chosen.files, bindings, inventory);
        if (generation !== treeGeneration || committing) return;
        selection = {...chosen, ...reconciled};
      } else {
        importGeneration = null;
        selection = prepareObservableBrowserFiles(files.files, directory.files);
      }
      // Reference edits can begin while archive reconciliation is awaiting reads.
      // Recheck before replacing either draft, not only when selection starts.
      checkImportedMapDraft();
      renderWorkingFiles(
        selection.files,
        "Local source tree ready to edit"
      );
      archiveEditor.setImportedReferences([]);
      clearImportedMaps();
      importReview.textContent = selection.excludedCount
        ? `Excluded ${selection.excludedCount} generated or repository-control files from ${selection.excludedLocations.join(", ")}. Only the listed source files belong to this draft.`
        : "All selected files are included. Nothing has been uploaded.";
      if (selection.archivedFiles?.length) {
        const count = selection.archivedFiles.length;
        importReview.textContent += ` ${count} selected data ${count === 1 ? "file matches its exact registered archive" : "files match exact registered archives"} by size and SHA-256: ${selection.archivedFiles.map(file => file.relativePath).join(", ")}. These paths remain archive bindings and will not be uploaded as source.`;
      }
      const paths = selection.files.map(file => file.relativePath);
      if (paths.includes("src/index.md")) entry.control.value = "src/index.md";
      else if (paths.includes("index.md")) entry.control.value = "index.md";
      else if (paths.includes("index.html")) entry.control.value = "index.html";
      else if (paths.includes("src/index.html")) entry.control.value = "src/index.html";
      else if (paths.some(path => /\.ipynb$/i.test(path))) entry.control.value = paths.find(path => /(^|\/)index\.ipynb$/i.test(path)) ?? paths.find(path => /\.ipynb$/i.test(path));
      lockfile.control.value = paths.includes("package-lock.json") ? "package-lock.json" : "";
    } catch (error) {
      if (generation !== treeGeneration || committing) return;
      selected.textContent = `Source selection is invalid (${error?.message ?? "invalid_source_tree"}). The previous working tree has not been replaced.`;
      if (Array.isArray(error?.dataFiles)) {
        importGuidance.hidden = false;
        importGuidance.append(text("h4", "Preserve these data files before importing"));
        const list = document.createElement("ul");
        for (const file of error.dataFiles) list.append(text("li", `${file.relativePath} · ${file.blob.size.toLocaleString()} bytes`));
        const steps = document.createElement("ol");
        for (const instruction of [
          "Register each exact file as a dataset in this project's Data tab.",
          "Under Archived data references, select the dataset version and file.",
          "Under Archived files in this revision, assign the original path shown above.",
          "Select the complete Framework folder again. Studio will compare file sizes and SHA-256 values before accepting it."
        ]) steps.append(text("li", instruction));
        const data = text("a", "Open project Data", "platform-button secondary");
        data.href = projectHref(state.project.id, {adapterKind: state.adapter?.kind, management: "data"});
        importGuidance.append(list, steps, data, text("p", "Nothing was uploaded or omitted. Publication remains a separate action."));
      }
    } finally {
      if (importGeneration === generation) importGeneration = null;
      reflectDownload();
    }
  };
  files.addEventListener("change", () => chooseBrowserFiles(false));
  directory.addEventListener("change", () => chooseBrowserFiles(true));
  let archiveReadGeneration = 0, reviewedArchive = null;
  const archiveDraftSignature = () => JSON.stringify([treeGeneration, editorGeneration, activePath, sourceText.value,
    title.control.value, entry.control.value, lockfile.control.value, summary.control.value, rights.control.value]);
  const showSourceImport = (imported, current) => {
    const manifest = imported.manifest, metadata = manifest.metadata;
    const completeBackup = manifest.schemaVersion === "opengeo.publication-source-backup.1.0.0";
    const paths = imported.files.map(file => file.relativePath);
    const entryPaths = paths.filter(path => /\.(md|html?|ipynb)$/i.test(path));
    importedTitle.control.value = metadata.title ?? title.control.value;
    const entryOptions = entryPaths.map(path => {const option = text("option", path); option.value = path; return option;});
    importedEntry.control.replaceChildren(...entryOptions);
    importedEntry.control.value = [metadata.entryPath, entry.control.value, "src/index.md", "index.md", "index.html", "src/index.html"]
      .find(path => entryPaths.includes(path)) ?? entryPaths[0] ?? "";
    const noLock = text("option", "No lockfile"); noLock.value = "";
    importedLock.control.replaceChildren(noLock, ...paths.map(path => {const option = text("option", path); option.value = path; return option;}));
    importedLock.control.value = paths.includes(metadata.lockfilePath) ? metadata.lockfilePath
      : !Object.hasOwn(metadata, "lockfilePath") && paths.includes("package-lock.json") ? "package-lock.json" : "";
    const context = document.createElement("details");
    context.append(text("summary", "Original settings and external reference details"),
      text("pre", JSON.stringify({metadata, baseRevision: manifest.baseRevision,
        dataAttachments: manifest.dataAttachments, artifactReferences: manifest.artifactReferences,
        ...(completeBackup ? {dependencies: manifest.dependencies} : {})}, null, 2)));
    archiveReview.append(text("h4", "Review source project import"),
      text("p", `${imported.files.length} verified source files. Review the title and entry below. Missing original paths need a replacement from the imported files.`),
      importedTitle.label, importedEntry.label, importedLock.label,
      text("p", "Use imported source replaces the working draft with these reviewed files and settings. Download your current draft first if you need to keep it."),
      text("p", completeBackup
        ? "This backup includes verified local copies of its declared data and compiled map output, with original details in a provenance file. Original identity, rights and build policy grant no authority. Rights start as Not reviewed. Restore replaces matching data bindings with these local files in the working draft; remove conflicting saved map references before restoring. Publishing remains separate."
        : "Original identity, rights, build settings and external references are review information. Imported rights start as Not reviewed. Data and map contents are not bundled or rebound; existing destination references stay unchanged. Review them before saving or publishing."),
      context);
    if (imported.conversionReport) {
      const conversion = imported.conversionReport;
      const details = document.createElement("section"), list = document.createElement("ul");
      for (const item of [...(conversion.losses ?? []), ...(conversion.manualWork ?? []), ...(conversion.limitations ?? []), ...(conversion.limits ?? [])]) {
        list.append(text("li", item));
      }
      for (const item of conversion.unsupported ?? []) list.append(text("li", `Cell ${item.cellId}: ${item.message}`));
      for (const item of conversion.libraryRequests ?? []) list.append(text("li", item.message
        ?? `${item.name}: ${item.bundled ? `bundled version ${item.resolvedVersion}` : "requires manual library review"}`));
      if (conversion.libraryRequestsTruncated) list.append(text("li", "Library requests show the first 100 findings. Review the retained original for additional requests."));
      for (const item of conversion.childFindings ?? []) list.append(text("li", `Imported notebook ${item.modulePath}: ${item.message ?? item.name ?? "Review required"}${item.value ? ` ${item.value}` : ""}`));
      details.append(text("h4", "Conversion review"),
        text("p", `${conversion.convertedCells} cells converted; ${conversion.attachments.length} local attachments retained. The exact original export and this report are included in the source tree.`), list);
      if (conversion.retainedModules?.length) details.append(text("p", `${conversion.retainedModules.length} imported notebooks included. Their original files are retained; unused cells stay inactive until needed.`));
      if (conversion.retainedNotices?.length) details.append(text("p", `Retained license and attribution notices: ${conversion.retainedNotices.map(item => item.path).join(", ")}. Review their scope before publishing; source rights remain Not reviewed.`));
      if (conversion.unusedSelectedFiles.length) details.append(text("p", `Selected files not copied: ${conversion.unusedSelectedFiles.join(", ")}. Your originals remain on disk.`));
      archiveReview.prepend(details);
    }
    archiveReview.hidden = false; reviewedArchive = {...imported, current}; applyArchive.disabled = false;
  };
  const invalidateLegacySelection = () => {
    ++archiveReadGeneration; reviewedArchive = null; applyArchive.disabled = true; archiveReview.hidden = true;
    legacyReview.disabled = !legacyFile.files?.length || committing || revisionCommitted;
  };
  legacyFile.addEventListener("change", invalidateLegacySelection);
  legacyFolder.addEventListener("change", invalidateLegacySelection);
  legacyReview.addEventListener("click", async () => {
    if (committing || revisionCommitted || importGeneration !== null || !legacyFile.files?.[0]) return;
    const request = ++archiveReadGeneration, signature = archiveDraftSignature(), file = legacyFile.files[0];
    const attachments = Array.from(legacyFolder.files ?? [], blob => ({blob,
      relativePath: blob.webkitRelativePath ? blob.webkitRelativePath.split('/').slice(1).join('/') : blob.name}));
    const current = () => fieldset.isConnected && request === archiveReadGeneration && !committing
      && !revisionCommitted && importGeneration === null && signature === archiveDraftSignature();
    reviewedArchive = null; applyArchive.disabled = true; archiveReview.hidden = true; archiveReview.replaceChildren();
    legacyReview.disabled = true;
    archiveFeedback.textContent = "Parsing the Observable export and preserving its original files. Your current draft is unchanged.";
    try {
      const {prepareLegacyNotebookImport} = await import("../lib/legacyNotebookImport.js");
      if (!current()) return;
      const imported = await prepareLegacyNotebookImport({file, attachments, convert: legacyConverter});
      if (!current()) return;
      showSourceImport(imported, current);
      archiveFeedback.textContent = "Review the conversion losses and source settings before using the converted Notebook. No source module was run or saved.";
    } catch (error) {
      if (current()) archiveFeedback.textContent = `Observable conversion was not applied: ${error?.message ?? "unsupported export"}. Your originals and working draft remain unchanged.`;
    } finally {
      if (fieldset.isConnected && request === archiveReadGeneration) {
        legacyReview.disabled = committing || revisionCommitted || !legacyFile.files?.length;
        if (!current()) archiveFeedback.textContent = "The draft or selection changed during conversion. Review the Observable export again before replacing the current draft.";
      }
    }
  });
  sourceArchive.addEventListener("change", async () => {
    if (committing || revisionCommitted || importGeneration !== null) return;
    const request = ++archiveReadGeneration, signature = archiveDraftSignature();
    legacyReview.disabled = !legacyFile.files?.length;
    const blob = sourceArchive.files?.[0];
    reviewedArchive = null; applyArchive.disabled = true; archiveReview.hidden = true; archiveReview.replaceChildren();
    if (!blob) return;
    const current = () => fieldset.isConnected && request === archiveReadGeneration && !committing
      && !revisionCommitted && importGeneration === null && signature === archiveDraftSignature();
    archiveFeedback.textContent = "Verifying the complete source project. Your current draft is unchanged.";
    try {
      const {readPublicationSourceArchive} = await import("../lib/publicationSourceArchive.js");
      if (!current()) return;
      const imported = await readPublicationSourceArchive(blob);
      if (imported.manifest.metadata?.schemaVersion === "opengeo.publication-source-history.1.0.0") {
        throw new TypeError("Use Version history in Files to restore every revision from this ZIP.");
      }
      if (!current()) return;
      showSourceImport(imported, current);
      archiveFeedback.textContent = "All source checksums match. Package consistency does not establish trusted provenance or permission to publish.";
    } catch (error) {
      if (current()) archiveFeedback.textContent = `Could not open this source project: ${error?.message ?? "invalid source archive"}. Your current draft is unchanged.`;
    } finally {
      if (fieldset.isConnected && request === archiveReadGeneration && !current()) {
        reviewedArchive = null; applyArchive.disabled = true; archiveReview.hidden = true;
        archiveFeedback.textContent = "The draft or selection changed during verification. Choose the source ZIP again to review it against the current draft.";
      }
    }
  });
  applyArchive.addEventListener("click", async () => {
    const reviewed = reviewedArchive;
    if (!reviewed || applyArchive.disabled) return;
    if (!reviewed.current()) {
      reviewedArchive = null; applyArchive.disabled = true;
      archiveFeedback.textContent = "The draft changed after review. Review the selected import again before replacing it.";
      return;
    }
    const completeBackup = reviewed.manifest.schemaVersion === "opengeo.publication-source-backup.1.0.0";
    applyArchive.disabled = true;
    try {
      checkImportedMapDraft();
      const records = reviewed.files;
      const paths = records.map(file => file.relativePath);
      const titleValue = importedTitle.control.value.trim(), entryPath = importedEntry.control.value;
      const lockPath = importedLock.control.value || null;
      if (!titleValue || titleValue.length > 300) throw new TypeError("Enter a title for the imported source revision");
      if (!entryPath || !paths.includes(entryPath)) throw new TypeError("The archive does not identify a source entry. Extract its source folder and choose the entry through the file editor");
      if (lockPath !== null && !paths.includes(lockPath)) throw new TypeError("Choose a lockfile from the imported source files");
      if (completeBackup) {
        archiveEditor.assertReady();
        if (typeof state.adapter.readPublicationArtifactReferences !== "function") {
          throw new TypeError("Saved destination map references are unavailable; restore cannot check for conflicting paths");
        }
        const destination = await state.adapter.readPublicationArtifactReferences(state.project.id, sourceProject.id);
        if (!reviewed.current()) throw new TypeError("The draft changed while checking destination references; review the ZIP again");
        if (titleValue !== importedTitle.control.value.trim() || entryPath !== importedEntry.control.value
          || lockPath !== (importedLock.control.value || null)) throw new TypeError("Import settings changed during restore; review them and restore again");
        checkImportedMapDraft();
        const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        if (destination.references.some(reference => paths.some(path => overlaps(path.toLowerCase(), reference.path.toLowerCase())))) {
          throw new TypeError("Remove conflicting saved map references using the map reference controls and save them before restoring this backup");
        }
      }
      const copiedDataPaths = new Set(completeBackup ? reviewed.manifest.dependencies.filter(item => item.kind === "data").map(item => item.relativePath.toLowerCase()) : []);
      const bindings = normalizeObservableRevisionAttachments(dataAttachments.filter(item => !copiedDataPaths.has(item.relativePath.toLowerCase())), records);
      validateStaticPublicationTree(entryPath, lockPath, records, bindings);
      validateJupyterPublicationTree(entryPath, lockPath, records, bindings);
      ++treeGeneration; ++archiveReadGeneration;
      files.value = ""; directory.value = "";
      importGuidance.hidden = true; importGuidance.replaceChildren();
      title.control.value = titleValue;
      entry.control.value = entryPath; lockfile.control.value = lockPath ?? "";
      rights.control.value = "unreviewed";
      summary.control.value = "Import source project; review external references";
      if (completeBackup) {
        dataAttachments = bindings; showBindings(); archiveEditor.reset();
        summary.control.value = "Restore selected input backup; review dependency rights";
      }
      renderWorkingFiles(records, "Imported source project ready to edit");
      archiveEditor.setImportedReferences(completeBackup ? [] : reviewed.manifest.dataAttachments);
      clearImportedMaps();
      if (!completeBackup && reviewed.manifest.artifactReferences) {
        importedMapEditor = PublicationArtifactReferences({adapter: state.adapter, projectId: state.project.id,
          sourceProjectId: sourceProject.id, canManage: canManage(state), importedSource: {
            references: reviewed.manifest.artifactReferences.references,
            getLayout: () => ({entryPath: entry.control.value.trim(), files: [...workingFiles, ...dataAttachments]})
          }});
        importedMapReview.append(importedMapEditor);
        importedMapReview.hidden = false;
      }
      importReview.textContent = completeBackup
        ? "Verified source, data, compiled map output and provenance are in the working draft. Review all dependency rights before saving or publishing; original references have not been rebound."
        : "All verified source files are in the working draft. Reconnect imported data paths under Archived files in this revision, and review map references and publication rights before saving.";
      reviewedArchive = null; applyArchive.disabled = true;
      archiveFeedback.textContent = "Source files and authoring settings imported into the working draft. Original reference details remain below for review; no permissions, external bindings, saved revision or publication changed.";
      reflectDownload();
    } catch (error) {
      archiveFeedback.textContent = `Source import was not applied: ${error?.message ?? "invalid source tree"}. The previous draft and its references remain here.`;
    } finally {
      if (reviewedArchive === reviewed) applyArchive.disabled = !reviewed.current();
    }
  });
  sourceFile.addEventListener("change", () => void openWorkingFile(sourceFile.value));
  const newPage = document.createElement("details");
  newPage.className = "framework-new-page";
  newPage.hidden = true;
  newPage.append(text("summary", "New page"));
  const pagePath = labeledInput("New page source path", "src/field-labs/new-page.md", 512);
  const pageTitle = labeledInput("New page title", "New field lab", 300);
  const addPage = button("Add page to working revision", "platform-button secondary");
  const pageFeedback = text("p", "Open a saved revision or choose the complete project folder first. Adding a page does not save or publish it; update the project's navigation before previewing.", "project-resource-feedback");
  pageFeedback.setAttribute("role", "status");
  newPage.append(pagePath.label, pageTitle.label, addPage, pageFeedback);
  const openNewPage = (folder = explorer.folder ?? publicationSourceRoot(entry.control.value, workingFiles.map(file => file.relativePath))) => {
    if (committing || revisionCommitted || importGeneration !== null) return;
    sidebar.hidden = false; layout.classList.remove('source-editor-explorer-hidden');
    const extension = entry.control.value.endsWith('.ipynb') ? 'ipynb' : entry.control.value.endsWith('.html') ? 'html' : 'md';
    const prefix = folder && !folder.endsWith('/') ? folder + '/' : folder;
    const occupied = new Set([...workingFiles, ...dataAttachments, ...referencedFiles].map(file => file.relativePath.toLowerCase()));
    let path = `${prefix}new-page.${extension}`, suffix = 2;
    while (occupied.has(path.toLowerCase())) path = `${prefix}new-page-${suffix++}.${extension}`;
    pagePath.control.value = path; pageTitle.control.value = 'New page';
    newPage.hidden = false; newPage.open = true; pagePath.control.focus(); pagePath.control.select();
  };
  addPage.addEventListener("click", async () => {
    if (committing || revisionCommitted) return;
    try {
      if (!sourceText.hidden && sourceText.disabled) throw new TypeError("Wait for the current file to finish opening");
      if (importGeneration !== null) throw new TypeError("Wait for the folder import to finish");
      saveActiveText();
      const generation = treeGeneration;
      addPage.disabled = true;
      for (const file of workingFiles) if (!file.blob) await savedFileLoader(file);
      if (generation !== treeGeneration) throw new TypeError("The working tree changed; retry adding the page");
      const home = workingFiles.find(file => file.relativePath === entry.control.value);
      const pageFormat = entry.control.value.endsWith('.ipynb') ? 'jupyter' : entry.control.value.endsWith('.html')
        ? (await home?.blob.text())?.includes('<notebook>') ? 'notebook' : 'html' : 'framework';
      if (generation !== treeGeneration) throw new TypeError('The working tree changed; retry adding the page');
      const records = appendPublicationPage(workingFiles, {
        relativePath: pagePath.control.value, title: pageTitle.control.value, dataAttachments, referencedFiles,
        format: pageFormat
      });
      ++treeGeneration;
      renderWorkingFiles(records, "Page added to working revision");
      sourceFile.value = pagePath.control.value.trim();
      void openWorkingFile(sourceFile.value);
      pageFeedback.textContent = `Added ${sourceFile.value}. Edit its content and navigation, then review it before publishing.`;
    } catch (error) {
      pageFeedback.textContent = `Page not added: ${error.message}. Existing files remain in place.`;
    } finally {
      addPage.disabled = committing || revisionCommitted;
    }
  });
  const reopen = button("Reload saved draft", "platform-button secondary");
  reopen.disabled = sourceProject.currentRevisionId === null
    || typeof state.adapter.readObservableSourceRevisionFile !== "function";
  reopen.addEventListener("click", async () => {
    if (committing || !draftEditorCurrent()) return;
    clearAutosave();
    const generation = ++treeGeneration;
    reopen.disabled = true;
    selected.textContent = "Opening saved draft…";
    draftStatus.textContent = 'Opening saved draft…';
    try {
      checkImportedMapDraft();
      const revisions = await draftAdapter.listObservableSourceRevisions(
        draftProjectId,
        draftSourceId
      );
      if (generation !== treeGeneration || !draftEditorCurrent()) return;
      const revision = revisions.find(({id}) => id === sourceProject.currentRevisionId);
      if (!revision) throw new TypeError("current source revision is unavailable");
      if (generation !== treeGeneration) return;
      // List the full tree immediately; read object bytes only when selected.
      // Save can retain exact unread parent files when the API advertises reuse.
      const records = revision.files.map(file => ({...file, blob: null}));
      const reads = new Map();
      const readSavedFile = record => {
        if (!draftEditorCurrent()) return Promise.reject(Error('The publication account or editor changed'));
        if (record.blob) return Promise.resolve(record.blob);
        if (!reads.has(record.relativePath)) reads.set(record.relativePath,
          draftAdapter.readObservableSourceRevisionFile(draftProjectId, draftSourceId, revision.id, record.relativePath)
            .then(loaded => {
              if (!draftEditorCurrent()) throw Error('The publication account or editor changed');
              record.blob = loaded.blob; return loaded.blob;
            })
            .catch(error => { reads.delete(record.relativePath); throw error; }));
        return reads.get(record.relativePath);
      };
      // Reopening must not erase an existing draft while the entry is still
      // loading. Only the selected entry is fetched; other files remain lazy.
      if (workingFiles.length) {
        const home = records.find(file => file.relativePath === revision.entryPath);
        if (!home) throw new TypeError("saved entry file is missing");
        await readSavedFile(home);
        if (generation !== treeGeneration || !draftEditorCurrent()) return;
      }
      // The reference editor remains available while saved source reads finish.
      // Preserve edits or actions started during those reads before clearing it.
      checkImportedMapDraft();
      savedFileLoader = readSavedFile;
      dataAttachments = normalizeObservableRevisionAttachments(revision.dataAttachments ?? [], records);
      referencedFiles = normalizeObservableRevisionReferencedFiles(revision.referencedFiles ?? [], [...records, ...dataAttachments]);
      entry.control.value = revision.entryPath;
      archiveEditor.reset();
      clearImportedMaps();
      title.control.value = revision.title;
      entry.control.value = revision.entryPath;
      showBindings();
      lockfile.control.value = revision.lockfilePath ?? "";
      summary.control.value = `Update draft ${revision.revisionNumber}`;
      rights.control.value = revision.rightsStatus ?? sourceProject.rightsStatus ?? "unreviewed";
      openedRevisionBaseline = {
        reuseRevision: revision,
        revisionNumber: revision.revisionNumber,
        title: revision.title,
        rightsStatus: revision.rightsStatus ?? sourceProject.rightsStatus,
        entryPath: revision.entryPath,
        lockfilePath: revision.lockfilePath,
        files: [...records],
        dataAttachments: dataAttachments.map(item => ({...item})),
        referencedFiles: referencedFiles.map(item => ({...item}))
      };
      renderWorkingFiles(records, `Saved revision ${revision.revisionNumber} opened`, {deferred: true});
      draftDirty = false; autosavePaused = false;
      draftStatus.textContent = `Draft saved · version ${revision.revisionNumber}`;
    } catch (error) {
      if (generation !== treeGeneration || !draftEditorCurrent()) return;
      selected.textContent = `The saved revision could not be opened (${error?.code ?? error?.message ?? "source_read_unavailable"}). You can still upload a complete local source tree.`;
      draftStatus.textContent = 'Saved draft unavailable';
      reopen.disabled = false;
    } finally {
      if (draftEditorCurrent()) reopen.disabled = committing || revisionCommitted;
    }
  });
  const submit = button("Save draft");
  const feedback = text(
    "p",
    "",
    "project-resource-feedback"
  );
  async function saveDraft(automatic = false) {
    if (committing) return;
    clearAutosave();
    if (automatic && (!draftDirty || autosavePaused || !fieldset.isConnected)) return;
    committing = true;
    submit.disabled = true;
    let restoreControls = () => { submit.disabled = false; };
    let savedGeneration = treeGeneration;
    try {
      if (revisionCommitted) {
        feedback.textContent = "Reloading the saved draft…";
        await refresh();
        return;
      }
      if (!sourceText.hidden && sourceText.disabled) throw new TypeError("wait for the selected source file to finish loading");
      checkImportedMapDraft(true);
      if (importGeneration === treeGeneration) throw new TypeError("wait for the selected folder's archive checks to finish");
      saveActiveText();
      if (!workingFiles.length) throw new TypeError("select or reopen a non-empty source tree");
      const expectedRevision = sourceProject.currentRevisionNumber;
      const contextResult = canAutosave ? await draftContext : {context: null};
      if (contextResult.error) throw contextResult.error;
      const assertCurrent = () => {
        if (!fieldset.isConnected || state.adapter !== draftAdapter || state.project !== draftProject
          || state.session?.userId !== draftUserId || !canManage(state)
          || state.project.id !== draftProjectId || sourceProject.id !== draftSourceId
          || sourceProject.currentRevisionNumber !== expectedRevision) {
          throw Error('The draft session, edit access or version changed. Reopen the saved draft before continuing.');
        }
      };
      assertCurrent();
      saveActiveText();
      const reusable = openedRevisionBaseline?.reuseRevision?.supportsFileReuse === true
        && openedRevisionBaseline.reuseRevision.sourceProjectId === sourceProject.id
        && openedRevisionBaseline.revisionNumber === expectedRevision;
      const size = workingFiles.reduce((total, file) => total + (file.blob?.size ?? file.sizeBytes ?? 0), 0);
      if (automatic && !reusable && size > 128 * 1024) {
        draftStatus.textContent = 'Unsaved changes · Save draft required';
        feedback.textContent = 'This server cannot reuse unchanged files in this folder. Autosave is limited to 128 KiB; use Save draft to upload this folder deliberately.';
        return;
      }
      // Snapshot before asynchronous reads. Typing may continue during autosave;
      // that text belongs to the next save, never this revision's source tree.
      savedGeneration = ++treeGeneration;
      const snapshotFiles = workingFiles.map(file => ({...file}));
      const draft = {expectedRevision, title: title.control.value, rightsStatus: rights.control.value,
        entryPath: entry.control.value.trim(), lockfilePath: lockfile.control.value.trim() || null,
        changeSummary: summary.control.value, reuseRevision: openedRevisionBaseline?.reuseRevision,
        dataAttachments: dataAttachments.map(item => ({...item})),
        referencedFiles: referencedFiles.map(item => ({...item}))};
      const reuseContext = {sourceProjectId: sourceProject.id, expectedRevision, reuseRevision: draft.reuseRevision};
      const controls = [...fieldset.querySelectorAll("input, select, textarea, button")];
      const disabled = controls.map(control => control === submit ? false : control.disabled);
      restoreControls = () => controls.forEach((control, index) => { control.disabled = disabled[index]; });
      for (const control of controls) if (!automatic || control !== sourceText) control.disabled = true;
      draftStatus.textContent = 'Saving draft…';
      for (const file of snapshotFiles) {
        if (!file.blob && (!canReuseDeferredObservableSourceFile(file, reuseContext)
          || /(^|\/)opengeo\.publication\.json$/.test(file.relativePath))) {
          file.blob = await savedFileLoader(file);
          assertCurrent();
        }
      }
      for (const file of openedRevisionBaseline?.files ?? []) {
        if (!file.blob && !canReuseDeferredObservableSourceFile(file, reuseContext)) file.blob = await savedFileLoader(file);
        assertCurrent();
      }
      draft.files = normalizeObservableSourceFiles(snapshotFiles, reuseContext);
      archiveEditor.assertReady();
      let bindings = normalizeObservableRevisionAttachments(draft.dataAttachments, [...draft.files, ...draft.referencedFiles]);
      const references = normalizeObservableRevisionReferencedFiles(draft.referencedFiles, [...draft.files, ...bindings]);
      validateStaticPublicationTree(draft.entryPath, draft.lockfilePath, draft.files, [...bindings, ...references]);
      validateJupyterPublicationTree(draft.entryPath, draft.lockfilePath, draft.files, [...bindings, ...references]);
      if (openedRevisionBaseline) {
        const changes = await sourceRevisionChanges(openedRevisionBaseline, {...draft, dataAttachments: bindings, referencedFiles: references}, reuseContext);
        assertCurrent();
        if (changes.unchanged) {
          feedback.textContent = `No changes from opened revision ${openedRevisionBaseline.revisionNumber}. Nothing uploaded; no new revision or build requested.`;
          draftDirty = treeGeneration !== savedGeneration;
          draftStatus.textContent = draftDirty ? 'Unsaved changes' : `Draft saved · version ${expectedRevision}`;
          restoreControls();
          return;
        }
      }
      if (bindings.length || references.length && typeof draftAdapter.listObservablePublicFileReferences === 'function') {
        feedback.textContent = "Checking current file access, paths and data size before saving source…";
        bindings = await archiveEditor.prepareCommit(bindings, references);
        assertCurrent();
      }
      feedback.textContent = "Saving draft. The public version stays unchanged.";
      const revision = await draftAdapter.saveObservableSourceRevision(
        draftProjectId,
        draftSourceId,
        {...draft, dataAttachments: bindings, referencedFiles: references},
        {context: contextResult.context, assertCurrent}
      );
      assertCurrent();
      if (automatic) {
        if (!revision?.id || revision.revisionNumber !== expectedRevision + 1
          || revision.sourceProjectId !== sourceProject.id || !Array.isArray(revision.files)) {
          throw Error('The saved draft version could not be verified');
        }
        sourceProject.currentRevisionId = revision.id;
        sourceProject.currentRevisionNumber = revision.revisionNumber;
        sourceProject.rightsStatus = revision.rightsStatus;
        const blobs = new Map(draft.files.map(file => [file.relativePath, file.blob]));
        openedRevisionBaseline = {revisionNumber: revision.revisionNumber,
          title: draft.title, rightsStatus: draft.rightsStatus, entryPath: draft.entryPath,
          lockfilePath: draft.lockfilePath, files: revision.files.map(file => ({...file, blob: blobs.get(file.relativePath)})),
          dataAttachments: bindings.map(item => ({...item})),
          referencedFiles: references.map(item => ({...item})),
          reuseRevision: {...revision, supportsFileReuse: revision.supportsFileReuse ?? reusable}};
        draftDirty = treeGeneration !== savedGeneration;
        draftStatus.textContent = draftDirty ? 'Unsaved changes' : `Draft saved · version ${revision.revisionNumber}`;
        feedback.textContent = references.length
          ? 'Draft saved. Live preview follows your edits; the published version stays unchanged.'
          : 'Draft saved. Review Preview, then Publish when ready.';
        fieldset.dispatchEvent(new fieldset.ownerDocument.defaultView.Event('opengeo-publication-draft-saved', {bubbles: true}));
        restoreControls();
        return;
      }
      revisionCommitted = true;
      draftStatus.textContent = 'Draft saved';
      feedback.textContent = "Draft saved. Reloading version history…";
      await refresh();
    } catch (error) {
      if (revisionCommitted) {
        feedback.textContent = "The draft was saved, but the workspace could not be reloaded. Reload the saved draft; no further upload is needed.";
        submit.textContent = "Reload saved revision";
        submit.disabled = false;
      } else {
        autosavePaused = true;
        draftStatus.textContent = 'Autosave paused · changes remain in this editor';
        feedback.textContent = `Could not confirm the source revision (${error?.code ?? error?.message ?? "invalid_source_revision"}). Your working files remain here. Check the saved revision before retrying after a connection error.`;
        restoreControls();
      }
    } finally {
      committing = false;
      archiveEditor.resume();
      reflectDownload();
      if (automatic && draftDirty && !autosavePaused && draftStatus.textContent !== 'Unsaved changes · Save draft required') scheduleAutosave();
    }
  }
  submit.addEventListener("click", () => { void saveDraft(); });
  const toolbar = document.createElement("div"); toolbar.className = "source-editor-toolbar";
  toolbar.append(submit, reopen, draftStatus);
  const mapInsert = document.createElement("details"); mapInsert.className = "publication-map-insert";
  fieldset.insertPublicRelease = async ({url,title,pagePath}) => {
    if (committing || revisionCommitted || importGeneration !== null) throw Error('Wait for the revision operation to finish');
    if (!workingFiles.some(file=>file.relativePath===pagePath)) throw Error('Open the saved revision and choose an existing page');
    if (activePath !== pagePath) await openWorkingFile(pagePath);
    if (committing || revisionCommitted || activePath !== pagePath || sourceText.hidden || sourceText.disabled) {
      throw Error('Wait for the selected page to finish opening');
    }
    const result=insertPublicArtifact({path:activePath,source:sourceText.value,url,title});
    codeEditor.insert(result.snippet,result.insertOffset);
    feedback.textContent='Public map linked in this draft. Its existing release is referenced; the map is not copied or rebuilt.';
  };
  const chooseMap = button("Choose Studio map", "platform-button secondary");
  chooseMap.disabled = typeof state.adapter.listMaps !== "function";
  const mapFile = document.createElement("input"); mapFile.type = "file"; mapFile.accept = ".html,text/html"; mapFile.ariaLabel = "Studio map HTML export";
  const mapManifest = document.createElement("input"); mapManifest.type = "file"; mapManifest.accept = ".json,application/json"; mapManifest.ariaLabel = "Optional Artifact manifest";
  const mapManifestLabel = document.createElement("label"); mapManifestLabel.append("Artifact manifest (optional)", mapManifest);
  const mapConsent = labeledCheckbox("I may publish the data and attribution included in this map", false);
  const insertMap = button("Insert exported map", "platform-button secondary"); insertMap.disabled = true;
  const mapNote = text("p", "In Studio's map viewer, export interactive HTML, then select that file here. Its runtime, included data and attribution stay with the publication. This does not publish the map.", "project-resource-feedback");
  const updateMapInsert = () => {insertMap.disabled = !mapConsent.control.checked || !mapFile.files?.length || committing || revisionCommitted;};
  const addMapToDraft = async ({blob, name, manifest = null, manifestBlob = null}) => {
    if (committing || revisionCommitted) throw Error("Wait for the saved revision to reopen before inserting a map.");
    const destination = {path: activePath, generation: treeGeneration, source: sourceText.value};
    if (manifestBlob !== null) manifest = await readPortableMapManifest(manifestBlob);
    if (manifestBlob !== null || manifest !== null) await verifyPortableMapArtifact(blob, manifest);
    if (!fieldset.isConnected || activePath !== destination.path || treeGeneration !== destination.generation || sourceText.value !== destination.source) {
      throw Error("The article draft changed while verifying the map. Choose the destination page again.");
    }
    if (committing || revisionCommitted) throw Error("Wait for the saved revision to reopen before inserting a map.");
    const result = publicationMapInsert({entryPath: activePath, name, blob, manifest, source: sourceText.value,
      parser: new sourceText.ownerDocument.defaultView.DOMParser(),
      existingPaths: [...workingFiles, ...dataAttachments, ...referencedFiles].map(file => file.relativePath)});
    if (workingFiles.length + dataAttachments.length + referencedFiles.length + result.files.length > 128) throw Error("The source tree would exceed 128 files");
    codeEditor.insert(result.snippet, result.insertOffset);
    workingFiles.push(...result.files); ++treeGeneration;
    explorer.update(workingFiles.map(file => file.relativePath)); explorer.select(activePath);
    mapNote.textContent = `Map added to ${activePath}. Preview shows the current draft; Save draft keeps it in your account.`;
    feedback.textContent = mapNote.textContent;
  };
  chooseMap.onclick = () => {
    if (committing || revisionCommitted) return;
    if (!/\.(md|html)$/i.test(activePath)) {feedback.textContent = 'Open a Markdown or HTML page to insert a map.'; return;}
    const originalGeneration = treeGeneration, originalPath = activePath;
    openPublicationMapPicker({adapter: state.adapter, projects: [...(state.projects ?? []), state.project],
      currentProjectId: state.project.id, onInsert: (file) => {
        if (!fieldset.isConnected || treeGeneration !== originalGeneration || activePath !== originalPath) throw Error("The article draft changed. Close the map picker and choose the destination page again.");
        return addMapToDraft(file);
      }});
  };
  mapFile.addEventListener("change", updateMapInsert); mapConsent.control.addEventListener("change", updateMapInsert);
  insertMap.addEventListener("click", async () => {
    if (insertMap.disabled) return;
    try {
      const blob = mapFile.files[0];
      await addMapToDraft({blob, name: blob.name, manifestBlob: mapManifest.files?.[0] ?? null});
      mapConsent.control.checked = false; updateMapInsert();
    } catch (error) {mapNote.textContent = error.message;}
  });
  mapInsert.append(text("summary", "Insert map…"), chooseMap, mapNote, mapFile, mapManifestLabel, mapConsent.label, insertMap);
  const insertButton = button('Insert map…', 'platform-button secondary');
  insertButton.onclick = () => {
    if (!chooseMap.disabled) chooseMap.click();
    else {mapInsert.hidden = false; mapInsert.open = true; mapFile.focus();}
  };
  mapInsert.hidden = true;
  toolbar.append(insertButton);
  const insertDataButton = button('Insert data…', 'platform-button secondary');
  insertDataButton.onclick = () => {
    archiveEditor.element.parentElement?.closest('details')?.setAttribute('open', '');
    archiveEditor.element.open = true;
    archiveEditor.element.scrollIntoView({block: 'nearest'});
  };
  toolbar.append(insertDataButton);
  const exportedMapButton = button('Import map HTML…', 'platform-button secondary');
  exportedMapButton.onclick = () => {mapInsert.hidden = false; mapInsert.open = true; mapFile.focus();};
  const importing = document.createElement("details");
  importing.append(text("summary", "Import files or a project folder"), exportedMapButton, fileLabel, directoryLabel, importReview, importGuidance,
    sourceArchiveLabel, legacyImport, archiveFeedback, archiveReview, applyArchive);
  const properties = document.createElement("details");
  properties.append(text("summary", "Draft settings and data references"), title.label, entry.label,
    lockfile.label, summary.label, rights.label, rightsNote, boundData, archiveEditor.element, importedMapReview);
  const fileTray = document.createElement("details"); fileTray.className = "source-editor-file-tray";
  const downloads = document.createElement("div"); downloads.className = "source-editor-downloads";
  downloads.append(text("h4", "Export and backup"), downloadEstimate, downloadSource, downloadProject, downloadBackup, cancelDownload, downloadFeedback);
  let sourceHistory = null;
  if (typeof state.adapter.listObservableSourceRevisions === "function"
    && typeof state.adapter.saveObservableSourceRevision === "function") {
    sourceHistory = PublicationSourceHistory({adapter: state.adapter, projectId: state.project.id, sourceProject,
      isCurrent: () => fieldset.isConnected && !committing && !revisionCommitted && importGeneration === null
        && (sourceProject.currentRevisionNumber > 0 || workingFiles.length === 0), onRestored: () => refresh()});
    downloads.append(sourceHistory);
  }
  fileTray.append(text("summary", "Files"), importing, downloads);
  const trays = document.createElement("div"); trays.className = "source-editor-trays";
  trays.append(fileTray, properties);
  const layout = document.createElement("div"); layout.className = "source-editor-layout";
  const sidebar = document.createElement("aside"); sidebar.append(sourceSearch, explorer.element, newPage);
  sidebar.className = 'source-editor-explorer';
  const explorerHeading = document.createElement('header'); explorerHeading.append(text('strong', 'Explorer'));
  const createPage = button('+', 'platform-button secondary'); createPage.ariaLabel = 'New page in selected folder';
  createPage.onclick = () => openNewPage(); explorerHeading.append(createPage); sidebar.prepend(explorerHeading);
  const editor = document.createElement("div"); editor.className = "source-editor-main";
  editor.append(codeEditor.tabs, breadcrumb, sourceFile, sourceText, codeEditor.cells, codeEditor.element, codeEditor.status, editorFeedback, notebookReview.element);
  layout.append(sidebar, editor, codeEditor.preview);
  fieldset.append(toolbar, mapInsert, selected, layout, trays, feedback);
  let previewOnly = false, mapInsertHidden = mapInsert.hidden;
  fieldset.setPreviewOnly = value => {
    if (value === previewOnly) return;
    previewOnly = value;
    fieldset.classList.toggle('publication-live-preview', value);
    if (value) {mapInsertHidden = mapInsert.hidden; mapInsert.hidden = true;}
    else mapInsert.hidden = mapInsertHidden;
    editor.hidden = toolbar.hidden = selected.hidden = trays.hidden = value;
    fieldset.querySelector('legend').textContent = value ? 'Live preview' : 'Source files';
    if (value) codeEditor.showDraft();
  };
  fieldset.runPublicationCommand = name => {
    if (name === 'save') submit.click();
    else if (name === 'new-page') openNewPage();
    else if (name === 'map') insertButton.click();
    else if (name === 'history') { fileTray.open = true; sourceHistory?.openHistory(); }
    else if (name === 'explorer') {
      sidebar.hidden = !sidebar.hidden; layout.classList.toggle('source-editor-explorer-hidden', sidebar.hidden);
    } else if (name === 'import' || name === 'export') {
      fileTray.open = true;
      if (name === 'import') {importing.open = true; files.focus();}
      else downloadProject.focus();
    }
  };
  if (!reopen.disabled) queueMicrotask(() => {if (treeGeneration === 0 && !workingFiles.length) reopen.click();});
  return fieldset;
}

export function appendObservableMarkdownPage(files, {relativePath, title, dataAttachments = [], referencedFiles = []}) {
  return appendPublicationPage(files, {relativePath, title, dataAttachments, referencedFiles, format: 'framework'});
}

export function appendPublicationPage(files, {relativePath, title, dataAttachments = [], referencedFiles = [], format = 'framework'}) {
  if (!files.length) throw new TypeError("Open the complete source revision first");
  const path = relativePath.trim();
  const extension = format === 'framework' ? 'md' : format === 'jupyter' ? 'ipynb' : 'html';
  if (!path.endsWith(`.${extension}`)) throw new TypeError(`Use a ${extension === 'md' ? 'Markdown ' : ''}.${extension} source path`);
  const heading = title.trim();
  if (!heading || heading.length > 300 || /[\r\n\u0000-\u001f]/.test(heading)) throw new TypeError("Enter a single-line page title");
  if (dataAttachments.some(item => item.relativePath.toLowerCase() === path.toLowerCase())) {
    throw new TypeError("This path belongs to an archived attachment");
  }
  if ([...files, ...dataAttachments, ...referencedFiles].some(item => {
    const existing = item.relativePath.toLowerCase(), next = path.toLowerCase();
    return existing === next || existing.startsWith(next + "/") || next.startsWith(existing + "/");
  })) throw new TypeError("This path conflicts with an existing file");
  if (files.length + dataAttachments.length + referencedFiles.length + 1 > 128) throw new TypeError("The source tree would exceed 128 files");
  // JSON strings are valid YAML scalars: punctuation cannot inject frontmatter.
  const page = format === 'framework' ? {blob: new Blob([`---\ntitle: ${JSON.stringify(heading)}\n---\n\nDescribe the question, source data, method, and limitations here.\n`], {type: 'text/markdown'}), contentType: 'text/markdown'}
    : publicationStarter({format, title: heading, sourceProject: {}}).files[0];
  return normalizeObservableSourceFiles([...files, {...page, relativePath: path}]);
}

export function prepareObservableBrowserFiles(fileList, directoryList) {
  const selection = selectObservableBrowserFiles(fileList, directoryList);
  const plan = planFrameworkDataSeparation(selection.files);
  if (plan.dataFiles.length) {
    const error = new TypeError("Source limits are 4 MiB per file and 16 MiB per tree; large data files need exact dataset references before import");
    error.dataFiles = plan.dataFiles;
    throw error;
  }
  return {...selection, files: plan.sourceFiles};
}

export async function prepareObservableArchiveBrowserFiles(fileList, directoryList, bindings, inventory) {
  const selection = selectObservableBrowserFiles(fileList, directoryList);
  return {...selection, ...await reconcileFrameworkArchiveFiles(selection.files, bindings, inventory)};
}

function selectObservableBrowserFiles(fileList, directoryList) {
  if (fileList?.length && directoryList?.length) {
    throw new TypeError("select source files or one source directory, not both");
  }
  const files = [...(directoryList?.length ? directoryList : fileList ?? [])];
  if (!files.length) throw new TypeError("select a non-empty source project directory");
  const roots = files.map((file) => String(file.webkitRelativePath || "").split("/")[0]);
  const sharedRoot = roots.every((root) => root && root === roots[0]) ? roots[0] : null;
  const excludedLocations = new Set();
  let excludedCount = 0;
  const selectedFiles = files.flatMap((file) => {
    const browserPath = String(file.webkitRelativePath || file.name);
    const relativePath = sharedRoot === null
      ? browserPath
      : browserPath.slice(sharedRoot.length + 1);
    // Never normalize traversal or backslashes into a path that could be accepted.
    if (relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
      throw new TypeError("Source directory contains an unsafe path");
    }
    const generated = relativePath.split("/").slice(0, -1)
      .find(part => ["node_modules", "dist", "build", "cache", ".observablehq", ".git"].includes(part.toLowerCase()));
    const repositoryControl = [".gitignore", ".gitattributes", ".DS_Store"].includes(relativePath.split("/").at(-1));
    if (directoryList?.length && (generated || repositoryControl)) {
      excludedLocations.add(generated ?? relativePath);
      excludedCount += 1;
      return [];
    }
    return [{relativePath, blob: file, contentType: file.type}];
  });
  return {files: selectedFiles, excludedCount, excludedLocations: [...excludedLocations].sort()};
}

function siteCreator(state, refresh, resourceHandoff = null) {
  const panel = document.createElement("section");
  panel.className = "project-resource-editor-panel project-site-editor";
  panel.dataset.siteDestination = "new";
  panel.dataset.resourceHandoff = resourceHandoff?.status ?? "none";
  panel.append(
    text("h3", "Create a multi-page project site"),
    text(
      "p",
      "Each page pins the exact current version of a governed resource. A later site revision cannot rewrite an earlier edition.",
      "project-resource-feedback"
    )
  );
  const title = labeledInput("Site title", `${state.project.name} report`, 300);
  const slug = labeledInput("Permanent site slug", siteSlug(state.project.name), 160);
  const description = labeledInput(
    "Site description",
    state.project.description ?? "A published research project.",
    4_000
  );
  const theme = labeledSelect("Accessible theme", ["paper", "atlas", "minimal"]);
  const accent = labeledInput("Accent color", "#176b87", 7);
  const printPageSize = labeledSelect(
    "Print page size",
    ["a4", "letter", "legal", "tabloid", "a3", "a2", "a1", "a0"]
  );
  const printOrientation = labeledSelect("Print orientation", ["landscape", "portrait"]);
  const printLayout = labeledSelect("PDF map layout", ["map-sheet", "flow"]);
  const printLegend = labeledCheckbox("Include style legend", true);
  const printNorthArrow = labeledCheckbox("Include north arrow", true);
  const printScaleBar = labeledCheckbox("Include scale bar", true);
  const printSettings = document.createElement("fieldset");
  printSettings.append(
    text("legend", "Immutable print layout"),
    printPageSize.label,
    printOrientation.label,
    printLayout.label,
    printLegend.label,
    printNorthArrow.label,
    printScaleBar.label,
    text(
      "p",
      "PDF pages and self-contained SVG map sheets use only sealed edition snapshots; the portable ZIP includes every available sheet.",
      "project-resource-feedback"
    )
  );
  const pageFieldset = document.createElement("fieldset");
  pageFieldset.append(text("legend", "Pages and home page"));
  const targetResourceId = resourceHandoff?.status === "ready"
    ? resourceHandoff.resource.id
    : null;
  const candidates = (state.resources ?? [])
    .filter((resource) => PAGE_KINDS.has(resource.kind))
    .sort((left, right) => {
      if (left.id === targetResourceId) return -1;
      if (right.id === targetResourceId) return 1;
      return 0;
    });
  const rows = candidates.map((resource, index) => pageSelector(
    resource,
    targetResourceId ? resource.id === targetResourceId : resourceHandoff ? false : index === 0,
    {
      home: targetResourceId ? resource.id === targetResourceId : !resourceHandoff && index === 0,
      groupName: "new-site-home-page"
    }
  ));
  pageFieldset.append(...rows.map((row) => row.element));
  wirePageOrdering(rows, pageFieldset);
  if (!rows.length) {
    pageFieldset.append(text(
      "p",
      "Create a story, document, dashboard, or map resource before assembling a site.",
      "project-resource-feedback"
    ));
  }
  const positionedLayout = positionedLayoutEditor(rows, {
    printPageSize,
    printOrientation,
    printLayout,
    printLegend,
    printNorthArrow,
    printScaleBar
  });
  const submit = button("Create draft site");
  const syncSubmit = () => {
    submit.disabled = !rows.some((row) => row.include.checked);
  };
  pageFieldset.addEventListener("change", syncSubmit);
  syncSubmit();
  const feedback = text(
    "p",
    resourceHandoff?.status === "ready"
      ? `${resourceHandoff.resource.title} v${resourceHandoff.resource.versionNumber} is selected. Creating the draft is still an explicit action.`
      : resourceHandoff
        ? "No page was selected from this handoff. Choose a current resource explicitly to continue."
        : "Drafts use existing request-driven storage and add no always-on publishing service.",
    "project-resource-feedback"
  );
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    feedback.textContent = "Pinning resource versions into an immutable site revision…";
    try {
      const pages = sitePageDrafts(rows);
      const positionedPrintLayout = positionedLayout.value(pages);
      await state.adapter.createSite(state.project.id, {
        slug: slug.control.value.trim().toLowerCase(),
        title: title.control.value.trim(),
        description: description.control.value.trim() || null,
        language: "en",
        theme: theme.control.value,
        themeOptions: {
          accentColor: accent.control.value.trim(),
          printPageSize: printPageSize.control.value,
          printOrientation: printOrientation.control.value,
          printLayout: printLayout.control.value,
          printLegend: String(printLegend.control.checked),
          printNorthArrow: String(printNorthArrow.control.checked),
          printScaleBar: String(printScaleBar.control.checked)
        },
        printLayout: positionedPrintLayout,
        pages
      });
      feedback.textContent = "Draft site created. Reloading the governed publication catalog…";
      await refresh();
    } catch (error) {
      feedback.textContent = `Site creation failed safely (${error?.code ?? error?.message ?? "invalid_site"}).`;
      submit.disabled = false;
    }
  });
  panel.append(
    title.label,
    slug.label,
    description.label,
    theme.label,
    accent.label,
    printSettings,
    pageFieldset,
    positionedLayout.element,
    submit,
    feedback
  );
  return panel;
}

function projectCollaboratorInvite(state) {
  const panel = document.createElement("details");
  panel.className = "project-site-collaborators";
  const summary = document.createElement("summary");
  summary.append(
    text("strong", "Workspace collaborators"),
    text("span", `Access and invitations · ${state.project.name}`)
  );
  const access = projectCollaboratorAccess(state);
  panel.append(
    summary,
    text(
      "p",
      "Manage access to the containing workspace. These roles apply across its Projects, Publications and shared resources, not just this Publication. Load the roster to review current access before changing it.",
      "project-resource-feedback"
    ),
    access.element
  );
  if (state.organization.callerRole !== "admin"
    || typeof state.adapter.createInvitation !== "function") {
    panel.append(text(
      "p",
      canManageProjectMembers(state)
        ? "You can assign or remove existing organization members above. An organization administrator must invite a new person."
        : "An organization administrator must invite a new person, and a project owner must change project access.",
      "project-resource-feedback"
    ));
    return panel;
  }

  const form = document.createElement("form");
  form.className = "platform-admin-form project-site-collaborator-form";
  form.dataset.purpose = "project-invitation";
  const email = labeledInput("Email", "", 320);
  email.control.type = "email";
  email.control.required = true;
  email.control.autocomplete = "email";
  email.control.ariaLabel = "Collaborator email";
  const displayName = labeledInput("Display name", "", 200);
  displayName.control.required = true;
  displayName.control.autocomplete = "name";
  displayName.control.ariaLabel = "Collaborator display name";
  const organizationRole = labeledSelect("Account access", ["member", "guest"]);
  organizationRole.control.ariaLabel = "Collaborator account access";
  const projectRole = labeledSelect("Project role", ["viewer", "reviewer", "editor"]);
  projectRole.control.ariaLabel = "Collaborator project role";
  const expiry = labeledSelect("Invitation expires", ["7", "3", "14", "30"]);
  expiry.control.ariaLabel = "Collaborator invitation expiry";
  for (const option of expiry.control.options) option.textContent = `${option.value} days`;
  const submit = button("Create project invitation");
  submit.type = "submit";
  const feedback = text(
    "p",
    "The invitee must sign in and accept this single-use invitation before access begins.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  form.append(
    email.label,
    displayName.label,
    organizationRole.label,
    projectRole.label,
    expiry.label,
    submit
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    feedback.textContent = "Creating a project-scoped invitation…";
    try {
      const invitation = await state.adapter.createInvitation({
        email: email.control.value.trim().toLowerCase(),
        displayName: displayName.control.value.trim(),
        organizationRole: organizationRole.control.value,
        projectId: state.project.id,
        projectRole: projectRole.control.value,
        expiresInDays: Number(expiry.control.value)
      });
      panel.dataset.state = invitation.status;
      feedback.textContent = `${invitation.email} was invited as ${invitation.projectRole}. Access begins only after acceptance.`;
      await access.reloadIfLoaded();
    } catch (error) {
      panel.dataset.state = "error";
      feedback.textContent = error?.code === "invitation_pending"
        ? "A matching pending invitation already exists; no duplicate was created."
        : `The invitation was not created (${error?.code ?? error?.message ?? "invitation_failed"}).`;
      submit.disabled = false;
    }
  });
  panel.append(
    text(
      "p",
      "This grants one existing OpenGeo Studio account scope and one role in this project. Organization-admin and project-owner grants stay in Team administration.",
      "project-resource-feedback"
    ),
    form,
    feedback
  );
  return panel;
}

function projectCollaboratorAccess(state) {
  const element = document.createElement("section");
  element.className = "project-site-access";
  const load = button("Load current access", "platform-button secondary");
  load.dataset.action = "load-project-access";
  const feedback = text(
    "p",
    "Roster and invitation history load only when requested.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  const content = document.createElement("div");
  content.className = "project-site-access-content";
  element.append(load, feedback, content);
  let loaded = false;
  let loading = false;

  if (typeof state.adapter.listProjectMembers !== "function") {
    load.disabled = true;
    feedback.textContent = "Project membership records are unavailable in this adapter.";
    return {element, reloadIfLoaded: async () => {}};
  }

  load.addEventListener("click", () => void reload(true));
  return {
    element,
    reloadIfLoaded: async () => {
      if (loaded) await reload(true);
    }
  };

  async function reload(force = false) {
    if (loading || (loaded && !force)) return;
    loading = true;
    load.disabled = true;
    feedback.textContent = loaded ? "Refreshing exact project access…" : "Loading exact project access…";
    try {
      const manager = canManageProjectMembers(state);
      const projectMembersPromise = state.adapter.listProjectMembers(
        state.project.id,
        {limit: 100}
      );
      const organizationMembersPromise = manager
        && state.organization.callerRole !== "guest"
        && typeof state.adapter.listOrganizationMembers === "function"
        ? state.adapter.listOrganizationMembers({limit: 100})
        : Promise.resolve(null);
      const invitationsPromise = state.organization.callerRole === "admin"
        && typeof state.adapter.listInvitations === "function"
        ? state.adapter.listInvitations({limit: 100})
        : Promise.resolve(null);
      const [projectResult, organizationResult, invitationResult] = await Promise.allSettled([
        projectMembersPromise,
        organizationMembersPromise,
        invitationsPromise
      ]);
      if (projectResult.status === "rejected") throw projectResult.reason;
      const organizationMembers = organizationResult.status === "fulfilled"
        ? organizationResult.value
        : null;
      const invitations = invitationResult.status === "fulfilled"
        ? invitationResult.value
        : null;
      renderProjectCollaboratorAccess(
        content,
        state,
        projectResult.value,
        organizationMembers,
        invitations,
        feedback,
        () => reload(true)
      );
      const warnings = [organizationResult, invitationResult]
        .filter(({status}) => status === "rejected").length;
      feedback.textContent = warnings
        ? `Project roster loaded. ${warnings} optional administration list could not be loaded; no access was changed.`
        : "Current project access loaded. Changes remain explicit and are applied immediately by the API.";
      loaded = true;
      load.textContent = "Refresh current access";
    } catch (error) {
      content.replaceChildren();
      feedback.textContent = `Project access could not be loaded (${error?.code ?? error?.message ?? "project_access_unavailable"}).`;
    } finally {
      loading = false;
      load.disabled = false;
    }
  }
}

function renderProjectCollaboratorAccess(
  content,
  state,
  projectMembers,
  organizationMembers,
  invitations,
  feedback,
  reload
) {
  content.replaceChildren();
  const manager = canManageProjectMembers(state);
  const roster = document.createElement("section");
  roster.className = "project-site-access-roster";
  roster.append(text("h4", "Current project access"));
  if (!projectMembers.length) {
    roster.append(text("p", "No direct project members are listed.", "project-resource-feedback"));
  } else {
    for (const member of projectMembers) {
      roster.append(projectCollaboratorRow(state, member, manager, feedback, reload));
    }
  }
  content.append(roster);

  if (manager && Array.isArray(organizationMembers)) {
    content.append(existingOrganizationMemberForm(
      state,
      organizationMembers,
      projectMembers,
      feedback,
      reload
    ));
  }
  if (state.organization.callerRole === "admin" && Array.isArray(invitations)) {
    content.append(projectInvitationHistory(state, invitations, feedback, reload));
  }
}

function projectCollaboratorRow(state, member, manager, feedback, reload) {
  const row = document.createElement("div");
  row.className = "project-site-access-row";
  row.dataset.memberId = member.userId;
  const identity = document.createElement("span");
  identity.append(
    text("strong", member.displayName),
    text("small", member.email)
  );
  row.append(identity);
  if (!manager || member.role === "owner") {
    row.append(
      text("span", member.role, `badge ${member.role}`),
      text(
        "small",
        member.role === "owner" ? "Ownership is managed in Team administration." : "Read only",
        "project-resource-feedback"
      )
    );
    return row;
  }
  const role = labeledSelect("Project role", ["viewer", "reviewer", "editor"]);
  role.control.value = member.role;
  role.control.ariaLabel = `${member.displayName} project role`;
  const update = button("Update", "platform-button secondary");
  update.dataset.action = "update-project-member";
  update.addEventListener("click", () => void mutateProjectAccess(
    update,
    feedback,
    `Updating ${member.email}…`,
    () => state.adapter.updateProjectMember(
      state.project.id,
      member.userId,
      role.control.value
    ),
    reload
  ));
  const remove = button("Remove", "platform-button secondary");
  remove.dataset.action = "revoke-project-member";
  remove.addEventListener("click", () => void mutateProjectAccess(
    remove,
    feedback,
    `Removing ${member.email} from this project…`,
    () => state.adapter.revokeProjectMember(state.project.id, member.userId),
    reload
  ));
  row.append(role.label, update, remove);
  return row;
}

function existingOrganizationMemberForm(
  state,
  organizationMembers,
  projectMembers,
  feedback,
  reload
) {
  const section = document.createElement("section");
  section.className = "project-site-access-add";
  section.append(text("h4", "Add an existing account member"));
  const assigned = new Set(projectMembers.map(({userId}) => userId));
  const candidates = organizationMembers.filter(({userId}) => !assigned.has(userId));
  if (!candidates.length) {
    section.append(text(
      "p",
      "Every visible organization member already has direct project access.",
      "project-resource-feedback"
    ));
    return section;
  }
  const form = document.createElement("form");
  form.className = "project-site-access-form";
  form.dataset.purpose = "existing-project-member";
  const person = document.createElement("label");
  person.append(text("span", "Organization member"));
  const member = document.createElement("select");
  member.ariaLabel = "Existing organization member";
  for (const candidate of candidates) {
    member.append(selectOption(
      candidate.userId,
      `${candidate.displayName} · ${candidate.email}`
    ));
  }
  person.append(member);
  const role = labeledSelect("Project role", ["viewer", "reviewer", "editor"]);
  role.control.ariaLabel = "Existing member project role";
  const add = button("Add to project");
  add.type = "submit";
  add.dataset.action = "create-project-member";
  form.append(person, role.label, add);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void mutateProjectAccess(
      add,
      feedback,
      "Adding the existing organization member to this project…",
      () => state.adapter.createProjectMember(
        state.project.id,
        member.value,
        role.control.value
      ),
      reload
    );
  });
  section.append(
    text(
      "p",
      "This project-local control cannot grant project owner or organization administrator.",
      "project-resource-feedback"
    ),
    form
  );
  return section;
}

function projectInvitationHistory(state, invitations, feedback, reload) {
  const section = document.createElement("section");
  section.className = "project-site-invitation-history";
  section.append(text("h4", "Project invitation history"));
  const records = invitations.filter(({projectId}) => projectId === state.project.id);
  if (!records.length) {
    section.append(text("p", "No invitation exists for this project.", "project-resource-feedback"));
    return section;
  }
  for (const invitation of records) {
    const row = document.createElement("div");
    row.className = "project-site-access-row";
    row.dataset.invitationId = invitation.id;
    const identity = document.createElement("span");
    identity.append(
      text("strong", invitation.displayName),
      text("small", invitation.email)
    );
    row.append(
      identity,
      text("span", `${invitation.projectRole} · ${invitation.status}`, `badge ${invitation.status}`)
    );
    if (invitation.status === "pending" && typeof state.adapter.revokeInvitation === "function") {
      const revoke = button("Revoke invitation", "platform-button secondary");
      revoke.dataset.action = "revoke-project-invitation";
      revoke.addEventListener("click", () => void mutateProjectAccess(
        revoke,
        feedback,
        `Revoking the invitation for ${invitation.email}…`,
        () => state.adapter.revokeInvitation(invitation.id),
        reload
      ));
      row.append(revoke);
    } else {
      row.append(text("small", "Final", "project-resource-feedback"));
    }
    section.append(row);
  }
  return section;
}

async function mutateProjectAccess(control, feedback, workingMessage, operation, reload) {
  control.disabled = true;
  feedback.textContent = workingMessage;
  try {
    await operation();
    feedback.textContent = "Project access updated. Reloading the exact roster…";
    await reload();
  } catch (error) {
    feedback.textContent = `Project access was not changed (${error?.code ?? error?.message ?? "project_access_update_failed"}).`;
    control.disabled = false;
  }
}

function canManageProjectMembers(state) {
  return state.organization.callerRole === "admin" || state.project.callerRole === "owner";
}

function pageSelector(
  resource,
  selected,
  {
    home = selected,
    groupName = "site-home-page",
    navigationLabel = resource.title,
    pageSlug = siteSlug(resource.slug),
    pinnedVersion = resource.versionNumber
  } = {}
) {
  const element = document.createElement("div");
  element.className = "project-site-page-selector";
  element.dataset.resourceId = resource.id;
  element.dataset.initiallyIncluded = String(selected);
  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = selected;
  include.ariaLabel = `Include ${resource.title}`;
  const identity = document.createElement("div");
  identity.className = "project-site-page-identity";
  identity.append(text("strong", `${resource.title} · ${resource.kind}`));
  const navigation = document.createElement("input");
  navigation.value = navigationLabel;
  navigation.maxLength = 120;
  navigation.ariaLabel = `${resource.title} navigation label`;
  const versions = [...new Set([pinnedVersion, resource.versionNumber])]
    .sort((left, right) => left - right);
  const version = document.createElement("select");
  version.ariaLabel = `${resource.title} resource version`;
  for (const number of versions) {
    const option = document.createElement("option");
    option.value = String(number);
    option.textContent = number === resource.versionNumber
      ? `Current v${number}`
      : `Pinned v${number}`;
    version.append(option);
  }
  version.value = String(pinnedVersion);
  identity.append(navigation, version);
  const homeControl = document.createElement("input");
  homeControl.type = "radio";
  homeControl.name = groupName;
  homeControl.checked = home;
  homeControl.ariaLabel = `${resource.title} is the home page`;
  homeControl.addEventListener("change", () => {
    if (homeControl.checked) include.checked = true;
  });
  const homeLabel = document.createElement("label");
  homeLabel.className = "project-site-home-choice";
  homeLabel.append(homeControl, text("span", "Home"));
  const order = document.createElement("div");
  order.className = "project-site-page-order";
  const moveUp = button("↑", "platform-button secondary");
  moveUp.ariaLabel = `Move ${resource.title} earlier`;
  const moveDown = button("↓", "platform-button secondary");
  moveDown.ariaLabel = `Move ${resource.title} later`;
  order.append(moveUp, moveDown);
  element.append(include, identity, homeLabel, order);
  return {
    element,
    include,
    home: homeControl,
    navigation,
    version,
    moveUp,
    moveDown,
    pageSlug,
    resource
  };
}

function wirePageOrdering(rows, container) {
  const render = () => {
    rows.forEach((row, index) => {
      row.moveUp.disabled = index === 0;
      row.moveDown.disabled = index === rows.length - 1;
      container.append(row.element);
    });
  };
  const move = (row, delta) => {
    const from = rows.indexOf(row);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= rows.length) return;
    rows.splice(from, 1);
    rows.splice(to, 0, row);
    render();
  };
  for (const row of rows) {
    row.moveUp.addEventListener("click", () => move(row, -1));
    row.moveDown.addEventListener("click", () => move(row, 1));
  }
  render();
}

function sitePageDrafts(rows) {
  const selected = rows.filter((row) => row.include.checked);
  if (!selected.length) throw new TypeError("select at least one page");
  const home = selected.find((row) => row.home.checked) ?? selected[0];
  return selected.map((row) => {
    const navigationLabel = row.navigation.value.trim();
    if (!navigationLabel) throw new TypeError("every page needs a navigation label");
    return {
      slug: row.pageSlug,
      navigationLabel,
      resourceId: row.resource.id,
      resourceVersion: Number.parseInt(row.version.value, 10),
      isHome: row === home
    };
  });
}

function siteCard(state, refresh, site, {workspace = false} = {}) {
  const card = document.createElement("article");
  card.className = "project-site-card";
  card.id = `site-${site.id}`;
  card.dataset.state = site.state;
  card.dataset.siteId = site.id;
  card.append(
    text("p", site.state, `badge ${site.state}`),
    text(
      "p",
      publicationDestinationSummary(site),
      `badge publication-${site.publicationDestination.reach}`
    ),
    text("h3", `${site.title} · ${site.slug}`),
    text("p", site.description ?? "No site description"),
    text(
      "p",
      `Revision ${site.versionNumber} · ${site.theme} theme · ${site.pages.length} pages`,
      "project-resource-feedback"
    ),
    text(
      "p",
      printSummary(site.themeOptions, site.printLayout),
      "project-resource-feedback"
    )
  );
  const pageEditor = document.createElement("div");
  const settings = document.createElement("div");
  const editorActions = document.createElement("div");
  editorActions.className = "source-editor-toolbar";
  if (site.state === "draft" && canManage(state)
    && typeof state.adapter.updateSite === "function") {
    const editor = siteRevisionEditor(state, refresh, site, card,
      workspace ? {settingsTarget: settings, actionsTarget: editorActions} : {});
    if (workspace) { editor.open = true; pageEditor.append(editor); }
    else card.append(editor);
  }
  const destination = publicationDestinationEditor(state, refresh, site, card);
  if (!workspace) card.append(destination);
  const pages = document.createElement("ol");
  pages.className = "project-site-pages";
  for (const page of site.pages) {
    pages.append(text(
      "li",
      `${page.navigationLabel}${page.isHome ? " · home" : ""} · ${page.resourceKind} v${page.resourceVersionNumber} · ${page.resourceState}/${page.resourceVisibility}`
    ));
  }
  if (workspace) pageEditor.append(pages);
  else card.append(pages);
  const readiness = site.pages.every(
    (page) => page.resourceState === "published" && page.resourceVisibility === "public"
  );
  const readinessMessage = text(
    "p",
    readiness
      ? "All page resources satisfy the public publication gate."
      : "Publication remains blocked until every page and referenced dataset/map is published and public.",
    "project-resource-feedback"
  );
  if (!workspace) card.append(readinessMessage);

  const actions = document.createElement("div");
  actions.className = "project-site-actions";
  if (site.state === "draft" && canManage(state)) {
    actions.append(actionButton("Submit revision for review", async () => {
      await state.adapter.submitSiteForReview(state.project.id, site.id, {
        expectedVersion: site.versionNumber,
        reason: "Submitted from the project publishing workspace"
      });
      await refresh();
    }, card));
  }
  if (site.state === "review" && canPublish(state)) {
    const mapImages = siteMapImagePicker(state, site);
    const snapshots = labeledTextarea(
      "Immutable PNG snapshots (optional)",
      "",
      1_500,
      "One resource UUID = completed PNG render job UUID per line"
    );
    const publish = actionButton("Publish reviewed edition", async () => {
      await state.adapter.publishSite(state.project.id, site.id, {
        expectedVersion: site.versionNumber,
        reason: "Approved from the project publishing workspace",
        mapSnapshots: mergeSnapshotBindings(mapImages.bindings(), parseSnapshotBindings(snapshots.control.value))
      });
      await refresh();
    }, card);
    publish.disabled = !readiness;
    const advanced = document.createElement("details");
    advanced.append(text("summary", "Advanced image bindings"), snapshots.label);
    actions.append(
      mapImages.panel,
      advanced,
      text(
        "p",
        "Bindings are sealed by object version and SHA-256. PDF and ZIP generation then run only when requested.",
        "project-resource-feedback"
      ),
      publish
    );
  } else if (site.state === "review") {
    actions.append(text(
      "p",
      "This revision is awaiting a project owner or reviewer. Your editorial work is preserved; publication requires separate approval.",
      "project-resource-feedback project-site-review-handoff"
    ));
  }
  if (site.activeEdition !== null && site.activeEdition.publicationReach !== "unpublished") {
    const edition = site.activeEdition;
    const listed = edition.publicationReach === "listed";
    if (hasPublicSiteDelivery(state.adapter, listed)) {
      const publicUrl = listed
        ? state.adapter.publicSiteUrl(
            state.organization.id,
            state.project.id,
            edition.listedSlug
          )
        : state.adapter.publicUnlistedSiteUrl(
            state.organization.id,
            state.project.id,
            edition.unlistedToken
          );
      actions.append(
        link(listed ? "Open listed site" : "Open unlisted site", publicUrl),
        link(
          "Download portable ZIP",
          listed
            ? state.adapter.publicSiteExportUrl(
                state.organization.id,
                state.project.id,
                edition.listedSlug
              )
            : state.adapter.publicSiteEditionExportUrl(
                state.organization.id,
                state.project.id,
                edition.id
              ),
          true
        ),
        link(
          "Download print PDF",
          listed
            ? state.adapter.publicSitePrintUrl(
                state.organization.id,
                state.project.id,
                edition.listedSlug
              )
            : state.adapter.publicSiteEditionPrintUrl(
                state.organization.id,
                state.project.id,
                edition.id
              ),
          true
        )
      );
      for (const page of site.pages) {
        actions.append(link(
          `Open whole-page PNG · ${page.navigationLabel}`,
          listed
            ? state.adapter.publicSitePagePngUrl(
                state.organization.id,
                state.project.id,
                edition.listedSlug,
                page.slug
              )
            : state.adapter.publicSiteEditionPagePngUrl(
                state.organization.id,
                state.project.id,
                edition.id,
                page.slug
              )
        ));
      }
      for (const resourceId of printableMapResourceIds(site)) {
        actions.append(link(
          `Open printable SVG map sheet · ${resourceId.slice(0, 8)}`,
          listed
            ? state.adapter.publicSiteMapSheetUrl(
                state.organization.id,
                state.project.id,
                edition.listedSlug,
                resourceId
              )
            : state.adapter.publicSiteEditionMapSheetUrl(
                state.organization.id,
                state.project.id,
                edition.id,
                resourceId
              )
        ));
      }
    } else {
      actions.append(text(
        "p",
        "The memory-only fixture records this sealed edition and revocation state. Public pages, ZIP, PDF, PNG, and SVG artifacts require the API-backed publishing runtime.",
        "project-resource-feedback"
      ));
    }
    if (canPublish(state)) {
      actions.append(actionButton("Revoke public edition", async () => {
        await state.adapter.revokeSiteEdition(
          state.project.id,
          site.id,
          site.activeEdition.id
        );
        await refresh();
      }, card, "platform-button secondary"));
    }
  }
  if (workspace) {
    const publish = document.createElement("div");
    destination.open = true;
    const addresses = document.createElement('details'); addresses.className = 'publication-address-settings';
    addresses.append(text('summary', 'Public addresses'), destination);
    settings.prepend(addresses);
    const configureAddress = button('Configure public addresses…', 'platform-button secondary');
    configureAddress.onclick = () => card.runPublicationCommand('addresses');
    publish.append(configureAddress, readinessMessage, actions);
    if (!settings.childNodes.length) settings.append(text("p", `${site.theme ?? "Default"} theme · ${printSummary(site.themeOptions, site.printLayout)}`));
    const panels = PublicationPanels({label: "Map and page publication workspace", panels: [
      {id: "pages", label: "Pages", render: () => pageEditor},
      {id: "preview", label: "Preview", render: () => SitePagePreview({state, site})},
      {id: "publish", label: "Publish", render: () => publish},
      {id: "settings", label: "Settings", render: () => settings}
    ]});
    card.runPublicationCommand = name => {
      if (name === 'addresses') {panels.selectPanel('settings'); addresses.open = true; addresses.querySelector('summary').focus();}
      else panels.selectPanel(name === 'files' ? 'pages' : name);
    };
    card.append(panels, editorActions);
  } else card.append(actions);
  return card;
}

function siteMapImagePicker(state, site) {
  const panel = document.createElement("div");
  panel.className = "project-site-map-images";
  panel.append(text("h4", "Completed map images"));
  const references = new Map();
  function reference(resourceId, version) {
    const previous = references.get(resourceId);
    references.set(resourceId, previous !== undefined && previous !== null && version !== null && previous !== version
      ? -1 : version ?? previous ?? null);
  }
  for (const page of site.pages) {
    if (page.resourceKind === "map") reference(page.resourceId, page.resourceVersionNumber);
    for (const block of Array.isArray(page.content?.blocks) ? page.content.blocks : []) {
      if (block?.type !== "map") continue;
      const id = block.resource_id ?? block.resourceId;
      if (typeof id === "string") {
        reference(id, block.resource_version_number ?? block.resourceVersionNumber ?? null);
      }
    }
  }
  const rows = document.createElement("div");
  const feedback = text("p", references.size
    ? "Load completed PNGs, then choose an exact image for each map. This only reads existing images; create new ones under Resources."
    : "This revision has no map references to select images for.", "project-resource-feedback");
  feedback.ariaLive = "polite";
  let selections = [];
  let ready = false;
  if (references.size && typeof state.adapter.listResourceRenders === "function"
    && typeof state.adapter.getResource === "function") {
    const refresh = button("Refresh completed map images", "platform-button secondary");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      ready = false;
      for (const {control} of selections) control.disabled = true;
      feedback.textContent = "Reading current resource revisions and completed images…";
      try {
        const loaded = await Promise.all([...references].map(async ([resourceId, pinnedVersion]) => {
          const [resource, jobs] = await Promise.all([
            state.adapter.getResource(state.project.id, resourceId),
            state.adapter.listResourceRenders(state.project.id, resourceId)
          ]);
          const snapshot = resource.mapSnapshot;
          const stale = pinnedVersion !== null && pinnedVersion !== resource.versionNumber;
          const eligible = resource.kind === "map" && snapshot && !stale
            ? jobs.filter((job) => job.resourceId === resource.id && job.state === "completed"
              && job.format === "png" && job.savedMapSnapshot?.resourceVersionNumber === resource.versionNumber
              && job.savedMapSnapshot.mapId === snapshot.mapId
              && job.savedMapSnapshot.mapVersion === snapshot.mapVersion
              && job.savedMapSnapshot.definitionChecksumSha256 === snapshot.definitionChecksumSha256)
            : [];
          const unavailable = stale
            ? "The site's map reference is stale or inconsistent. Revise the site before selecting an image."
            : !snapshot
              ? "Select a saved map revision under Resources before creating an image."
              : "No matching completed PNG — create one under Resources";
          return {resourceId, resource, eligible, unavailable};
        }));
        const previous = new Map(selections.map(({resourceId, control}) => [resourceId, control.value]));
        selections = [];
        rows.replaceChildren();
        let removedSelection = false;
        for (const {resourceId, resource, eligible, unavailable} of loaded) {
          const label = document.createElement("label");
          label.append(text("span", `${resource.title} · resource v${resource.versionNumber}`));
          const control = document.createElement("select");
          control.ariaLabel = `Map image for ${resource.title}`;
          control.append(selectOption("", eligible.length ? "No image selected" : unavailable));
          for (const job of eligible) control.append(selectOption(job.id,
            `${resource.title} · resource v${job.savedMapSnapshot.resourceVersionNumber} / map v${job.savedMapSnapshot.mapVersion} · ${job.width} × ${job.height} PNG · ${job.id}`));
          const prior = previous.get(resourceId);
          if (eligible.some(({id}) => id === prior)) control.value = prior;
          else if (prior) removedSelection = true;
          control.disabled = eligible.length === 0;
          label.append(control);
          rows.append(label);
          selections.push({resourceId, control});
        }
        ready = true;
        feedback.textContent = removedSelection
          ? "A previously selected image no longer matches the current revision and was cleared. Review the choices before publishing."
          : "Only completed PNGs matching the current resource and its bound map revision are shown. Choose images deliberately; publication rechecks access and exact versions.";
      } catch (error) {
        feedback.textContent = `Images could not be refreshed (${error?.code ?? "unexpected_error"}). Retry before publishing selected images.`;
      } finally {
        refresh.disabled = false;
      }
    });
    panel.append(refresh);
  } else if (references.size) {
    feedback.textContent = "The completed-image chooser is unavailable in this adapter. Advanced bindings remain available.";
  }
  panel.append(rows, feedback);
  return {panel, bindings() {
    const selected = selections.filter(({control}) => control.value);
    if (selected.length && !ready) throw new TypeError("refresh completed map images before publishing");
    return selected.map(({resourceId, control}) => ({resourceId, renderJobId: control.value}));
  }};
}

function mergeSnapshotBindings(selected, manual) {
  const result = [...selected, ...manual];
  if (result.length > 16 || new Set(result.map(({resourceId}) => resourceId)).size !== result.length
    || new Set(result.map(({renderJobId}) => renderJobId)).size !== result.length) {
    throw new TypeError("Choose at most 16 images, without duplicate resource or job bindings.");
  }
  return result;
}

function hasPublicSiteDelivery(adapter, listed) {
  const shared = [
    "publicSiteEditionExportUrl",
    "publicSiteEditionPrintUrl",
    "publicSiteEditionPagePngUrl",
    "publicSiteEditionMapSheetUrl"
  ];
  const named = [
    "publicSiteUrl",
    "publicSiteExportUrl",
    "publicSitePrintUrl",
    "publicSitePagePngUrl",
    "publicSiteMapSheetUrl"
  ];
  const unlisted = ["publicUnlistedSiteUrl", ...shared];
  return (listed ? named : unlisted).every((method) => typeof adapter?.[method] === "function");
}

function siteRevisionEditor(state, refresh, site, card, {settingsTarget = null, actionsTarget = null} = {}) {
  const details = document.createElement("details");
  details.className = "project-site-revision-editor project-site-editor";
  details.dataset.siteDestination = site.id;
  details.append(text("summary", "Edit draft revision"));
  details.append(text(
    "p",
    "Changes create a new immutable draft revision. Existing page versions remain pinned unless you explicitly choose a newer current version.",
    "project-resource-feedback"
  ));

  const title = labeledInput("Site title", site.title, 300);
  const description = labeledTextarea(
    "Site description",
    site.description ?? "",
    4_000,
    "Describe this governed publication"
  );
  const theme = labeledSelect("Accessible theme", ["paper", "atlas", "minimal"]);
  theme.control.value = site.theme;
  const options = site.themeOptions ?? {};
  const accent = labeledInput("Accent color", options.accentColor ?? "#176b87", 7);
  const footer = labeledInput("Footer text (optional)", options.footerText ?? "", 500);
  const printPageSize = labeledSelect(
    "Print page size",
    ["a4", "letter", "legal", "tabloid", "a3", "a2", "a1", "a0"]
  );
  printPageSize.control.value = options.printPageSize ?? "a4";
  const printOrientation = labeledSelect("Print orientation", ["landscape", "portrait"]);
  printOrientation.control.value = options.printOrientation ?? "landscape";
  const printLayout = labeledSelect("PDF map layout", ["map-sheet", "flow"]);
  printLayout.control.value = options.printLayout ?? "flow";
  const printLegend = labeledCheckbox("Include style legend", options.printLegend !== "false");
  const printNorthArrow = labeledCheckbox(
    "Include north arrow",
    options.printNorthArrow !== "false"
  );
  const printScaleBar = labeledCheckbox("Include scale bar", options.printScaleBar !== "false");
  const printSettings = document.createElement("fieldset");
  printSettings.append(
    text("legend", "Immutable print layout"),
    printPageSize.label,
    printOrientation.label,
    printLayout.label,
    printLegend.label,
    printNorthArrow.label,
    printScaleBar.label
  );

  const currentResources = new Map(
    (state.resources ?? [])
      .filter((resource) => PAGE_KINDS.has(resource.kind))
      .map((resource) => [resource.id, resource])
  );
  const existingPages = [...site.pages].sort((left, right) => left.position - right.position);
  const existingByResource = new Map(existingPages.map((page) => [page.resourceId, page]));
  const resources = existingPages.map((page) => currentResources.get(page.resourceId) ?? {
    id: page.resourceId,
    slug: page.slug,
    title: page.resourceTitle,
    abstract: null,
    kind: page.resourceKind,
    versionNumber: page.resourceVersionNumber
  });
  resources.push(...[...currentResources.values()].filter(
    (resource) => !existingByResource.has(resource.id)
  ));
  const rows = resources.map((resource) => {
    const page = existingByResource.get(resource.id);
    return pageSelector(resource, page !== undefined, {
      home: page?.isHome ?? false,
      groupName: `site-${site.id}-home-page`,
      navigationLabel: page?.navigationLabel ?? resource.title,
      pageSlug: page?.slug ?? siteSlug(resource.slug),
      pinnedVersion: page?.resourceVersionNumber ?? resource.versionNumber
    });
  });
  const pages = document.createElement("fieldset");
  pages.append(
    text("legend", "Pages, navigation, and home page"),
    text(
      "p",
      "Use the arrows to define navigation order. Version choices distinguish the sealed page from a newer current resource.",
      "project-resource-feedback"
    ),
    ...rows.map((row) => row.element)
  );
  wirePageOrdering(rows, pages);
  const positionedLayout = positionedLayoutEditor(rows, {
    printPageSize,
    printOrientation,
    printLayout,
    printLegend,
    printNorthArrow,
    printScaleBar
  }, site.printLayout);
  const changeMessage = labeledInput(
    "Revision note",
    `Update ${site.title} navigation and presentation`,
    500
  );
  const save = button("Save draft revision");
  const feedback = text(
    "p",
    "Saving preserves the permanent site identity and publication destination.",
    "project-resource-feedback"
  );
  save.addEventListener("click", async () => {
    save.disabled = true;
    feedback.textContent = "Saving a version-checked immutable draft revision…";
    try {
      const pageDrafts = sitePageDrafts(rows);
      const themeOptions = {
        accentColor: accent.control.value.trim(),
        printPageSize: printPageSize.control.value,
        printOrientation: printOrientation.control.value,
        printLayout: printLayout.control.value,
        printLegend: String(printLegend.control.checked),
        printNorthArrow: String(printNorthArrow.control.checked),
        printScaleBar: String(printScaleBar.control.checked)
      };
      if (footer.control.value.trim()) themeOptions.footerText = footer.control.value.trim();
      await state.adapter.updateSite(state.project.id, site.id, {
        expectedVersion: site.versionNumber,
        changeMessage: changeMessage.control.value.trim(),
        title: title.control.value.trim(),
        description: description.control.value.trim() || null,
        language: site.language,
        theme: theme.control.value,
        themeOptions,
        printLayout: positionedLayout.value(pageDrafts),
        pages: pageDrafts
      });
      feedback.textContent = "Draft revision saved. Reloading exact version facts…";
      await refresh();
    } catch (error) {
      feedback.textContent = `Draft revision was not changed (${error?.code ?? error?.message ?? "site_update_failed"}).`;
      card.dataset.revisionError = error?.code ?? "site_update_failed";
      save.disabled = false;
    }
  });
  details.append(title.label, description.label);
  (settingsTarget ?? details).append(theme.label, accent.label, footer.label, printSettings);
  details.append(pages);
  (settingsTarget ?? details).append(positionedLayout.element);
  (actionsTarget ?? details).append(changeMessage.label, save, feedback);
  return details;
}

function publicationDestinationSummary(site) {
  const destination = site.publicationDestination;
  if (destination.reach === "unpublished") {
    return destination.listedSlug
      ? `Unpublished · /${destination.listedSlug}/ reserved`
      : "Unpublished · no public path reserved";
  }
  if (destination.reach === "unlisted") return "Unlisted · opaque link on each edition";
  return destination.isPrimary
    ? "Listed · account primary root"
    : `Listed · /${destination.listedSlug}/`;
}

function publicationDestinationEditor(state, refresh, site, card) {
  const details = document.createElement("details");
  details.className = "project-site-destination";
  details.append(text("summary", "Publication destination"));
  const destination = site.publicationDestination;
  details.append(text(
    "p",
    "Authoring access remains private. This setting controls only the next sealed edition; an active edition keeps its previously sealed address until it is replaced or revoked.",
    "project-resource-feedback"
  ));
  if (!canPublish(state) || typeof state.adapter.configureSitePublicationDestination !== "function") {
    return details;
  }
  const reach = labeledSelect("Reach", ["unpublished", "unlisted", "listed"]);
  reach.control.value = destination.reach;
  const path = labeledInput("Listed path", destination.listedSlug ?? site.slug, 160);
  const primary = labeledCheckbox("Serve this listed site at the account root", destination.isPrimary);
  const feedback = text(
    "p",
    "Unlisted identifiers are generated by the server. Once a listed path has published, it remains reserved and cannot be reassigned.",
    "project-resource-feedback"
  );
  const save = button("Save destination", "platform-button secondary");
  const sync = () => {
    const listed = reach.control.value === "listed";
    primary.control.disabled = !listed;
    if (!listed) primary.control.checked = false;
    path.control.disabled = false;
  };
  reach.control.addEventListener("change", sync);
  path.control.addEventListener("change", () => {
    path.control.value = siteSlug(path.control.value);
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    feedback.textContent = "Saving the version-checked publication destination…";
    try {
      await state.adapter.configureSitePublicationDestination(
        state.project.id,
        site.id,
        {
          expectedRevision: destination.revision,
          reach: reach.control.value,
          listedSlug: path.control.value.trim()
            ? siteSlug(path.control.value)
            : null,
          isPrimary: primary.control.checked
        }
      );
      await refresh();
    } catch (error) {
      feedback.textContent = `Destination was not changed (${error?.code ?? "site_destination_failed"}).`;
      save.disabled = false;
      card.dataset.destinationError = error?.code ?? "site_destination_failed";
    }
  });
  sync();
  const fields = document.createElement("div");
  fields.className = "project-site-destination-fields";
  fields.append(reach.label, path.label, primary.label, save);
  details.append(fields, feedback);
  return details;
}

function actionButton(label, action, card, className = "platform-button") {
  const control = button(label, className);
  control.addEventListener("click", async () => {
    control.disabled = true;
    try {
      await action();
    } catch (error) {
      card.append(text(
        "p",
        `Publication action failed safely (${error?.code ?? "site_action_failed"}).`,
        "project-resource-feedback"
      ));
      control.disabled = false;
    }
  });
  return control;
}

function link(label, href, download = false) {
  const control = document.createElement("a");
  control.className = "platform-button secondary";
  control.textContent = label;
  control.href = href;
  control.target = "_blank";
  control.rel = "noopener noreferrer";
  if (download) control.download = "";
  return control;
}

function resolveSiteResourceHandoff(state, target) {
  if (!target) return null;
  if (!canManage(state)) {
    return {status: "view_only", resource: null, requestedVersion: target.resourceVersion};
  }
  const resource = (state.resources ?? []).find(({id}) => id === target.resourceId) ?? null;
  if (!resource) {
    return {status: "unavailable", resource: null, requestedVersion: target.resourceVersion};
  }
  if (!PAGE_KINDS.has(resource.kind)) {
    return {status: "ineligible", resource, requestedVersion: target.resourceVersion};
  }
  if (resource.versionNumber !== target.resourceVersion) {
    return {status: "stale", resource, requestedVersion: target.resourceVersion};
  }
  return {status: "ready", resource, requestedVersion: target.resourceVersion};
}

function siteResourceHandoffNotice(surface, handoff, sites) {
  const notice = document.createElement("aside");
  notice.className = "project-resource-handoff";
  notice.dataset.state = handoff.status;
  notice.setAttribute("role", "status");
  let heading;
  let message;
  if (handoff.status === "ready") {
    heading = "Resource ready for site assembly";
    message = `${handoff.resource.title} v${handoff.resource.versionNumber} is ready. Choose a new or existing draft; nothing changes until you explicitly create or save that draft.`;
  } else if (handoff.status === "stale") {
    heading = "Resource version changed";
    message = `${handoff.resource.title} is now v${handoff.resource.versionNumber}; the requested v${handoff.requestedVersion} was not selected. Review the current version before continuing.`;
  } else if (handoff.status === "ineligible") {
    heading = "Resource cannot be a site page";
    message = `${handoff.resource.title} is a ${handoff.resource.kind} record. Choose a document, story, dashboard, or map resource instead.`;
  } else if (handoff.status === "view_only") {
    heading = "Site editing is unavailable";
    message = "You can inspect this publication workspace, but your current project role cannot create or revise a site.";
  } else {
    heading = "Resource is unavailable";
    message = "The requested resource is not available in this project. No substitute page was selected.";
  }
  notice.append(text("strong", heading), text("p", message));
  if (handoff.status === "ready") {
    notice.append(siteResourceDestinationChooser(surface, handoff, sites));
  }
  return notice;
}

function siteResourceDestinationChooser(surface, handoff, sites) {
  const controls = document.createElement("div");
  controls.className = "project-resource-handoff-controls";
  const label = document.createElement("label");
  label.append(text("span", "Destination draft"));
  const destination = document.createElement("select");
  destination.ariaLabel = "Resource site destination";
  destination.append(selectOption("new", "New project site"));
  for (const site of sites.filter(({state}) => state === "draft")) {
    destination.append(selectOption(site.id, `${site.title} · revision ${site.versionNumber}`));
  }
  label.append(destination);
  const prepare = button("Prepare destination", "platform-button secondary");
  const feedback = text(
    "p",
    "Preparation changes only the form. Creating or saving remains a separate, version-checked action.",
    "project-resource-feedback"
  );
  feedback.ariaLive = "polite";
  prepare.addEventListener("click", () => {
    const editors = [...surface.querySelectorAll("[data-site-destination]")];
    const editor = editors
      .find((candidate) => candidate.dataset.siteDestination === destination.value);
    if (!editor) {
      feedback.textContent = "That draft is no longer available. Reload the project before continuing.";
      controls.dataset.state = "stale";
      return;
    }
    for (const candidate of editors) {
      delete candidate.dataset.resourceHandoffFocus;
      const candidateRow = [...candidate.querySelectorAll(".project-site-page-selector")]
        .find((row) => row.dataset.resourceId === handoff.resource.id);
      if (!candidateRow) continue;
      delete candidateRow.dataset.handoffFocus;
      const candidateInclude = candidateRow.querySelector(':scope > input[type="checkbox"]');
      if (!candidateInclude) continue;
      const desired = candidate.dataset.siteDestination === "new"
        ? destination.value === "new"
        : candidateRow.dataset.initiallyIncluded === "true"
          || candidate.dataset.siteDestination === destination.value;
      if (candidateInclude.checked !== desired) {
        candidateInclude.checked = desired;
        candidateInclude.dispatchEvent(new candidateInclude.ownerDocument.defaultView.Event(
          "change",
          {bubbles: true}
        ));
      }
    }
    if (destination.value === "new") {
      controls.dataset.state = "prepared";
      editor.dataset.resourceHandoffFocus = handoff.resource.id;
      feedback.textContent = `${handoff.resource.title} is selected in the new-site form. Review the site identity and explicitly create the draft to continue.`;
      editor.scrollIntoView?.({block: "start"});
      editor.querySelector("input")?.focus();
      return;
    }
    const row = [...editor.querySelectorAll(".project-site-page-selector")]
      .find((candidate) => candidate.dataset.resourceId === handoff.resource.id);
    if (!row) {
      feedback.textContent = "The exact resource is not available in that draft editor. No substitute was selected.";
      controls.dataset.state = "unavailable";
      return;
    }
    const include = row.querySelector(':scope > input[type="checkbox"]');
    const wasIncluded = row.dataset.initiallyIncluded === "true";
    if (include) include.checked = true;
    editor.open = true;
    editor.dataset.resourceHandoffFocus = handoff.resource.id;
    row.dataset.handoffFocus = "true";
    controls.dataset.state = "prepared";
    feedback.textContent = wasIncluded
      ? `${handoff.resource.title} is already in this draft. Its pinned version was preserved; choose a newer version explicitly if needed.`
      : `${handoff.resource.title} is selected only in ${destination.selectedOptions[0].textContent}. Review the page order, then explicitly save a new draft revision.`;
    editor.scrollIntoView?.({block: "start"});
    include?.focus();
  });
  controls.append(label, prepare, feedback);
  return controls;
}

function selectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function canManage(state) {
  return state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
}

function canPublish(state) {
  return state.organization.callerRole === "admin"
    || ["owner", "reviewer"].includes(state.project.callerRole);
}

function siteSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "project-site";
}

function labeledInput(labelText, value, maxLength) {
  const label = document.createElement("label");
  label.append(text("span", labelText));
  const control = document.createElement("input");
  control.value = value;
  control.maxLength = maxLength;
  label.append(control);
  return {label, control};
}

function labeledSelect(labelText, values) {
  const label = document.createElement("label");
  label.append(text("span", labelText));
  const control = document.createElement("select");
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    control.append(option);
  }
  label.append(control);
  return {label, control};
}

function labeledCheckbox(labelText, checked) {
  const label = document.createElement("label");
  label.className = 'publication-checkbox';
  const control = document.createElement("input");
  control.type = "checkbox";
  control.checked = checked;
  label.append(control, text("span", labelText));
  return {label, control};
}

function printSummary(options = {}, printLayout = null) {
  const pageSize = String(options.printPageSize ?? "a4").toUpperCase();
  const orientation = options.printOrientation ?? "landscape";
  const layout = options.printLayout ?? "flow";
  const positionedPages = Array.isArray(printLayout?.pages) ? printLayout.pages.length : 0;
  return `Print ${pageSize} ${orientation} · ${layout} · ${positionedPages} positioned page${positionedPages === 1 ? "" : "s"} · request-driven, fixed inactive delta $0`;
}

function positionedLayoutEditor(rows, printControls, initialLayout = null) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "project-positioned-layout";
  fieldset.append(
    text("legend", "Positioned multi-frame pages (optional)"),
    text(
      "p",
      "Drag, resize, rotate, clip, and fit frames in a portable 1000 × 1000 page space. Every map, legend, image, table, and chart resolves from the exact sealed edition; layouts cannot load URLs or execute code.",
      "project-resource-feedback"
    )
  );
  const source = labeledTextarea(
    "Advanced layout JSON",
    initialLayout && Array.isArray(initialLayout.pages) && initialLayout.pages.length
      ? JSON.stringify(initialLayout, null, 2)
      : "",
    32_768,
    '{"schemaVersion":"opengeo.print-layout.1.1.0","pages":[]}'
  );
  source.control.rows = 10;
  const starter = button("Insert accessible starter layout", "platform-button secondary");
  const importGeoMoose = button("Import GeoMoose print layout…", "platform-button secondary");
  const importGeoMooseFile = document.createElement("input");
  importGeoMooseFile.type = "file";
  importGeoMooseFile.accept = ".json,application/json";
  importGeoMooseFile.hidden = true;
  const pageChoice = labeledSelect("Preview page", []);
  const addType = labeledSelect("Add frame", [
    "text", "map_frame", "legend_frame", "image_frame", "table_frame", "chart_frame",
    "source_panel", "north_arrow", "scale_bar"
  ]);
  const addBinding = labeledInput("Exact binding or text", "", 1_000);
  const addFrame = button("Add frame", "platform-button secondary");
  const addControls = document.createElement("div");
  addControls.className = "project-positioned-layout-add";
  addControls.append(pageChoice.label, addType.label, addBinding.label, addFrame);
  const preview = document.createElement("div");
  preview.className = "project-positioned-layout-preview";
  preview.ariaLabel = "Positioned print layout preview";
  const inspector = document.createElement("fieldset");
  inspector.className = "project-positioned-layout-inspector";
  const inspectorTitle = text("legend", "Selected frame");
  const selectedSummary = text("p", "Select a frame to edit it.", "project-resource-feedback");
  const geometry = Object.fromEntries(
    ["x", "y", "width", "height", "rotation"].map((name) => {
      const field = labeledInput(name[0].toUpperCase() + name.slice(1), "0", 5);
      field.control.type = "number";
      field.control.step = "1";
      field.control.min = name === "rotation" ? "-180" : "0";
      field.control.max = "1000";
      return [name, field];
    })
  );
  const clip = labeledCheckbox("Clip to frame", true);
  const fit = labeledSelect("Image fit", ["contain", "cover"]);
  const apply = button("Apply frame changes");
  const rotateLeft = button("Rotate −15°", "platform-button secondary");
  const rotateRight = button("Rotate +15°", "platform-button secondary");
  const remove = button("Delete frame", "platform-button secondary");
  const inspectorActions = document.createElement("div");
  inspectorActions.className = "project-positioned-layout-actions";
  inspectorActions.append(apply, rotateLeft, rotateRight, remove);
  inspector.append(
    inspectorTitle,
    selectedSummary,
    ...Object.values(geometry).map((field) => field.label),
    clip.label,
    fit.label,
    inspectorActions
  );
  const feedback = text(
    "p",
    "Leave blank for flow pages plus map-sheet appendices.",
    "project-resource-feedback"
  );
  let selected = null;

  const selectedRows = () => rows.filter((row) => row.include.checked);
  const allowedSlugs = () => new Set(selectedRows().map((row) => siteSlug(row.resource.slug)));
  const rawLayout = () => (
    source.control.value.trim()
      ? JSON.parse(source.control.value)
      : {schemaVersion: "opengeo.print-layout.1.1.0", pages: []}
  );
  const parsedLayout = () => parseSitePrintLayout(rawLayout(), allowedSlugs());
  const writeLayout = (layout) => {
    parseSitePrintLayout(layout, allowedSlugs());
    source.control.value = JSON.stringify(layout, null, 2);
  };
  const findSelected = (layout) => {
    if (!selected) return null;
    const page = layout.pages.find(({sitePageSlug}) => sitePageSlug === selected.pageSlug);
    const element = page?.elements.find(({id}) => id === selected.elementId);
    return page && element ? {page, element} : null;
  };
  const editSelected = (change) => {
    const layout = rawLayout();
    if (layout.schemaVersion !== "opengeo.print-layout.1.1.0") {
      throw new TypeError("visual edits require the 1.1 layout; insert a new starter to upgrade");
    }
    const target = findSelected(layout);
    if (!target) throw new TypeError("select a frame first");
    change(target.element, target.page, layout);
    writeLayout(layout);
  };
  const controlValue = (field) => Number.parseInt(field.control.value, 10);
  const syncInspector = (layout) => {
    const target = findSelected(layout);
    inspector.disabled = !target;
    if (!target) {
      selectedSummary.textContent = "Select a frame to edit it.";
      return;
    }
    const {element} = target;
    selectedSummary.textContent = `${element.id} · ${element.type}. Arrow keys move by 10 units; Shift + arrows move by 1.`;
    for (const name of ["x", "y", "width", "height", "rotation"]) {
      geometry[name].control.value = String(element[name] ?? 0);
    }
    clip.control.checked = element.clip ?? true;
    fit.control.value = element.fit ?? "contain";
    fit.label.hidden = !["map_frame", "image_frame"].includes(element.type);
  };
  const frameLabel = (element) => {
    if (element.type === "map_frame") return `Map · ${element.resourceId.slice(0, 8)}`;
    if (Object.hasOwn(element, "blockId")) return `${element.type.replaceAll("_", " ")} · ${element.blockId}`;
    return element.type.replaceAll("_", " ");
  };
  const beginPointerEdit = (event, element, shell, mode) => {
    if (event.button !== 0) return;
    event.preventDefault();
    selected = {pageSlug: pageChoice.control.value, elementId: element.id};
    const startX = event.clientX;
    const startY = event.clientY;
    const start = {...element};
    const bounds = preview.getBoundingClientRect();
    const move = (moveEvent) => {
      const dx = Math.round((moveEvent.clientX - startX) * 1000 / bounds.width);
      const dy = Math.round((moveEvent.clientY - startY) * 1000 / bounds.height);
      const layout = rawLayout();
      const target = findSelected(layout);
      if (!target || layout.schemaVersion !== "opengeo.print-layout.1.1.0") return;
      if (mode === "move") {
        target.element.x = Math.max(0, Math.min(1000 - start.width, start.x + dx));
        target.element.y = Math.max(0, Math.min(1000 - start.height, start.y + dy));
      } else {
        target.element.width = Math.max(10, Math.min(1000 - start.x, start.width + dx));
        target.element.height = Math.max(10, Math.min(1000 - start.y, start.height + dy));
      }
      source.control.value = JSON.stringify(layout, null, 2);
      shell.style.left = `${target.element.x / 10}%`;
      shell.style.top = `${target.element.y / 10}%`;
      shell.style.width = `${target.element.width / 10}%`;
      shell.style.height = `${target.element.height / 10}%`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      renderPreview();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, {once: true});
  };
  const renderPreview = () => {
    preview.replaceChildren();
    try {
      const layout = parsedLayout();
      const priorPage = pageChoice.control.value;
      pageChoice.control.replaceChildren(...layout.pages.map((page) => {
        const option = text("option", page.sitePageSlug);
        option.value = page.sitePageSlug;
        return option;
      }));
      pageChoice.control.value = layout.pages.some((page) => page.sitePageSlug === priorPage)
        ? priorPage
        : layout.pages[0]?.sitePageSlug ?? "";
      const page = layout.pages.find(({sitePageSlug}) => sitePageSlug === pageChoice.control.value);
      if (!page) {
        selected = null;
        syncInspector(layout);
        preview.dataset.state = "valid";
        return;
      }
      for (const element of page.elements) {
        const shell = document.createElement("div");
        shell.className = `project-positioned-layout-frame ${element.type}`;
        shell.style.left = `${element.x / 10}%`;
        shell.style.top = `${element.y / 10}%`;
        shell.style.width = `${element.width / 10}%`;
        shell.style.height = `${element.height / 10}%`;
        shell.style.rotate = `${element.rotation ?? 0}deg`;
        shell.dataset.clip = String(element.clip ?? true);
        shell.dataset.selected = String(
          selected?.pageSlug === page.sitePageSlug && selected.elementId === element.id
        );
        const selectFrame = button(frameLabel(element), "project-positioned-layout-frame-select");
        selectFrame.ariaLabel = `Select and move ${element.id} ${frameLabel(element)}`;
        selectFrame.addEventListener("click", () => {
          selected = {pageSlug: page.sitePageSlug, elementId: element.id};
          renderPreview();
        });
        selectFrame.addEventListener("keydown", (event) => {
          const movement = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
          if (!movement) return;
          event.preventDefault();
          selected = {pageSlug: page.sitePageSlug, elementId: element.id};
          const step = event.shiftKey ? 1 : 10;
          editSelected((target) => {
            target.x = Math.max(0, Math.min(1000 - target.width, target.x + movement[0] * step));
            target.y = Math.max(0, Math.min(1000 - target.height, target.y + movement[1] * step));
          });
          renderPreview();
        });
        selectFrame.addEventListener("pointerdown", (event) => beginPointerEdit(event, element, shell, "move"));
        const resize = button("↘", "project-positioned-layout-resize");
        resize.ariaLabel = `Resize ${element.id}`;
        resize.addEventListener("pointerdown", (event) => beginPointerEdit(event, element, shell, "resize"));
        shell.append(selectFrame, resize);
        preview.append(shell);
      }
      preview.dataset.state = "valid";
      syncInspector(layout);
      feedback.textContent = `${layout.pages.length} positioned page${layout.pages.length === 1 ? "" : "s"} · ${layout.pages.reduce((sum, page) => sum + page.elements.length, 0)} frames`;
    } catch (error) {
      preview.dataset.state = "invalid";
      feedback.textContent = `Layout needs attention (${error?.message ?? "invalid_layout"}).`;
    }
  };
  starter.addEventListener("click", () => {
    const included = rows.filter((row) => row.include.checked);
    if (!included.length) {
      feedback.textContent = "Select at least one site page before creating a starter layout.";
      return;
    }
    source.control.value = JSON.stringify(starterPrintLayout(included), null, 2);
    selected = null;
    renderPreview();
  });
  importGeoMoose.addEventListener("click", () => importGeoMooseFile.click());
  importGeoMooseFile.addEventListener("change", async () => {
    const file = importGeoMooseFile.files?.[0];
    importGeoMooseFile.value = "";
    if (!file) return;
    try {
      if (file.size > GEOMOOSE_PRINT_CONVERSION_LIMITS.maximumBytes) {
        throw new TypeError("GeoMoose print layout is too large");
      }
      const mapRow = selectedRows().find((row) => row.resource.kind === "map");
      if (!mapRow) throw new TypeError("select a map page before importing a GeoMoose layout");
      const converted = convertGeoMoosePrintLayout(JSON.parse(await file.text()), {
        sitePageSlug: siteSlug(mapRow.resource.slug),
        mapResourceId: mapRow.resource.id,
        title: mapRow.resource.title,
        printedOn: new Date().toISOString()
      });
      writeLayout(converted.printLayout);
      printControls.printPageSize.control.value = converted.themeOptions.printPageSize;
      printControls.printOrientation.control.value = converted.themeOptions.printOrientation;
      printControls.printLayout.control.value = converted.themeOptions.printLayout;
      printControls.printLegend.control.checked = converted.themeOptions.printLegend === "true";
      printControls.printNorthArrow.control.checked = false;
      printControls.printScaleBar.control.checked = false;
      selected = null;
      renderPreview();
      const declaredDifferences = [
        ...converted.report.losses,
        ...converted.report.externalContextLosses
      ];
      const codes = [...new Set(declaredDifferences.map(({code}) => code))];
      const suffix = codes.length ? ` (${codes.join(", ")})` : "";
      feedback.textContent = [
        `${converted.report.sourceLabel} converted:`,
        `${converted.report.convertedElementCount}/${converted.report.sourceElementCount} elements retained;`,
        `${converted.report.omittedElementCount} omitted;`,
        `${declaredDifferences.length} declared differences${suffix}.`
      ].join(" ");
    } catch (error) {
      feedback.textContent = `GeoMoose layout was not imported (${error?.message ?? "invalid_layout"}).`;
    }
  });
  pageChoice.control.addEventListener("change", () => {
    selected = null;
    renderPreview();
  });
  apply.addEventListener("click", () => {
    try {
      editSelected((element) => {
        for (const name of ["x", "y", "width", "height", "rotation"]) {
          element[name] = controlValue(geometry[name]);
        }
        element.clip = clip.control.checked;
        if (["map_frame", "image_frame"].includes(element.type)) element.fit = fit.control.value;
      });
      renderPreview();
    } catch (error) {
      feedback.textContent = `Frame needs attention (${error?.message ?? "invalid_frame"}).`;
    }
  });
  const rotate = (delta) => {
    try {
      editSelected((element) => {
        element.rotation = Math.max(-180, Math.min(180, element.rotation + delta));
      });
      renderPreview();
    } catch (error) {
      feedback.textContent = `Frame needs attention (${error?.message ?? "invalid_frame"}).`;
    }
  };
  rotateLeft.addEventListener("click", () => rotate(-15));
  rotateRight.addEventListener("click", () => rotate(15));
  remove.addEventListener("click", () => {
    try {
      editSelected((element, page) => {
        if (element.type === "map_frame" && page.elements.some(
          (candidate) => candidate.mapFrameId === element.id
        )) throw new TypeError("delete frames bound to this map first");
        page.elements = page.elements.filter(({id}) => id !== element.id);
        if (!page.elements.length) throw new TypeError("a positioned page must retain one frame");
      });
      selected = null;
      renderPreview();
    } catch (error) {
      feedback.textContent = `Frame was not deleted (${error?.message ?? "invalid_frame"}).`;
    }
  });
  const suggestedBinding = () => {
    let layout;
    try {
      layout = parsedLayout();
    } catch {
      return "";
    }
    const page = layout.pages.find(({sitePageSlug}) => sitePageSlug === pageChoice.control.value);
    const type = addType.control.value;
    if (type === "text") return "New print content";
    if (["source_panel", "north_arrow", "scale_bar", "legend_frame"].includes(type)) {
      return page?.elements.find((element) => element.type === "map_frame")?.id ?? "map_1";
    }
    if (type === "map_frame") {
      return selectedRows().find((row) => row.resource.kind === "map")?.resource.id ?? "";
    }
    const blockType = type.replace("_frame", "");
    const row = selectedRows().find(
      (candidate) => siteSlug(candidate.resource.slug) === pageChoice.control.value
    );
    return row?.resource.content?.blocks?.find((block) => block.type === blockType)?.id ?? "";
  };
  const updateSuggestedBinding = () => {
    addBinding.control.value = suggestedBinding();
  };
  addType.control.addEventListener("change", updateSuggestedBinding);
  pageChoice.control.addEventListener("change", updateSuggestedBinding);
  addFrame.addEventListener("click", () => {
    try {
      const layout = rawLayout();
      if (layout.schemaVersion !== "opengeo.print-layout.1.1.0") {
        throw new TypeError("new rich frames require the 1.1 layout");
      }
      let page = layout.pages.find(({sitePageSlug}) => sitePageSlug === pageChoice.control.value);
      if (!page) {
        const pageSlug = selectedRows()[0] && siteSlug(selectedRows()[0].resource.slug);
        if (!pageSlug) throw new TypeError("select a site page first");
        page = {sitePageSlug: pageSlug, elements: []};
        layout.pages.push(page);
      }
      const type = addType.control.value;
      const binding = addBinding.control.value.trim();
      const stem = type.replace("_frame", "");
      let number = 1;
      while (page.elements.some(({id}) => id === `${stem}_${number}`)) number += 1;
      const element = {
        id: `${stem}_${number}`,
        type,
        x: Math.min(700, 40 + page.elements.length * 20),
        y: Math.min(700, 40 + page.elements.length * 20),
        width: type === "text" ? 500 : 300,
        height: type === "text" ? 100 : 240,
        rotation: 0,
        clip: true
      };
      if (type === "text") Object.assign(element, {text: binding || "New print content", style: "body"});
      else if (type === "map_frame") Object.assign(element, {resourceId: binding, fit: "contain"});
      else if (type === "image_frame") Object.assign(element, {blockId: binding, fit: "contain"});
      else if (["table_frame", "chart_frame"].includes(type)) element.blockId = binding;
      else element.mapFrameId = binding;
      page.elements.push(element);
      writeLayout(layout);
      selected = {pageSlug: page.sitePageSlug, elementId: element.id};
      renderPreview();
    } catch (error) {
      feedback.textContent = `Frame was not added (${error?.message ?? "invalid_frame"}).`;
    }
  });
  source.control.addEventListener("input", renderPreview);
  fieldset.append(
    starter,
    importGeoMoose,
    importGeoMooseFile,
    addControls,
    preview,
    inspector,
    source.label,
    feedback
  );
  renderPreview();
  return {
    element: fieldset,
    value(pages) {
      const raw = source.control.value.trim();
      return parseSitePrintLayout(
        raw ? JSON.parse(raw) : {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
        new Set(pages.map((page) => page.slug))
      );
    }
  };
}

function starterPrintLayout(selectedRows) {
  const first = selectedRows[0];
  const maps = selectedRows.filter((row) => row.resource.kind === "map").slice(0, 2);
  const elements = [
    {
      id: "page_title",
      type: "text",
      x: 40,
      y: 30,
      width: 920,
      height: 80,
      rotation: 0,
      clip: true,
      text: first.resource.title,
      style: "title"
    }
  ];
  if (!maps.length) {
    elements.push({
      id: "page_note",
      type: "text",
      x: 40,
      y: 150,
      width: 920,
      height: 700,
      rotation: 0,
      clip: true,
      text: first.resource.abstract ?? "Positioned narrative page",
      style: "body"
    });
  } else {
    maps.forEach((row, index) => {
      elements.push({
        id: `map_${index + 1}`,
        type: "map_frame",
        x: maps.length === 1 ? 40 : 40 + index * 460,
        y: 140,
        width: maps.length === 1 ? 700 : 440,
        height: 650,
        rotation: 0,
        clip: true,
        resourceId: row.resource.id,
        fit: "contain"
      });
    });
    elements.push(
      {
        id: "sources",
        type: "source_panel",
        x: maps.length === 1 ? 760 : 40,
        y: maps.length === 1 ? 390 : 815,
        width: maps.length === 1 ? 200 : 500,
        height: maps.length === 1 ? 180 : 120,
        rotation: 0,
        clip: true,
        mapFrameId: "map_1"
      },
      {
        id: "legend",
        type: "legend_frame",
        x: maps.length === 1 ? 760 : 560,
        y: maps.length === 1 ? 140 : 815,
        width: maps.length === 1 ? 200 : 120,
        height: maps.length === 1 ? 220 : 120,
        rotation: 0,
        clip: true,
        mapFrameId: "map_1"
      },
      {
        id: "north",
        type: "north_arrow",
        x: maps.length === 1 ? 800 : 700,
        y: maps.length === 1 ? 600 : 815,
        width: 80,
        height: 110,
        rotation: 0,
        clip: true,
        mapFrameId: "map_1"
      },
      {
        id: "scale",
        type: "scale_bar",
        x: maps.length === 1 ? 760 : 780,
        y: maps.length === 1 ? 730 : 830,
        width: 200,
        height: 90,
        rotation: 0,
        clip: true,
        mapFrameId: "map_1"
      }
    );
  }
  return {
    schemaVersion: "opengeo.print-layout.1.1.0",
    pages: [{sitePageSlug: siteSlug(first.resource.slug), elements}]
  };
}

function printableMapResourceIds(site) {
  const references = site.activeEdition?.manifest?.references;
  if (!Array.isArray(references)) return [];
  return references
    .filter((reference) => (
      reference
      && typeof reference === "object"
      && typeof reference.resourceId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(reference.resourceId)
      && reference.snapshot
      && typeof reference.snapshot === "object"
    ))
    .map((reference) => reference.resourceId);
}

function labeledTextarea(labelText, value, maxLength, placeholder) {
  const label = document.createElement("label");
  label.append(text("span", labelText));
  const control = document.createElement("textarea");
  control.value = value;
  control.maxLength = maxLength;
  control.rows = 3;
  control.placeholder = placeholder;
  label.append(control);
  return {label, control};
}

function parseSnapshotBindings(value) {
  const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 16) throw new TypeError("at most 16 map snapshots may be sealed");
  return lines.map((line) => {
    const parts = line.split("=").map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new TypeError("snapshot bindings must use resource UUID = render job UUID");
    }
    return {resourceId: parts[0], renderJobId: parts[1]};
  });
}

function button(label, className = "platform-button") {
  const control = text("button", label, className);
  control.type = "button";
  return control;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
