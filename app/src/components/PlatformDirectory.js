import {StyleLibrary} from "./StyleLibrary.js";
import {AccountNavigation} from "./AccountNavigation.js";
import {AccountWorkDownload} from "./AccountWorkDownload.js";
import {catalogSaveBlocksNavigation} from "../lib/catalogSaveNavigation.js";
import {CatalogPlaceMatch} from "./CatalogPlaceMatch.js";
import {CatalogPreservationStatus} from "./CatalogPreservationStatus.js";
import {CatalogResourceMapAction} from "./CatalogResourceMapAction.js";
import {placeIdentity} from "../lib/geographicReferences.js";
import {geojsonBounds} from "../lib/mapLayers.js";
import {catalogSpatialStatus} from "../lib/catalogSpatialStatus.js";
import {CatalogLocationBounds} from "./CatalogLocationBounds.js";
import {LocationDirectory} from "./LocationDirectory.js";
import {CollectionDirectory} from "./CollectionDirectory.js";
import {CompositionDirectory} from "./CompositionDirectory.js";
import {isRetainedTestRecord} from "../lib/retainedTestRecords.js";
import {loadDirectorySupplements, failureState} from "../lib/platform.js";
import {emptyMapDefinition} from "../lib/mapDefinition.js";
import {InstanceCatalog} from "./InstanceCatalog.js";
import {DirectoryLoading} from "./DirectoryLoading.js";
import {PublicationWorkspaceDirectory} from "./PublicationWorkspaceDirectory.js";
import {createCatalogPreviewLoader} from "../lib/catalogLayerPreview.js";
import {LayerCatalogResults} from "./LayerCatalogResults.js";
import {StaticItemSearch} from "./StaticItemSearch.js";
import {StaticItemCatalogRegistration} from "./StaticItemCatalogRegistration.js";
import {CatalogSourceRegistration} from "./CatalogSourceRegistration.js";
import {CkanCatalog} from "./CkanCatalog.js";
import {StudioNavigation} from "./StudioNavigation.js";
import {publicationFormats, publicationStarter, publicationFormatEnabled} from "../lib/publicationDrafts.js";
import {platformStatePanel} from "./PlatformStatePanel.js";
import {retainedPublicationIdentity, retainedEditorIdentityStatus} from "../lib/retainedProjectScope.js";
export {platformStatePanel} from "./PlatformStatePanel.js";
import {
  directoryHref as applicationDirectoryHref,
  layerHref,
  compositionHref,
  publicationHref,
  projectHref as applicationProjectHref
} from "../lib/applicationRoutes.js";
import {
  SOURCE_OPERATIONS,
  filterSourceCapabilities,
  sourceCapabilitySections,
  sourceCapabilitySummary
} from "../lib/sourceCapabilityCatalog.js";

export function PlatformDirectory({
  adapter,
  auth = null,
  deployment = null,
  federation = [],
  view = null,
  publicResourceTarget = null,
  publicCatalog = null,
  navigationManagedExternally = false,
  initialDirectory = null,
  initialIdentity = null
}) {
  const root = document.createElement("section");
  root.className = "platform-surface platform-directory";
  // Announce concise status regions rather than the entire interactive workspace.
  let activeView = directoryView(view);
  let refreshGeneration = 0;
  let pendingLoading = null;
  let pendingAreaRead = null;
  let directoryCore = initialDirectory?.status === 'ready' && initialDirectory.adapter === adapter && initialIdentity
    ? initialDirectory : null;
  let coreIdentity = directoryCore ? initialIdentity : null;
  let coreLoadedAt = 0;
  const browser = root.ownerDocument.defaultView;
  const directoryPath = "/workspaces";
  root.shouldBlockNavigation = () => catalogSaveBlocksNavigation(root)
    || Boolean(root.catalogDirectory?.shouldBlockNavigation?.())
    || Boolean(root.resourceDirectory?.shouldBlockNavigation());
  const navigate = target => {
    view = target.searchParams.get("view");
    activeView = directoryView(view);
    void refresh({reuseCore: true});
  };
  root.navigateTo = navigate;
  root.addEventListener("click", event => {
    if (navigationManagedExternally) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a");
    if (!link || link.target || link.hasAttribute("download")) return;
    const target = new URL(link.href, browser.location.href), current = new URL(browser.location.href);
    // Only directory view changes. Projects, new-item flows, sign-in and other
    // origins keep ordinary navigation. Never persist account data in storage.
    if (target.origin !== current.origin || target.pathname !== current.pathname || target.hash
      || target.searchParams.has("project") || current.searchParams.has("project")) return;
    const allowed = new Set(["view", "adapter", "collection", "location", "place", "bbox", "areaName", "areaRevision", "projectContext"]);
    if ([...target.searchParams.keys(), ...current.searchParams.keys()].some(key => !allowed.has(key))
      || target.searchParams.get("adapter") !== current.searchParams.get("adapter")) return;
    event.preventDefault();
    if (catalogSaveBlocksNavigation(root) || root.catalogDirectory?.shouldBlockNavigation?.()) return;
    if (root.resourceDirectory?.shouldBlockNavigation()) {
      root.resourceDirectory.querySelector('[role="status"]').textContent = "Save or discard your draft before changing views.";
      return;
    }
    browser.history.pushState(null, "", target);
    navigate(target);
  });
  const onPopState = () => {
    if (browser.location.pathname !== directoryPath || root.hidden) return;
    if (catalogSaveBlocksNavigation(root, {restoreUrl: true})
      || root.catalogDirectory?.shouldBlockNavigation?.({restoreUrl: true})) return;
    if (root.resourceDirectory?.shouldBlockNavigation()) {
      browser.history.pushState(null, "", root.resourceDirectory.currentHref());
      root.resourceDirectory.querySelector('[role="status"]').textContent = "Save or discard your draft before changing views.";
      return;
    }
    navigate(new URL(browser.location.href));
  };
  if (!navigationManagedExternally) browser.addEventListener("popstate", onPopState);
  root.dispose = () => {
    ++refreshGeneration; pendingLoading?.dispose(); directoryCore = null; coreIdentity = null;
    pendingAreaRead?.abort(); pendingAreaRead = null;
    root.disposeDirectoryNavigation?.();
    root.accountWorkDownload?.dispose();
    root.catalogDirectory?.dispose();
    root.accessDirectory?.dispose();
    root.compositionDirectory?.dispose();
    root.resourceDirectory?.dispose();
    browser.removeEventListener("popstate", onPopState);
  };
  void refresh({reuseCore: Boolean(directoryCore)});
  return root;

  async function refresh({reuseCore = false} = {}) {
    if (catalogSaveBlocksNavigation(root) || root.catalogDirectory?.shouldBlockNavigation?.()) return;
    if (root.resourceDirectory?.shouldBlockNavigation()) {
      root.resourceDirectory.querySelector('[role="status"]').textContent = "Save or discard your draft before refreshing.";
      return;
    }
    const generation = ++refreshGeneration;
    pendingAreaRead?.abort(); pendingAreaRead = null;
    const needsAccessInventory = ["access", "data", "sources", "teams", "styles"].includes(activeView)
      || Boolean(newProjectIntent());
    let returningInventory = null;
    let state;
    // Nonbrowser adapters without identity retain their original short reuse
    // window. Real mounted sessions always check current membership on return.
    if (reuseCore && directoryCore && !coreIdentity
      && Date.now() - coreLoadedAt < 30_000) state = directoryCore;
    else {
      const retainedDirectory = reuseCore ? directoryCore : null;
      const retainedIdentity = reuseCore ? coreIdentity : null;
      if (retainedDirectory && retainedIdentity && needsAccessInventory) {
        const controller = new AbortController(); pendingAreaRead = controller;
        returningInventory = (async () => {
          const before = await retainedEditorIdentityStatus(adapter, retainedIdentity);
          controller.signal.throwIfAborted();
          if (before || generation !== refreshGeneration) throw Object.assign(Error('Account changed'), {status: 403});
          const projects = await adapter.listProjects({limit: 100, signal: controller.signal});
          controller.signal.throwIfAborted();
          const after = await retainedEditorIdentityStatus(adapter, retainedIdentity);
          if (after || generation !== refreshGeneration) throw Object.assign(Error('Account changed'), {status: 403});
          return {projects};
        })().catch(error => ({error}));
      }
      directoryCore = null;
      coreIdentity = null;
      // Changing areas must not cancel an account request that is already waking
      // the service. Explicit refresh still starts a fresh authorization check.
      if (!reuseCore) pendingLoading?.dispose();
      const loading = reuseCore && pendingLoading ? pendingLoading : DirectoryLoading({adapter, includeProjects: false,
        retainedDirectory, retainedIdentity, navigationLabel: activeView === 'publishing' ? 'Publications'
          : activeView.charAt(0).toUpperCase() + activeView.slice(1)});
      pendingLoading = loading;
      root.accountWorkDownload?.dispose(); root.accountWorkDownload = null;
      root.compositionDirectory?.dispose();
      root.catalogDirectory?.dispose();
      root.accessDirectory?.dispose(); root.accessDirectory = null;
      root.resourceDirectory?.dispose();
      root.compositionDirectory = null;
      root.replaceChildren(StudioNavigation({adapterKind: adapter?.kind, active: activeView}), loading.element);
      state = await loading.result;
      if (pendingLoading === loading) pendingLoading = null;
      if (generation === refreshGeneration && state.status === "ready") {
        const identity = retainedIdentity ?? await retainedPublicationIdentity(adapter);
        if (generation !== refreshGeneration) return;
        if (identity && identity.organization !== state.organization.id) {
          state = {status: 'forbidden', adapter};
        } else {
          directoryCore = state; coreIdentity = identity; coreLoadedAt = Date.now();
        }
      }
    }
    if (generation !== refreshGeneration) return;
    // Independent account resources do not need the legacy access-container
    // inventory. Styles still uses that inventory to choose a data library.
    if (state.status === "ready" && !state.accessInventoryLoaded && needsAccessInventory) {
      try {
        const inventory = returningInventory ? await returningInventory : {projects: await adapter.listProjects({limit: 100})};
        if (inventory.error) throw inventory.error;
        const projects = inventory.projects;
        if (generation !== refreshGeneration) return;
        state = {...state, projects: [...new Map(projects.map(project => [project.id, project])).values()],
          accessInventoryLoaded: true, accessProjectPagination: {offset: projects.length, hasMore: projects.length === 100}};
        directoryCore = state;
      } catch (error) {state = failureState(error, adapter, "directory");}
    }
    if (generation !== refreshGeneration) return;
    if (state.status !== "ready") {
      pendingAreaRead?.abort(); pendingAreaRead = null;
      if (activeView === "data" && state.status === "unauthenticated") {
        root.replaceChildren(InstanceCatalog({publicCatalog: deployment?.mode === "demo" ? publicCatalog : null, auth}));
        return;
      }
      renderDirectoryState(root, state, refresh, auth, {
        deployment,
        federation,
        view,
        publicResourceTarget
      });
      return;
    }
    if (activeView === "projects" && !newProjectIntent()) {
      renderDirectoryState(root, {...state, directoryDetailsLoading: false}, refresh, auth,
        {deployment, federation, view, publicResourceTarget});
      return;
    }
    if (activeView === "access") state.accessDirectoryInventory ??= {
      rows: state.projects.slice(), page: {...state.accessProjectPagination}, appliedFilter: null, draft: {q: "", status: "active"}
    };
    const essentialState = {...state, directoryDetailsLoading: true};
    const creationDraft = renderDirectoryState(root, essentialState, refresh, auth, {
      deployment,
      federation,
      view,
      publicResourceTarget
    });
    const creationIdentity = creationDraft ? coreIdentity : null;
    const completeState = await loadDirectorySupplements(adapter, essentialState, {view: activeView});
    if (generation !== refreshGeneration) return;
    if (creationIdentity) {
      let identityStatus;
      try {identityStatus = await retainedEditorIdentityStatus(adapter, creationIdentity);}
      catch {identityStatus = "forbidden";}
      if (generation !== refreshGeneration) return;
      if (identityStatus) {
        directoryCore = null; coreIdentity = null;
        renderDirectoryState(root, {status: identityStatus, adapter}, refresh, auth,
          {deployment, federation, view, publicResourceTarget});
        return;
      }
    }
    const currentSearch = root.querySelector('.platform-project-directory input[type="search"]');
    const searchValue = currentSearch?.value ?? "";
    const searchHadFocus = currentSearch === document.activeElement;
    const projectStatus = root.querySelector('.platform-project-directory select[aria-label="Access workspace status"]')?.value;
    renderDirectoryState(
      root,
      {...completeState, directoryDetailsLoading: false},
      refresh,
      auth,
      {deployment, federation, view, publicResourceTarget, creationDraft}
    );
    const nextSearch = root.querySelector('.platform-project-directory input[type="search"]');
    if (nextSearch && searchValue) {
      nextSearch.value = searchValue;
      nextSearch.dispatchEvent(new nextSearch.ownerDocument.defaultView.Event("input"));
    }
    if (nextSearch && searchHadFocus) nextSearch.focus({preventScroll: true});
    const nextStatus = root.querySelector('.platform-project-directory select[aria-label="Access workspace status"]');
    if (nextStatus && projectStatus) {
      nextStatus.value = projectStatus;
      nextStatus.dispatchEvent(new nextStatus.ownerDocument.defaultView.Event("change"));
    }
  }
}

export function renderDirectoryState(
  root,
  state,
  retry,
  auth = null,
  {deployment = null, federation = [], view = null, publicResourceTarget = null, creationDraft = null} = {}
) {
  const creationFocus = creationDraft?.panel.contains(root.ownerDocument.activeElement)
    ? root.ownerDocument.activeElement : null;
  root.disposeDirectoryNavigation?.();
  root.disposeDirectoryNavigation = null;
  root.accountWorkDownload?.dispose();
  root.accountWorkDownload = null;
  root.catalogDirectory?.dispose();
  root.catalogDirectory = null;
  root.accessDirectory?.dispose();
  root.accessDirectory = null;
  root.resourceDirectory?.dispose();
  root.resourceDirectory = null;
  root.replaceChildren(StudioNavigation({adapterKind: state.adapter?.kind, active: directoryView(view)}), modeBanner(state.adapter));
  if (state.status !== "ready") {
    root.append(platformStatePanel(state, retry, {auth, autoSignIn: true}));
    return;
  }
  root.disposeDirectoryNavigation = dismissDirectoryNavigation(root);

  const activeView = directoryView(view);
  const viewCopy = directoryViewCopy(activeView, state);
  const heading = document.createElement("header");
  heading.className = "platform-heading";
  const headingCopy = document.createElement("div");
  headingCopy.append(
    text("p", state.organization.name, "platform-eyebrow"),
    text("h1", viewCopy.title),
    text(
      "p",
      viewCopy.description,
      "platform-subtitle"
    )
  );
  const identity = document.createElement("div");
  identity.className = "platform-directory-identity";
  identity.append(
    deploymentSwitcher(deployment, federation),
    text("strong", state.session.displayName),
    badge(state.organization.callerRole)
  );
  if ((state.session.memberships?.length ?? 0) > 1 && typeof state.adapter.selectOrganization === "function") {
    const accounts = document.createElement("select");
    accounts.setAttribute("aria-label", "Studio account");
    for (const membership of state.session.memberships) {
      const option = document.createElement("option");
      option.value = membership.organizationId;
      option.textContent = membership.organizationId === state.organization.id
        ? state.organization.name : `${membership.organizationId} · ${membership.role}`;
      accounts.append(option);
    }
    accounts.value = state.organization.id;
    const accountStatus = text("p", ""); accountStatus.setAttribute("role", "status");
    accounts.addEventListener("change", () => {
      if (catalogSaveBlocksNavigation(root) || root.catalogDirectory?.shouldBlockNavigation?.()) {accounts.value = state.organization.id; return;}
      if (root.resourceDirectory?.shouldBlockNavigation()) {
        accounts.value = state.organization.id;
        root.resourceDirectory.querySelector('[role="status"]').textContent = "Save or discard your draft before switching accounts.";
        return;
      }
      const next = accounts.value;
      if (!state.session.memberships.some(member => member.organizationId === next)) return;
      try {
        state.adapter.selectOrganization(next);
      } catch {
        accounts.value = state.organization.id;
        accountStatus.textContent = "The account could not be selected. Please retry.";
        return;
      }
      // Clear the old account view before loading any data for the new account.
      root.accountWorkDownload?.dispose(); root.accountWorkDownload = null;
      root.accessDirectory?.dispose(); root.accessDirectory = null;
      root.resourceDirectory?.dispose(); root.resourceDirectory = null;
      root.compositionDirectory?.dispose(); root.compositionDirectory = null;
      const browser = root.ownerDocument.defaultView;
      const target = new URL(browser.location.href);
      for (const key of ["collection", "location", "place", "bbox", "areaName", "areaRevision"]) target.searchParams.delete(key);
      browser.history.replaceState(null, "", target);
      root.replaceChildren(text("p", "Opening selected account…"));
      void retry();
    });
    identity.append(accounts, accountStatus);
  }
  {
    const account = document.createElement("details");
    account.className = "platform-account-menu";
    const accountBody = document.createElement("div");
    accountBody.className = "platform-account-menu-body";
    account.append(text("summary", "Account settings"));
    if (!["sources", "teams", "access"].includes(activeView)) {
      accountBody.append(AccountNavigation({adapterKind: state.adapter?.kind, admin: state.organization.callerRole === "admin"}));
    }
    if (typeof state.adapter?.listProjects === "function"
      && typeof state.adapter?.listObservableSourceProjects === "function") {
      const downloads = AccountWorkDownload({adapter: state.adapter, accountId: state.organization.id,
        ownerUserId: state.session.userId, accountName: state.organization.name,
        isCurrent: () => root.accountWorkDownload === downloads && root.contains(downloads)});
      root.accountWorkDownload = downloads;
      accountBody.append(downloads);
    }
    account.append(accountBody);
    identity.append(account);
  }
  if (auth && state.adapter?.kind !== "fixture") {
    const signOut = action("Sign out", async () => {
      if (catalogSaveBlocksNavigation(root) || root.catalogDirectory?.shouldBlockNavigation?.()) return;
      if (root.resourceDirectory?.shouldBlockNavigation()) {
        root.resourceDirectory.querySelector('[role="status"]').textContent = "Save or discard your draft before signing out.";
        return;
      }
      signOut.disabled = true;
      signOut.textContent = "Signing out…";
      root.accountWorkDownload?.dispose(); root.accountWorkDownload = null;
      await auth.signOut();
    });
    signOut.classList.add("platform-button-secondary");
    signOut.dataset.action = "sign-out";
    identity.append(signOut);
  }
  heading.append(headingCopy, identity);

  const resourceNavigation = directoryResourceNavigation(state, activeView);
  const primaryActions = directoryActions(state, activeView);
  const projectDirectory = document.createElement("section");
  projectDirectory.className = "platform-project-directory";
  projectDirectory.id = "projects";
  const projectDirectoryHeading = document.createElement("header");
  projectDirectoryHeading.className = "platform-project-directory-heading";
  const inventorySummary = text("p", "", "platform-note");
  projectDirectoryHeading.append(
    text("h2", "Data access"),
    inventorySummary
  );
  const controls = document.createElement("form");
  controls.className = "platform-controls";
  const search = document.createElement("input");
  search.type = "search";
  search.maxLength = 200;
  search.placeholder = "Search access workspaces or clients";
  search.ariaLabel = "Search access workspaces or clients";
  const status = document.createElement("select");
  status.ariaLabel = "Access workspace status";
  status.append(option("active", "Active workspaces"), option("archived", "Archived workspaces"), option("all", "All workspaces"));
  controls.append(search, status);
  const testing = document.createElement("input"); testing.type = "checkbox"; testing.ariaLabel = "Show testing workspaces";
  const testingLabel = text("label", "Show testing workspaces"); testingLabel.prepend(testing); controls.append(testingLabel);

  const content = document.createElement("div");
  content.className = "platform-project-directory-results";
  content.ariaLive = "polite";
  const inventory = activeView === "access" ? (state.accessDirectoryInventory ??= {
    rows: state.projects.slice(), page: {...(state.accessProjectPagination ?? {offset: state.projects.length, hasMore: state.projects.length === 100})},
    appliedFilter: null, draft: {q: "", status: "active"}
  }) : null;
  if (inventory) {search.value = inventory.draft.q; status.value = inventory.draft.status;}
  let visibleProjects = inventory?.rows ?? state.projects.slice(), appliedFilter = inventory?.appliedFilter ?? null;
  const renderProjects = () => {
    inventorySummary.textContent = `${visibleProjects.length} data access containers loaded · shared data, membership and settings`;
    const needle = search.value.trim().toLowerCase();
    const clients = new Map((state.clients ?? []).map((client) => [client.id, client]));
    const matches = visibleProjects.filter((project) => {
      if (!testing.checked && isRetainedTestRecord(project)) return false;
      if (appliedFilter) return true;
      const client = clients.get(project.clientId);
      const searchable = `${project.name} ${project.description ?? ""} ${project.projectCode ?? ""} ${client?.name ?? ""}`.toLowerCase();
      return (!needle || searchable.includes(needle))
        && (status.value === "all" || project.status === status.value);
    });
    content.replaceChildren(projectTable(matches, clients, state.adapter?.kind));
  };
  search.addEventListener("input", renderProjects);
  status.addEventListener("change", renderProjects);
  testing.addEventListener("change", renderProjects);
  projectDirectory.append(projectDirectoryHeading, controls, content);
  if (activeView === "access" && typeof state.adapter?.listProjects === "function") {
    let page = inventory.page;
    const saveInventory = () => {
      Object.assign(inventory, {rows: visibleProjects, page, appliedFilter, draft: {q: search.value, status: status.value}});
    };
    const feedback = text("p", "", "platform-note"); feedback.setAttribute("role", "status");
    let disposed = false, controller = null;
    root.accessDirectory = projectDirectory;
    projectDirectory.dispose = () => {disposed = true; controller?.abort();};
    const current = () => !disposed && root.accessDirectory === projectDirectory && root.contains(projectDirectory);
    const describePage = () => {
      feedback.textContent = `${visibleProjects.length} workspaces loaded. `
        + (appliedFilter ? "Results use the last submitted search and status. " : "Search and status filter loaded rows until you submit Search. ")
        + (page.hasMore ? "Load more to include later results." : page.offset > 10_000
          ? "The directory limit is reached; narrow your search." : "All available results loaded.");
      if (page.hasMore && !more.parentNode) controls.append(more);
      if (!page.hasMore) more.remove();
    };
    const unique = records => [...new Map(records.map(project => [project.id, project])).values()];
    const submitSearch = async () => {
      if (!current()) return;
      const q = search.value.trim(), selectedStatus = status.value;
      if (q.length > 200) {feedback.textContent = "Use at most 200 characters to search."; return;}
      controller?.abort();
      const request = new AbortController(); controller = request;
      more.disabled = true; feedback.textContent = "Searching authorized access workspaces… Current rows remain available.";
      try {
        const records = await state.adapter.listProjects({q, status: selectedStatus, limit: 100, offset: 0, signal: request.signal});
        if (!current() || request.signal.aborted || controller !== request) return;
        appliedFilter = {q, status: selectedStatus};
        visibleProjects = unique(records);
        page = {offset: records.length, hasMore: records.length === 100};
        saveInventory();
        renderProjects(); describePage();
      } catch {
        if (current() && !request.signal.aborted && controller === request) {
          feedback.textContent = `${visibleProjects.length} workspaces retained. Search could not load. Submit Search to retry.`;
        }
      } finally {
        if (controller === request) {controller = null; if (current()) more.disabled = false;}
      }
    };
    const submit = document.createElement("button"); submit.type = "submit";
    submit.className = "platform-button"; submit.textContent = "Search";
    submit.setAttribute("aria-label", "Search authorized access workspaces");
    const clear = action("Clear search", () => {search.value = ""; status.value = "active"; void submitSearch();});
    clear.setAttribute("aria-label", "Clear access workspace search");
    controls.append(submit, clear);
    controls.addEventListener("submit", event => {event.preventDefault(); void submitSearch();});
    search.addEventListener("search", () => {if (!search.value && appliedFilter?.q) void submitSearch();});
    for (const [control, event] of [[search, "input"], [status, "change"]]) {
      control.addEventListener(event, () => {
        saveInventory();
        if (!controller) feedback.textContent = "Submit Search to search all authorized workspaces with this text and status.";
      });
    }
    const more = action("Load more", async () => {
      if (controller || !page.hasMore || page.offset > 10_000 || !current()) return;
      const hadFocus = more.ownerDocument.activeElement === more;
      const request = new AbortController(); controller = request;
      more.disabled = true; feedback.textContent = "Loading more access workspaces…";
      try {
        const records = await state.adapter.listProjects({...(appliedFilter ?? {}), limit: 100, offset: page.offset, signal: request.signal});
        if (!current() || request.signal.aborted || controller !== request) return;
        visibleProjects = unique([...visibleProjects, ...records]);
        page.offset += records.length;
        page.hasMore = records.length === 100 && page.offset <= 10_000;
        saveInventory();
        const restoreFocus = hadFocus && [more, more.ownerDocument.body].includes(more.ownerDocument.activeElement);
        renderProjects(); describePage();
        if (restoreFocus && !page.hasMore) submit.focus({preventScroll: true});
      } catch {
        if (current() && !request.signal.aborted && controller === request) {
          feedback.textContent = `${visibleProjects.length} workspaces retained. More workspaces could not load. Use Load more to retry.`;
        }
      } finally {
        if (controller === request) {controller = null; if (current()) more.disabled = false;}
      }
    });
    more.setAttribute("aria-label", "Load more access workspaces");
    controls.append(more); projectDirectory.append(feedback); describePage();
  }

  const dataCatalog = organizationCatalog(state, {
    autoload: activeView === "data" && !state.directoryDetailsLoading,
    publicResourceTarget
  });
  root.catalogDirectory = dataCatalog;
  dataCatalog.id = "data";
  const teams = teamsPanel(state, {open: activeView === "teams"});
  const connections = datasetConnectionsPanel(state, {open: activeView === "sources"});

  const creationIntent = newProjectIntent();
  // Publishing supplements populate the directory, not this private form.
  // Keep its inputs and creation guards through this refresh's final render.
  const creationReady = !state.directoryDetailsLoading
    || activeView === "publishing" && creationIntent === "publication" && state.accessInventoryLoaded;
  const retainCreation = activeView === "publishing" && creationIntent === "publication"
    && creationDraft?.root === root && creationDraft.intent === creationIntent
    && creationDraft.adapter === state.adapter && Boolean(state.session.userId)
    && creationDraft.userId === state.session.userId && creationDraft.organizationId === state.organization.id
    && creationDraft.callerRole === state.organization.callerRole;
  const creation = creationIntent
    ? !creationReady
      ? projectCreationLoadingPanel(creationIntent)
      : retainCreation ? creationDraft.panel : projectCreationPanel(state, retry, creationIntent)
    : null;
  root.append(heading);
  if (["sources", "teams", "access"].includes(activeView)) root.append(resourceNavigation);
  if (activeView === "projects") {
    root.compositionDirectory = CompositionDirectory({adapter: state.adapter, loading: state.directoryDetailsLoading});
    root.append(primaryActions, ...(creation ? [creation] : []), root.compositionDirectory);
  } else if (activeView === "styles") {
    if (state.directoryDetailsLoading) root.append(text("p", "Loading Styles…"));
    else {root.resourceDirectory = StyleLibrary({adapter: state.adapter, containers: state.projects}); root.append(root.resourceDirectory);}
  } else if (activeView === "access") {
    root.append(projectDirectory);
  } else if (activeView === "data") {
    root.append(dataCatalog);
  } else if (activeView === "sources") {
    root.append(connections);
  } else if (activeView === "locations") {
    if (state.directoryDetailsLoading) root.append(text("p", "Loading account…"));
    else {
      const geographicSearch = (mode, saved) => {
        if (root.shouldBlockNavigation()) return;
        const target = new URL(applicationDirectoryHref({view:"data",adapterKind:state.adapter.kind}), root.ownerDocument.defaultView.location.href);
        if (mode === "tags") target.searchParams.set("place", placeIdentity(saved.document.canonical_uri));
        else {
          const bounds = geojsonBounds(saved.document.geometry);
          if (!bounds) return;
          target.searchParams.set("bbox", bounds.flat().join(","));
          target.searchParams.set("areaName", saved.document.title);
          target.searchParams.set("areaRevision", String(saved.revision));
        }
        root.ownerDocument.defaultView.history.pushState(null,"",target);
        root.navigateTo(target);
      };
      root.resourceDirectory = LocationDirectory({adapter: state.adapter,
        onSearchTaggedLayers:saved=>geographicSearch("tags",saved),
        onUseSavedSearchArea:saved=>geographicSearch("area",saved)});
      root.append(root.resourceDirectory);
    }
  } else if (activeView === "collections") {
    if (state.directoryDetailsLoading) root.append(text("p", "Loading account…"));
    else {
      root.resourceDirectory = CollectionDirectory({adapter: state.adapter});
      root.collectionDirectory = root.resourceDirectory;
      root.append(root.resourceDirectory);
    }
  } else if (activeView === "publishing") {
    root.append(primaryActions, ...(creation ? [creation] : []));
    root.append(PublicationWorkspaceDirectory({records: state.publicationWorkspaces,
      editions: state.publicSiteDirectory?.records ?? [], apiBase: state.adapter?.baseUrl ?? "/api",
      adapterKind: state.adapter?.kind, loading: state.directoryDetailsLoading,
      projectContext: (() => {const id = new URL(root.ownerDocument.defaultView.location.href).searchParams.get("projectContext"); return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? "") ? id : null;})(),
      loadPage: typeof state.adapter.listPublicationWorkspaces === "function"
        ? page => state.adapter.listPublicationWorkspaces(page) : null}));
  } else {
    root.append(teams);
  }
  if (state.directoryWarnings?.length) {
    const labels = state.directoryWarnings.map(({label}) => label).join(", ");
    const warning = text(
      "p",
      `Your projects are available. Some supporting account data could not be loaded: ${labels}. Retry to restore those controls.`,
      "platform-note platform-directory-warning"
    );
    warning.setAttribute("role", "status");
    root.append(warning);
  }
  if (state.clientsRestricted) {
    root.append(text("p", "Client names are hidden for this organization role; assigned projects remain available.", "platform-note"));
  }
  renderProjects();
  if (creation === creationDraft?.panel && creationFocus?.isConnected) creationFocus.focus({preventScroll: true});
  return activeView === "publishing" && creationIntent === "publication" && creationReady
    ? {root, panel: creation, intent: creationIntent, adapter: state.adapter, userId: state.session.userId,
        organizationId: state.organization.id, callerRole: state.organization.callerRole}
    : null;
}

function projectCreationLoadingPanel(intent) {
  const panel = document.createElement("section");
  panel.className = "platform-project-creation";
  panel.dataset.state = "loading";
  panel.append(
    text("h2", intent === "publication" ? "New publication" : "New Project"),
    text("p", intent === "publication" ? "Preparing private publication creation…"
      : "Loading the client and team choices for this project…", "platform-note")
  );
  return panel;
}

function deploymentSwitcher(deployment, federation) {
  const current = deployment ?? {
    id: "opengeo-studio",
    name: "OpenGeo Studio",
    origin: globalThis.location?.origin ?? "http://localhost",
    mode: "managed"
  };
  const sites = Array.isArray(federation) && federation.length
    ? federation
    : [{id: current.id, name: current.name, origin: current.origin, description: null}];
  const details = document.createElement("details");
  details.className = "platform-site-switcher";
  const summary = document.createElement("summary");
  const summaryCopy = document.createElement("span");
  summaryCopy.append(
    text("small", "OpenGeo Studio site"),
    text("strong", current.name)
  );
  summary.append(summaryCopy, text("span", "⌄", "platform-site-switcher-caret"));
  const list = document.createElement("div");
  list.className = "platform-site-switcher-list";
  list.setAttribute("role", "list");
  for (const site of sites) {
    const isCurrent = site.id === current.id && site.origin === current.origin;
    const item = isCurrent
      ? text("span", "", "platform-site-switcher-item current")
      : link("", new URL("/", site.origin).href, "platform-site-switcher-item");
    item.setAttribute("role", "listitem");
    if (isCurrent) item.setAttribute("aria-current", "page");
    item.append(
      text("strong", site.name),
      text(
        "small",
        isCurrent ? "Current site" : site.description ?? "Open this managed site"
      )
    );
    list.append(item);
  }
  list.append(text(
    "p",
    "Each site verifies your identity and permissions independently. Browser access tokens are never transferred between sites.",
    "platform-note"
  ));
  details.append(summary, list);
  return details;
}

// Only navigation disclosures dismiss outside; data groups and forms stay open.
function dismissDirectoryNavigation(root) {
  const document = root.ownerDocument;
  const openMenus = () => [...root.querySelectorAll(".platform-site-switcher[open], .platform-account-menu[open]")];
  const pointer = event => {
    for (const menu of openMenus()) if (!menu.contains(event.target)) menu.open = false;
  };
  const key = event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const menus = openMenus().filter(menu => !menu.querySelector("dialog[open]"));
    if (!menus.length) return;
    const current = menus.find(menu => menu.contains(document.activeElement)) ?? menus.at(-1);
    for (const menu of menus) menu.open = false;
    event.preventDefault();current.querySelector("summary")?.focus();
  };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", key);
  let connected = root.isConnected;
  const observer = new document.defaultView.MutationObserver(() => {
    if (root.isConnected) connected = true;
    else if (connected) dispose();
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
  function dispose() {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", key);
    observer.disconnect();
  }
  return dispose;
}

function siteSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "project-site";
}

function directoryActions(state, view) {
  const actions = document.createElement("section");
  actions.className = "platform-directory-actions";
  const newProjectRoute = state.adapter?.kind === "fixture"
    ? "/workspaces?adapter=fixture&new=map"
    : "/workspaces?new=map";
  const newPublicationRoute = state.adapter?.kind === "fixture"
    ? "/workspaces?view=publishing&adapter=fixture&new=publication"
    : "/workspaces?view=publishing&new=publication";
  if (view === "publishing") {
    actions.append(directoryAction(newPublicationRoute, "▤", "New publication", "Write an article using maps and data from Studio"));
    return actions;
  }
  actions.append(directoryAction(newProjectRoute, "◇", "New Project", "Compose maps with reusable Layers and Styles"));
  return actions;
}

function directoryResourceNavigation(state, activeView) {
  return AccountNavigation({adapterKind: state.adapter?.kind, active: activeView,
    admin: state.organization.callerRole === "admin"});
}

function directoryHref(view, adapterKind = null, publicResourceTarget = null) {
  return applicationDirectoryHref({view, adapterKind, publicResourceTarget});
}

function directoryView(value = null) {
  if (newProjectIntent() === "publication") return "publishing";
  const requested = value ?? new URLSearchParams(globalThis.location?.search ?? "").get("view");
  return ["projects", "data", "sources", "publishing", "teams", "collections", "locations", "access", "styles"].includes(requested)
    ? requested
    : "projects";
}

function directoryViewCopy(view, state) {
  if (view === "styles") return {title: "Styles", description: "Create, preview and keep reusable map symbols and patterns."};
  if (view === "access") return {title: "Data access settings", description: "Manage shared data and permissions for existing access containers. These settings do not represent additional Projects."};
  if (view === "locations") return {title: "Geographic tags", description: "Select a place to see its boundary, find related layers or reuse its search area."};
  if (view === "collections") return {title: "Collections", description: "Organize related Projects and Publications. Each item keeps its own access permissions."};
  if (view === "data") {
    return {
      title: "Catalog",
      description: "Browse source data and layers. Use Projects to work on maps and Publications to write articles."
    };
  }
  if (view === "sources") {
    return {
      title: "Connections",
      description: "Manage your storage and basemap connections. Add map services to a project using Add data."
    };
  }
  if (view === "teams") {
    return {
      title: "Account teams",
      description: "Manage team membership for this account. Share individual projects, collections, resources, and publications from their own access settings."
    };
  }
  if (view === "publishing") {
    return {
      title: "Publications",
      description: "Write and preview articles using Studio maps and data. Manage public access and web addresses within each publication."
    };
  }
  return {
    title: "Your projects",
    description: `Projects compose reusable Layers, Styles and spatial views. Open a saved Project or create one in ${state.organization.name}.`
  };
}

function projectCreationPanel(state, refresh, intent) {
  const publication = intent === "publication";
  const panel = document.createElement("section");
  panel.className = "platform-project-creation";
  panel.dataset.projectIntent = intent;
  panel.dataset.state = "ready";
  panel.append(
    text("p", publication ? "Publication" : "GIS workspace", "platform-eyebrow"),
    text("h2", publication ? "Create a publication" : "Create a map project"),
    text(
      "p",
      publication
        ? "Choose a format and start editing privately. Configure the public address in Publish when the content is ready."
        : "A project is the durable shared container. Its maps hold layer order, styling, labels, bookmarks, and other presentation choices; the same datasets and connections can be reused by other projects.",
      "platform-subtitle"
    )
  );
  if (state.organization.callerRole !== "admin") {
    panel.dataset.state = "forbidden";
    panel.append(text("p", "Organization administrator access is required to create a project. Editors can create another map from Save As inside an assigned project.", "platform-note"));
    return panel;
  }

  const form = document.createElement("form");
  form.className = "platform-project-creation-form";
  const name = document.createElement("input");
  name.type = "text";
  name.required = true;
  name.maxLength = 200;
  name.autofocus = true;
  name.ariaLabel = "New project name";
  name.placeholder = "Project name";
  const mapName = document.createElement("input");
  mapName.type = "text";
  mapName.required = true;
  mapName.maxLength = 200;
  mapName.ariaLabel = "First map name";
  mapName.placeholder = "First map name";
  const publicationTitle = document.createElement("input");
  publicationTitle.type = "text";
  publicationTitle.required = publication;
  publicationTitle.maxLength = 300;
  publicationTitle.ariaLabel = "Publication title";
  publicationTitle.placeholder = "Publication title";
  const publicationFormat = document.createElement("select"); publicationFormat.ariaLabel = "Publication format";
  for (const [value, label] of publicationFormats) {
    const item = option(value, label);
    item.disabled = !publicationFormatEnabled(value) || value !== "framework" && typeof state.adapter.saveObservableSourceRevision !== "function";
    if (item.disabled) item.textContent += " · server update pending";
    publicationFormat.append(item);
  }
  const publicationSlug = document.createElement("input");
  publicationSlug.type = "text";
  publicationSlug.required = publication;
  publicationSlug.maxLength = 160;
  publicationSlug.pattern = "[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?";
  publicationSlug.ariaLabel = "Source identifier";
  publicationSlug.placeholder = "project-name";
  const publicationAddress = text(
    "small",
    "Private draft. Choose a public address later in Publish.",
    "platform-publication-address"
  );
  const client = document.createElement("select");
  client.ariaLabel = "Project client";
  client.append(option("", "No client"));
  for (const record of state.clients.filter(({status}) => status === "active")) {
    client.append(option(record.id, record.name));
  }
  const description = document.createElement("textarea");
  description.rows = 2;
  description.maxLength = 10_000;
  description.ariaLabel = "New project description";
  description.placeholder = "Purpose or scope (optional)";
  const team = document.createElement("select");
  team.ariaLabel = "Share new project with team";
  team.append(option("", "Private to direct project members"));
  for (const record of state.teams ?? []) team.append(option(record.id, record.name));
  const teamRole = document.createElement("select");
  teamRole.ariaLabel = "Team project role";
  teamRole.append(
    option("editor", "Can edit maps and data"),
    option("reviewer", "Can review and publish"),
    option("viewer", "Can view"),
    option("owner", "Can administer project")
  );
  teamRole.disabled = true;
  team.addEventListener("change", () => {
    teamRole.disabled = !team.value;
  });
  const submit = action(publication ? "Create publication" : "Create project and map", () => {});
  submit.type = "submit";
  const cancel = link("Cancel", state.adapter?.kind === "fixture" ? "/workspaces?adapter=fixture" : "/workspaces", "platform-button secondary");
  const feedback = text("p", "Nothing has been created yet.", "platform-note");
  feedback.ariaLive = "polite";
  const actions = document.createElement("div");
  actions.className = "platform-actions";
  actions.append(submit, cancel);
  form.append(
    labeledField("Project name", name),
    ...(publication
      ? [
          labeledField("Publication title", publicationTitle),
          labeledField("Format", publicationFormat),
          labeledField("Source identifier", publicationSlug),
          publicationAddress
        ]
      : [labeledField("First map", mapName)]),
    labeledField("Client", client),
    labeledField("Share with team (optional)", team),
    labeledField("Team project role", teamRole),
    labeledField("Purpose or scope (optional)", description, "platform-field-wide"),
    actions,
    feedback
  );
  name.addEventListener("input", () => {
    if (!mapName.dataset.edited) mapName.value = name.value.trim() ? `${name.value.trim()} map` : "";
    if (!publicationTitle.dataset.edited) publicationTitle.value = name.value.trim();
    if (!publicationSlug.dataset.edited) publicationSlug.value = siteSlug(name.value);
    reflectPublicationAddress();
  });
  mapName.addEventListener("input", () => mapName.dataset.edited = "true");
  publicationTitle.addEventListener("input", () => publicationTitle.dataset.edited = "true");
  publicationSlug.addEventListener("input", () => {
    publicationSlug.dataset.edited = "true";
    publicationSlug.value = siteSlug(publicationSlug.value);
    reflectPublicationAddress();
  });
  function reflectPublicationAddress() {
    publicationAddress.textContent = "Private draft. Choose a public address later in Publish.";
  }
  let creating = false;
  let creationClosed = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creating || creationClosed) return;
    if (publication && !publicationFormatEnabled(publicationFormat.value)) {feedback.textContent = "This format requires the pending publishing-service update. Nothing was created."; return;}
    creating = true;
    const fields = [...form.querySelectorAll("input, select, textarea")];
    const previouslyDisabled = fields.map(field => field.disabled);
    for (const field of fields) field.disabled = true;
    submit.disabled = true;
    feedback.textContent = "Creating the authoritative project…";
    panel.dataset.state = "creating-project";
    let project = null;
    let map = null;
    let publicationSite = null;
    let phase = "project";
    try {
      project = await state.adapter.createProject({
        clientId: client.value || null,
        name: name.value.trim(),
        description: description.value.trim() || null
      });
      if (publication) {
        const title = publicationTitle.value.trim();
        const slug = siteSlug(publicationSlug.value);
        phase = "publication-home";
        panel.dataset.state = "creating-publication-home";
        feedback.textContent = "Project created. Creating its private publication home…";
        const home = await state.adapter.createResource(project.id, {
          kind: "document",
          slug: "home",
          visibility: "restricted",
          metadata: {
            title,
            abstract: description.value.trim() || `Private home page for ${title}.`,
            language: "en",
            license: null,
            attribution: null,
            keywords: ["Observable Framework", "publication"],
            profile: "opengeo.core.v1"
          },
          content: {
            blocks: [{id: "introduction", type: "markdown", markdown: `# ${title}\n` }]
          },
          provenance: {creationIntent: "file-publication", initialPublicationFormat: publicationFormat.value}
        });
        phase = "publication-site";
        panel.dataset.state = "creating-publication-site";
        feedback.textContent = "Home created. Reserving the governed site identity…";
        const site = publicationSite = await state.adapter.createSite(project.id, {
          slug,
          title,
          description: description.value.trim() || null,
          language: "en",
          theme: "minimal",
          themeOptions: {accentColor: "#176b87"},
          pages: [{
            slug: "home",
            navigationLabel: "Home",
            resourceId: home.id,
            resourceVersion: home.versionNumber,
            isHome: true
          }]
        });
        phase = "publication-source";
        panel.dataset.state = "creating-publication-source";
        feedback.textContent = "Site reserved. Creating the private Observable source tree…";
        const source = await state.adapter.createObservableSourceProject(project.id, site.id, {
          title: `${title} source`
        });
        if (typeof state.adapter.saveObservableSourceRevision === "function") {
          phase = "publication-files";
          feedback.textContent = "Creating the editable home page…";
          await state.adapter.saveObservableSourceRevision(project.id, source.id,
            publicationStarter({format: publicationFormat.value, title, sourceProject: source}));
        }
      } else {
        feedback.textContent = "Project created. Creating its first authoritative map…";
        phase = "map";
        panel.dataset.state = "creating-map";
        map = await state.adapter.createMap(project.id, {
          name: mapName.value.trim(),
          definition: emptyMapDefinition({
            mapViews: [{id: "default", title: "Default", center: [0, 20], zoom: 2, pitch: 0, bearing: 0}],
          })
        });
      }
      if (team.value) {
        phase = "sharing";
        panel.dataset.state = "sharing-project";
        feedback.textContent = `${publication ? "Publication workspace" : "Map"} created. Granting the selected team explicit project access…`;
        await state.adapter.createProjectTeamGrant(project.id, team.value, teamRole.value);
      }
      panel.dataset.state = "created";
      creationClosed = true;
      feedback.textContent = publication
        ? `Created ${project.name} with a private Observable source project${team.value ? " and team access" : ""}. Opening publication workspace…`
        : `Created ${project.name} and ${map.name}${team.value ? " with team access" : ""}. Opening map version ${map.version}…`;
      const target = new URL(publication ? publicationHref(publicationSite.id, {adapterKind: state.adapter?.kind})
        : compositionHref(map.id, {adapterKind: state.adapter?.kind}), location.origin);
      location.href = target;
    } catch (error) {
      // A lost response can follow a committed write. Do not replay creation
      // unless the API explicitly rejected the initial project request.
      const rejected = [400, 401, 403, 404, 409, 413, 422, 429].includes(error?.status);
      creationClosed = Boolean(project) || !rejected;
      panel.dataset.state = project ? `${phase}-error` : rejected ? "project-error" : "project-unconfirmed";
      const request = error?.requestId ? ` Request ${error.requestId}.` : "";
      feedback.textContent = project
        ? phase === "sharing"
          ? `The project and ${publication ? "publication workspace" : "map"} were created. Team access could not be confirmed (${error?.code ?? "unexpected_error"}).${request} Check access in the existing project before inviting anyone again.`
          : `The project was created, but ${publication ? "publication setup" : "map setup"} did not finish (${error?.code ?? "unexpected_error"}).${request} Open the existing project to review what was saved before continuing.`
        : rejected
          ? `The project request was rejected (${error?.code ?? "unexpected_error"}).${request} You can correct the details and try again.`
          : `We could not confirm whether the project was created (${error?.code ?? "unexpected_error"}).${request} Check your projects before trying again.`;
      if (creationClosed) {
        const target = new URL(project ? projectHref(project.id, state.adapter?.kind) : cancel.href, location.origin);
        if (project && phase === "sharing") {
          target.searchParams.set("manage", "settings");
          target.hash = "project-settings";
        } else if (project && publication && phase === "publication-source") {
          target.hash = "framework-source";
        }
        const recovery = link(project ? "Open existing project" : "Check projects", target.href, "platform-button");
        submit.replaceWith(recovery);
        cancel.textContent = "Back to projects";
        recovery.focus();
      } else {
        submit.disabled = false;
        fields.forEach((field, index) => field.disabled = previouslyDisabled[index]);
      }
    } finally {
      creating = false;
    }
  });
  panel.append(form);
  queueMicrotask(() => name.focus());
  return panel;
}

function newProjectIntent() {
  try {
    const value = new URL(globalThis.location?.href ?? "http://localhost/").searchParams.get("new");
    if (value === "publication") return "publication";
    if (value === "map" || value === "1") return "map";
    return null;
  } catch {
    return null;
  }
}

function directoryAction(href, icon, title, detail) {
  const item = link("", href, "platform-directory-action");
  item.append(text("span", icon, "platform-directory-action-icon"));
  const copy = document.createElement("span");
  copy.append(text("strong", title), text("small", detail));
  item.append(copy);
  return item;
}

function peopleAccessHref(state) {
  return state.adapter?.kind === "fixture" ? "/admin?adapter=fixture" : "/admin";
}

function teamsPanel(state, {open = false} = {}) {
  const details = document.createElement("details");
  details.className = "platform-directory-advanced platform-team-admin";
  details.id = "teams";
  details.open = open;
  const summary = document.createElement("summary");
  summary.append(
    text("strong", `Teams · ${(state.teams ?? []).length}`),
    text("span", "Membership and project grants remain explicit and separate")
  );
  const body = document.createElement("section");
  body.className = "platform-directory-admin-body";
  const render = () => {
    body.replaceChildren(
      text("h2", "Organization teams"),
      text(
        "p",
        "A person can belong to a team without gaining any project access. A project owner separately grants that team an owner, editor, reviewer, or viewer role.",
        "platform-subtitle"
      )
    );
    if (state.organization.callerRole === "admin") {
      body.append(link("Invite people and manage access", peopleAccessHref(state), "platform-button platform-button-secondary"));
    }
    if (state.directoryDetailsLoading) {
      body.append(text("p", "Loading team membership and project grants…", "platform-note"));
      return;
    }
    const list = document.createElement("div");
    list.className = "platform-compact-records";
    for (const team of state.teams ?? []) {
      const record = document.createElement("article");
      record.className = "platform-compact-record";
      record.append(
        text("strong", team.name),
        text("span", team.description ?? "No description"),
        badge(team.callerRole ?? "not a member")
      );
      list.append(record);
    }
    if (!(state.teams ?? []).length) {
      list.append(text("p", "No teams are visible to this account.", "platform-note"));
    }
    body.append(list);
    if (state.organization.callerRole === "admin") body.append(teamCreationForm(state, render));
  };
  render();
  details.append(summary, body);
  return details;
}

function teamCreationForm(state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-inline-admin-form";
  const name = document.createElement("input");
  name.required = true;
  name.maxLength = 200;
  name.placeholder = "Research team";
  const description = document.createElement("input");
  description.maxLength = 10_000;
  description.placeholder = "Purpose (optional)";
  const submit = action("Create team", () => {});
  submit.type = "submit";
  const feedback = text("p", "The creator becomes a direct team owner.", "platform-note");
  form.append(
    labeledField("Team name", name),
    labeledField("Description", description),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Creating team…";
    try {
      const team = await state.adapter.createTeam({
        name: name.value.trim(),
        description: description.value.trim() || null
      });
      state.teams.push(team);
      rerender();
    } catch (error) {
      feedback.textContent = `Team was not created (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function datasetConnectionsPanel(state, {open = false} = {}) {
  const details = document.createElement("details");
  details.className = "platform-directory-advanced platform-connection-admin";
  details.id = "connections";
  details.open = open || globalThis.location?.hash === "#connections";
  const summary = document.createElement("summary");
  summary.append(
    text(
      "strong",
      `Connections · ${(state.userConnections ?? []).length + (state.userBasemapConnections ?? []).length}`
    ),
    text("span", "Reusable, user-owned dataset and map-provider access")
  );
  const body = document.createElement("section");
  body.className = "platform-directory-admin-body";
  const render = () => renderDatasetConnectionsBody(body, state, render);
  render();
  details.append(summary, body);
  return details;
}

export function sourceCapabilityDirectory() {
  const summary = sourceCapabilitySummary();
  const section = document.createElement("section");
  section.className = "platform-source-capability-directory";
  section.id = "source-capabilities";
  const heading = document.createElement("header");
  const headingCopy = document.createElement("div");
  headingCopy.append(
    text("h2", "Source capability directory"),
    text(
      "p",
      `${summary.total} source families · ${summary.current} bounded current paths · ${summary.preserveOnly} explicit preserve-only paths`,
      "platform-note"
    )
  );
  heading.append(
    headingCopy,
    text("span", `${summary.operations} operation claims each`, "platform-source-capability-count")
  );

  const controls = document.createElement("div");
  controls.className = "platform-source-capability-controls";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search source formats and services";
  search.ariaLabel = "Search source capabilities";
  const disposition = document.createElement("select");
  disposition.ariaLabel = "Source capability disposition";
  disposition.append(
    option("all", "All source paths"),
    option("bounded-current", "Bounded current"),
    option("metadata-only", "Metadata only"),
    option("connection-only", "Connection only"),
    option("preserve-only", "Preserve only")
  );
  controls.append(search, disposition);

  const results = document.createElement("div");
  results.className = "platform-source-capability-results";
  results.ariaLive = "polite";
  const render = () => {
    const records = filterSourceCapabilities({
      query: search.value,
      disposition: disposition.value
    });
    results.replaceChildren();
    for (const group of sourceCapabilitySections(records)) {
      if (!group.records.length) continue;
      const groupElement = document.createElement("section");
      groupElement.className = "platform-source-capability-group";
      groupElement.append(text("h3", sourceSectionLabel(group.id)));
      const list = document.createElement("div");
      list.className = "platform-source-capability-list";
      for (const record of group.records) list.append(sourceCapabilityRecord(record));
      groupElement.append(list);
      results.append(groupElement);
    }
    if (!records.length) {
      results.append(text("p", "No source capabilities match these filters.", "platform-note"));
    }
  };
  search.addEventListener("input", render);
  disposition.addEventListener("change", render);
  section.append(heading, controls, results);
  render();
  return section;
}

function sourceCapabilityRecord(record) {
  const details = document.createElement("details");
  details.className = "platform-source-capability-record";
  details.dataset.sourceId = record.id;
  details.dataset.disposition = record.disposition;
  const summary = document.createElement("summary");
  const identity = document.createElement("span");
  identity.append(text("strong", record.label), text("small", record.summary));
  const currentOperations = SOURCE_OPERATIONS.filter((operation) => (
    ["available", "bounded"].includes(record.operations[operation].status)
  )).length;
  const state = document.createElement("span");
  state.className = `platform-source-capability-state ${record.disposition}`;
  state.append(
    text("strong", sourceDispositionLabel(record.disposition)),
    text("small", `${currentOperations}/${SOURCE_OPERATIONS.length} current operations`)
  );
  summary.append(identity, state);

  const body = document.createElement("div");
  body.className = "platform-source-capability-body";
  const operationGrid = document.createElement("dl");
  operationGrid.className = "platform-source-operation-grid";
  for (const operation of SOURCE_OPERATIONS) {
    const value = record.operations[operation];
    const cell = document.createElement("div");
    cell.dataset.status = value.status;
    cell.append(
      text("dt", operation),
      text("dd", sourceClaimLabel(value.status)),
      text("small", value.scope)
    );
    operationGrid.append(cell);
  }
  const limits = document.createElement("div");
  limits.className = "platform-source-capability-limits";
  limits.append(text("strong", "Limits and losses"));
  const list = document.createElement("ul");
  for (const loss of record.losses) list.append(text("li", loss));
  limits.append(list);
  body.append(operationGrid, limits);
  details.append(summary, body);
  return details;
}

function sourceSectionLabel(section) {
  return ({
    files: "Files",
    "web-services": "Web services",
    cloud: "Cloud-native formats",
    "3d": "Point clouds and 3D",
    databases: "Databases"
  })[section] ?? section;
}

function sourceDispositionLabel(value) {
  return ({
    "bounded-current": "Bounded current",
    "metadata-only": "Metadata only",
    "connection-only": "Connection only",
    "preserve-only": "Preserve only"
  })[value] ?? value;
}

function sourceClaimLabel(value) {
  return ({
    available: "Available",
    bounded: "Bounded",
    "preserve-only": "Preserve only",
    unavailable: "Unavailable",
    "not-applicable": "Not applicable"
  })[value] ?? value;
}

function renderDatasetConnectionsBody(body, state, rerender) {
  body.replaceChildren(
    text("h2", "Your connections"),
    text(
      "p",
      "Save a storage connection once and reuse it in your projects. Manage provider accounts and basemap choices below.",
      "platform-subtitle"
    ),
    text(
      "p",
      (state.userConnections ?? []).some(({repositoryBrowseAvailable}) => repositoryBrowseAvailable)
        ? "Browse verified storage connections to find files. Previewing or importing a file is a separate action."
        : "You can save connection details here. Storage browsing is not available in this deployment.",
      "platform-note"
    )
  );
  if (state.directoryDetailsLoading) {
    body.append(text("p", "Loading your reusable storage and basemap connections…", "platform-note"));
    return;
  }
  const records = document.createElement("div");
  records.className = "platform-connection-records";
  for (const connection of state.userConnections ?? []) {
    records.append(datasetConnectionRecord(connection, state, rerender));
  }
  if (!(state.userConnections ?? []).length) {
    records.append(text("p", "No dataset connections have been saved yet.", "platform-note"));
  }
  body.append(
    records,
    datasetConnectionCreationForm(state, rerender),
    basemapConnectionsSection(state, rerender)
  );
}

function basemapConnectionsSection(state, rerender) {
  const section = document.createElement("section");
  section.className = "platform-basemap-connections";
  section.append(
    text("h2", "Your basemap provider connections"),
    text(
      "p",
      "Hosted providers such as Protomaps and CARTO require browser API keys. OpenGeo Studio saves each key centrally and binds the connection to projects, so authorized project viewers can inspect the key in the resulting browser requests. Record only the exact sites that may use it.",
      "platform-subtitle"
    ),
    text(
      "p",
      "OpenGeo Studio returns a resolved style only for an authorized project binding and marks the response private and no-store. The saved map contains the binding and flavor, never the resolved key-bearing URL.",
      "platform-note"
    )
  );
  const records = document.createElement("div");
  records.className = "platform-connection-records";
  for (const connection of state.userBasemapConnections ?? []) {
    records.append(basemapConnectionRecord(connection, state, rerender));
  }
  if (!(state.userBasemapConnections ?? []).length) {
    records.append(text("p", "No basemap provider connections have been saved yet.", "platform-note"));
  }
  section.append(records, basemapConnectionCreationForm(state, rerender));
  return section;
}

function basemapConnectionCreationForm(state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form";
  const provider = document.createElement("select");
  provider.append(option("protomaps", "Protomaps · vector styles"), option("carto", "CARTO · raster basemaps"));
  provider.value = new URLSearchParams(globalThis.location?.search ?? "").get("provider") === "carto"
    ? "carto"
    : "protomaps";
  const name = inputWithValue(provider.value === "carto" ? "CARTO basemaps" : "Protomaps hosted API", 200);
  const origin = inputWithValue(currentBrowserOrigin(), 512);
  origin.type = "url";
  const submit = action("Save provider connection", () => {});
  submit.type = "submit";
  const feedback = text(
    "p",
    providerSetupText(provider.value),
    "platform-note platform-field-wide"
  );
  form.append(
    text("h3", "Add a basemap provider", "platform-field-wide"),
    labeledField("Provider", provider),
    labeledField("Connection name", name),
    labeledField("Allowed site origin", origin),
    submit,
    feedback
  );
  provider.addEventListener("change", () => {
    name.value = provider.value === "carto" ? "CARTO basemaps" : "Protomaps hosted API";
    feedback.textContent = providerSetupText(provider.value);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Saving browser-provider metadata…";
    try {
      const connection = await state.adapter.createMyBasemapConnection({
        provider: provider.value,
        displayName: name.value.trim(),
        allowedOrigins: [origin.value.trim()]
      });
      state.userBasemapConnections.unshift(connection);
      rerender();
    } catch (error) {
      feedback.textContent = `Basemap connection was not saved (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function basemapConnectionRecord(connection, state, rerender) {
  const details = document.createElement("details");
  details.className = "platform-connection-record";
  const summary = document.createElement("summary");
  const identity = document.createElement("span");
  identity.append(
    text("strong", connection.displayName),
    text("small", `${basemapProviderName(connection.provider)} · ${connection.allowedOrigins.join(", ")}`)
  );
  summary.append(identity, badge(connection.status));
  const body = document.createElement("div");
  body.className = "platform-connection-record-body";
  body.append(
    basemapConnectionTargetForm(connection, state, rerender),
    basemapConnectionKeyForm(connection, state, rerender),
    basemapConnectionBindingForm(connection, state)
  );
  details.append(summary, body);
  return details;
}

function basemapConnectionTargetForm(connection, state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form";
  const name = inputWithValue(connection.displayName, 200);
  const origin = inputWithValue(connection.allowedOrigins[0] ?? currentBrowserOrigin(), 512);
  origin.type = "url";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = connection.status !== "disabled";
  const submit = action("Save provider settings", () => {});
  submit.type = "submit";
  const feedback = text(
    "p",
    `Changing this OpenGeo Studio allowlist does not change ${basemapProviderName(connection.provider)}. Update the provider's site or domain declaration separately.`,
    "platform-note"
  );
  form.append(
    labeledField("Connection name", name),
    labeledField("Allowed site origin", origin),
    labeledField("Enabled", enabled, "platform-checkbox-field"),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Saving provider settings…";
    try {
      const updated = await state.adapter.updateMyBasemapConnection(connection.id, {
        displayName: name.value.trim(),
        allowedOrigins: [origin.value.trim()],
        enabled: enabled.checked
      });
      replaceConnection(state.userBasemapConnections, updated);
      rerender();
    } catch (error) {
      feedback.textContent = `Provider settings were not saved (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function basemapConnectionKeyForm(connection, state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form platform-secret-form";
  form.autocomplete = "off";
  const apiKey = secretInput(`${basemapProviderName(connection.provider)} browser API key`);
  apiKey.maxLength = 512;
  const submit = action(
    connection.credentialRevision ? "Replace browser key" : "Store browser key",
    () => {}
  );
  submit.type = "submit";
  submit.disabled = connection.status === "disabled";
  const feedback = text(
    "p",
    `Configured fields: ${connection.configuredSecretFields.join(", ") || "none"}. The value is write-only here but is client-visible when an authorized map uses it.`,
    "platform-note platform-field-wide"
  );
  form.append(
    text("h3", "Client-visible browser key", "platform-field-wide"),
    labeledField(`${basemapProviderName(connection.provider)} API key`, apiKey),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Replacing the encrypted browser-key version…";
    try {
      const updated = await state.adapter.replaceMyBasemapConnectionBrowserKey(
        connection.id,
        connection.credentialRevision,
        apiKey.value
      );
      form.reset();
      replaceConnection(state.userBasemapConnections, updated);
      rerender();
    } catch (error) {
      form.reset();
      feedback.textContent = `Browser key was not replaced (${error?.code ?? "unexpected_error"}). Re-enter it to retry.`;
      submit.disabled = false;
    }
  });
  return form;
}

function basemapConnectionBindingForm(connection, state) {
  const form = document.createElement("form");
  form.className = "platform-inline-admin-form";
  const project = document.createElement("select");
  project.required = true;
  project.append(option("", "Choose a project"));
  for (const record of state.projects.filter(({status}) => status === "active")) {
    project.append(option(record.id, record.name));
  }
  const alias = inputWithValue(connection.displayName, 200);
  const submit = action("Add to project", () => {});
  submit.type = "submit";
  submit.disabled = connection.status === "disabled";
  const feedback = text(
    "p",
    connection.credentialReady
      ? `The project can resolve ${basemapProviderName(connection.provider)} basemaps without saving the key in its map definition.`
      : `You may bind this draft now; its ${basemapProviderName(connection.provider)} basemaps stay unavailable until a browser key is stored.`,
    "platform-note"
  );
  form.append(
    labeledField("Project", project),
    labeledField("Project label", alias),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Adding provider reference to project…";
    try {
      await state.adapter.createProjectBasemapConnectionBinding(
        project.value,
        connection.id,
        alias.value.trim()
      );
      feedback.textContent = "Basemap provider added. No key was copied into the project.";
    } catch (error) {
      feedback.textContent = `Basemap provider was not added (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function currentBrowserOrigin() {
  const origin = globalThis.location?.origin;
  return origin && /^https?:\/\//.test(origin) ? origin : "http://localhost:3000";
}

function basemapProviderName(provider) {
  return provider === "carto" ? "CARTO" : "Protomaps";
}

function providerSetupText(provider) {
  return provider === "carto"
    ? "Request a CARTO basemap key for this domain, then store the key after saving this metadata. CARTO keys are client-visible and its raster service is planned for retirement in favor of vector basemaps."
    : "Create a Protomaps browser key for this exact origin, then store the key after saving this metadata.";
}

function datasetConnectionCreationForm(state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form";
  const name = document.createElement("input");
  name.required = true;
  name.maxLength = 200;
  name.value = "";
  name.placeholder = "Connection name";
  const bucket = document.createElement("input");
  bucket.required = true;
  bucket.maxLength = 63;
  bucket.value = "";
  bucket.placeholder = "bucket-name";
  bucket.spellcheck = false;
  const region = document.createElement("input");
  region.required = true;
  region.maxLength = 32;
  region.value = "us-east-1";
  region.spellcheck = false;
  const prefix = document.createElement("input");
  prefix.maxLength = 1024;
  prefix.placeholder = "optional/key/prefix/";
  prefix.spellcheck = false;
  const mode = document.createElement("select");
  mode.append(
    option("workload_identity", "OpenGeo Studio workload identity (no user secret)"),
    option("assume_role", "Assume an IAM role"),
    option("access_key", "Access key (write-only secret)")
  );
  const roleArn = document.createElement("input");
  roleArn.maxLength = 2048;
  roleArn.placeholder = "arn:aws:iam::123456789012:role/OpenGeoDatasetReader";
  roleArn.spellcheck = false;
  const roleField = labeledField("IAM role ARN", roleArn);
  roleField.hidden = true;
  mode.addEventListener("change", () => {
    roleField.hidden = mode.value !== "assume_role";
    roleArn.required = mode.value === "assume_role";
  });
  const submit = action("Save unverified S3 connection", () => {});
  submit.type = "submit";
  const feedback = text(
    "p",
    "Enter the S3 bucket name—not its AWS Console URL. No connection attempt will be made.",
    "platform-note platform-field-wide"
  );
  form.append(
    text("h3", "Add an S3 connection", "platform-field-wide"),
    labeledField("Connection name", name),
    labeledField("S3 bucket", bucket),
    labeledField("AWS Region", region),
    labeledField("Object prefix (optional)", prefix),
    labeledField("Authentication", mode),
    roleField,
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Saving non-secret connection metadata…";
    try {
      const connection = await state.adapter.createMyDatasetConnection({
        displayName: name.value.trim(),
        bucketName: bucket.value.trim(),
        regionName: region.value.trim(),
        objectPrefix: prefix.value,
        credentialMode: mode.value,
        roleArn: mode.value === "assume_role" ? roleArn.value.trim() : null
      });
      state.userConnections.unshift(connection);
      rerender();
    } catch (error) {
      feedback.textContent = `Connection was not saved (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function datasetConnectionRecord(connection, state, rerender) {
  const details = document.createElement("details");
  details.className = "platform-connection-record";
  const summary = document.createElement("summary");
  const identity = document.createElement("span");
  identity.append(
    text("strong", connection.displayName),
    text(
      "small",
      `s3://${connection.bucketName}/${connection.objectPrefix} · ${connection.regionName}`
    )
  );
  summary.append(identity, badge(connection.status));
  const body = document.createElement("div");
  body.className = "platform-connection-record-body";
  const overview = connectionOverviewPanel(connection, state, rerender);
  body.append(connectionTargetForm(connection, state, rerender));
  if (connection.credentialMode === "workload_identity") {
    body.append(text(
      "p",
      "This connection uses the scoped OpenGeo Studio runtime identity and has no user-managed secret.",
      "platform-note"
    ));
  } else {
    body.append(connectionCredentialForm(connection, state, rerender));
  }
  body.append(overview.section);
  body.append(connectionRepositoryPanel(connection, state));
  body.append(connectionBindingForm(connection, state, overview.reload));
  details.append(summary, body);
  details.addEventListener("toggle", () => {
    if (details.open) void overview.load();
  });
  return details;
}

function connectionRepositoryPanel(connection, state) {
  const section = document.createElement("section");
  section.className = "platform-connection-repository platform-field-wide";
  section.append(text("h3", "Repository contents"));
  const statusLine = text("p", "", "platform-note");
  statusLine.setAttribute("aria-live", "polite");
  section.append(statusLine);
  if (!connection.repositoryBrowseAvailable) {
    statusLine.textContent = "Isolated repository browsing is not enabled for this deployment.";
    return section;
  }
  if (connection.status !== "verified") {
    statusLine.textContent = "Verify this connection before listing its repository contents.";
    return section;
  }

  statusLine.textContent = (
    "Browse folders and bounded object metadata within the configured prefix. "
    + "No object body is downloaded by this view."
  );
  const open = action("Browse repository", () => {});
  open.type = "button";
  const results = document.createElement("div");
  results.className = "platform-repository-browser";
  results.hidden = true;
  section.append(open, results);
  let inspectionGeneration = 0;
  let versionGeneration = 0;

  const load = async (prefix = "", cursor = null) => {
    inspectionGeneration += 1;
    open.disabled = true;
    results.hidden = false;
    results.setAttribute("aria-busy", "true");
    results.replaceChildren(text("p", "Loading repository contents…", "platform-note"));
    try {
      const page = await state.adapter.browseMyDatasetConnectionRepository(
        connection.id,
        {prefix, cursor, limit: 100}
      );
      renderRepositoryPage(results, page, load, inspect);
    } catch (error) {
      results.replaceChildren(text(
        "p",
        `Repository contents could not be loaded (${error?.code ?? "unexpected_error"}).`,
        "platform-note"
      ));
    } finally {
      results.removeAttribute("aria-busy");
      open.disabled = false;
    }
  };
  const inspect = async (relativePath, target, versionId = null) => {
    versionGeneration += 1;
    const generation = ++inspectionGeneration;
    target.hidden = false;
    target.setAttribute("aria-busy", "true");
    target.replaceChildren(text(
      "p",
      versionId === null
        ? "Reading current object metadata…"
        : "Reading exact object-version metadata…",
      "platform-note"
    ));
    try {
      const record = await state.adapter.inspectMyDatasetConnectionRepositoryObject(
        connection.id,
        relativePath,
        versionId
      );
      if (generation === inspectionGeneration) {
        renderRepositoryObject(target, record, {
          exactVersion: versionId !== null,
          loadVersions: (cursor = null) => loadVersions(relativePath, target, cursor),
          projects: (state.projects ?? []).filter(({callerRole, status}) => (
            status === "active" && ["owner", "editor"].includes(callerRole)
          )),
          registerObject: (draft) => (
            state.adapter.registerMyDatasetConnectionRepositoryObject(
              connection.id,
              draft
            )
          ),
          adapterKind: state.adapter?.kind
        });
      }
    } catch (error) {
      if (generation === inspectionGeneration) {
        target.replaceChildren(text(
          "p",
          `Object metadata could not be loaded (${error?.code ?? "unexpected_error"}).`,
          "platform-note"
        ));
      }
    } finally {
      if (generation === inspectionGeneration) target.removeAttribute("aria-busy");
    }
  };
  const loadVersions = async (relativePath, target, cursor = null) => {
    inspectionGeneration += 1;
    const generation = ++versionGeneration;
    target.hidden = false;
    target.setAttribute("aria-busy", "true");
    target.replaceChildren(text("p", "Loading bounded object-version history…", "platform-note"));
    try {
      const page = await state.adapter.listMyDatasetConnectionRepositoryObjectVersions(
        connection.id,
        relativePath,
        {cursor, limit: 50}
      );
      if (generation === versionGeneration) {
        renderRepositoryVersions(
          target,
          page,
          (versionId) => inspect(relativePath, target, versionId),
          (nextCursor) => loadVersions(relativePath, target, nextCursor)
        );
      }
    } catch (error) {
      if (generation === versionGeneration) {
        target.replaceChildren(text(
          "p",
          `Object-version history could not be loaded (${error?.code ?? "unexpected_error"}).`,
          "platform-note"
        ));
      }
    } finally {
      if (generation === versionGeneration) target.removeAttribute("aria-busy");
    }
  };
  open.addEventListener("click", () => load());
  return section;
}

function renderRepositoryPage(root, page, load, inspect) {
  const toolbar = document.createElement("div");
  toolbar.className = "platform-repository-toolbar";
  const location = text(
    "strong",
    page.prefix ? `/${page.prefix}` : "/",
    "platform-repository-location"
  );
  const up = action("Up", () => load(page.parentPrefix ?? ""));
  up.type = "button";
  up.disabled = page.parentPrefix === null;
  const reload = action("Reload", () => load(page.prefix));
  reload.type = "button";
  toolbar.append(location, up, reload);

  const list = document.createElement("ul");
  list.className = "platform-repository-list";
  const objectDetail = document.createElement("section");
  objectDetail.className = "platform-repository-object-detail";
  objectDetail.hidden = true;
  for (const entry of page.entries) {
    const item = document.createElement("li");
    const identity = entry.kind === "prefix"
      ? action(`Folder ${entry.name}`, () => load(entry.relativePath))
      : action(entry.name, () => inspect(entry.relativePath, objectDetail));
    if (entry.kind === "prefix") {
      identity.type = "button";
      identity.classList.add("platform-repository-folder");
    } else {
      identity.type = "button";
      identity.classList.add("platform-repository-object-name");
      identity.setAttribute("aria-label", `Inspect ${entry.name}`);
    }
    const facts = entry.kind === "object"
      ? [
          entry.sizeBytes === null ? null : repositorySize(entry.sizeBytes),
          entry.lastModified === null
            ? null
            : new Date(entry.lastModified).toLocaleString(),
          entry.storageClass
        ].filter(Boolean).join(" · ")
      : "Folder";
    item.append(identity, text("small", facts, "platform-repository-facts"));
    list.append(item);
  }
  if (!page.entries.length) {
    list.append(text("li", "This folder contains no visible objects.", "platform-note"));
  }
  root.replaceChildren(toolbar, list, objectDetail);
  if (page.truncated && page.nextCursor) {
    const more = action("Next page", () => load(page.prefix, page.nextCursor));
    more.type = "button";
    root.append(more);
  }
}

function renderRepositoryObject(root, record, {
  exactVersion = false,
  loadVersions = null,
  projects = [],
  registerObject = null,
  adapterKind = null
} = {}) {
  const heading = text("h4", record.name);
  const immutableVersion = record.versionId !== null && record.versionId !== "null";
  const status = text(
    "p",
    exactVersion
      ? "Exact historical object version"
      : immutableVersion
      ? "Current versioned object"
      : "Current object · no immutable S3 version identifier returned",
    "platform-note"
  );
  const facts = document.createElement("dl");
  facts.className = "platform-repository-object-facts";
  for (const [label, value] of [
    ["Path", record.relativePath],
    ["Size", repositorySize(record.sizeBytes)],
    ["Modified", new Date(record.lastModified).toLocaleString()],
    ["Media type", record.contentType ?? "Not reported"],
    ["Storage class", record.storageClass ?? "STANDARD or not reported"],
    ["Version ID", record.versionId ?? "Not reported"],
    ["ETag", record.etag],
    ["SHA-256 checksum", record.checksumSha256 ?? "Not reported"]
  ]) {
    facts.append(text("dt", label), text("dd", value));
  }
  const note = text(
    "p",
    "Metadata only. OpenGeo Studio has not downloaded, imported, copied, or published this object.",
    "platform-note"
  );
  const controls = document.createElement("div");
  controls.className = "platform-repository-object-controls";
  if (loadVersions) {
    const history = action("Version history", () => loadVersions());
    history.type = "button";
    controls.append(history);
  }
  root.replaceChildren(heading, status, facts, note, controls);
  if (registerObject) {
    root.append(repositoryObjectRegistrationPanel(record, {
      projects,
      registerObject,
      adapterKind,
      immutableVersion
    }));
  }
}

function repositoryObjectRegistrationPanel(record, {
  projects,
  registerObject,
  adapterKind,
  immutableVersion
}) {
  const section = document.createElement("section");
  section.className = "platform-repository-registration";
  section.append(text("h5", "Use in a project"));
  if (!immutableVersion) {
    section.append(text(
      "p",
      "This object can be inspected, but it has no immutable version ID. Preserve or version it before registering an exact project source.",
      "platform-note"
    ));
    return section;
  }
  const inferredFormat = repositoryFormat(record.relativePath);
  if (!inferredFormat) {
    section.append(text(
      "p",
      "This file type is not yet supported as a registered dataset. Its metadata remains available here.",
      "platform-note"
    ));
    return section;
  }
  if (!projects.length) {
    section.append(text(
      "p",
      "Create or obtain edit access to a project before registering this exact source version.",
      "platform-note"
    ));
    return section;
  }

  const form = document.createElement("form");
  form.className = "platform-connection-form platform-repository-registration-form";
  const project = document.createElement("select");
  project.required = true;
  for (const item of projects) project.append(option(item.id, item.name));
  const name = inputWithValue(repositoryDatasetName(record.name), 200);
  const classification = document.createElement("select");
  classification.append(
    option("internal", "Internal"),
    option("public", "Public"),
    option("confidential", "Confidential"),
    option("restricted", "Restricted")
  );
  const format = document.createElement("select");
  format.append(option(inferredFormat, repositoryFormatLabel(inferredFormat)));
  const description = document.createElement("textarea");
  description.maxLength = 4_000;
  description.rows = 2;
  description.placeholder = "Optional source note";
  const tags = inputWithValue("", 256, false);
  tags.placeholder = "Optional comma-separated tags";
  const submit = action("Register exact version", () => {});
  submit.type = "submit";
  const feedback = text(
    "p",
    "Registration saves this provider version and source metadata. It does not copy the object bytes.",
    "platform-note platform-field-wide"
  );
  feedback.setAttribute("aria-live", "polite");
  form.append(
    labeledField("Project", project),
    labeledField("Dataset name", name),
    labeledField("Sensitivity", classification),
    labeledField("File type", format),
    labeledField("Source note", description, "platform-field-wide"),
    labeledField("Tags", tags, "platform-field-wide"),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Registering the exact provider version…";
    try {
      const result = await registerObject({
        projectId: project.value,
        relativePath: record.relativePath,
        versionId: record.versionId,
        name: name.value.trim(),
        description: description.value.trim() || null,
        classification: classification.value,
        format: format.value,
        tags: [...new Set(tags.value.split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean))]
      });
      section.replaceChildren(
        text(
          "h5",
          result.created ? "Dataset registered" : "Dataset already registered"
        ),
        text(
          "p",
          result.attached
            ? "The exact source version is attached to the selected project. Object bytes remain at the provider."
            : "The selected project already contains this exact source version.",
          "platform-note"
        ),
        link(
          "Open project data",
          applicationProjectHref(result.projectId, {
            adapterKind,
            management: "data",
            datasetId: result.datasetId
          }),
          "platform-button"
        )
      );
    } catch (error) {
      feedback.textContent = `The dataset was not registered (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  section.append(form);
  return section;
}

function repositoryFormat(relativePath) {
  const path = relativePath.toLowerCase();
  for (const [format, extensions] of [
    ["geojson", [".geojson", ".json"]],
    ["csv", [".csv"]],
    ["shapefile", [".zip"]],
    ["geopackage", [".gpkg"]],
    ["geoparquet", [".geoparquet", ".parquet"]],
    ["cog", [".tif", ".tiff"]],
    ["pmtiles", [".pmtiles"]],
    ["png", [".png"]],
    ["jpeg", [".jpg", ".jpeg"]],
    ["pdf", [".pdf"]],
    ["odt", [".odt"]]
  ]) {
    if (extensions.some((extension) => path.endsWith(extension))) return format;
  }
  return null;
}

function repositoryDatasetName(filename) {
  return filename
    .replace(/\.(?:geojson|geoparquet|gpkg|parquet|pmtiles|tiff?|json|csv|zip|png|jpe?g|pdf|odt)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() || filename;
}

function repositoryFormatLabel(format) {
  return ({
    geojson: "GeoJSON",
    csv: "CSV",
    shapefile: "Shapefile ZIP",
    geopackage: "GeoPackage",
    geoparquet: "GeoParquet",
    cog: "Cloud Optimized GeoTIFF",
    pmtiles: "PMTiles",
    png: "PNG image",
    jpeg: "JPEG image",
    pdf: "PDF document",
    odt: "OpenDocument text"
  })[format] ?? format;
}

function renderRepositoryVersions(root, page, inspectVersion, loadVersions) {
  const controls = document.createElement("div");
  controls.className = "platform-repository-object-controls";
  const current = action("Current metadata", () => inspectVersion(null));
  current.type = "button";
  controls.append(current);
  const heading = text(
    "h4",
    `Version history · ${page.relativePath.split("/").at(-1)}`
  );
  // The history is provider metadata. Selecting a row performs a separate,
  // version-pinned HEAD request and still does not read object bytes.
  const note = text(
    "p",
    "Choose an exact non-deleted version to inspect its metadata. No object body is downloaded.",
    "platform-note"
  );
  const list = document.createElement("ul");
  list.className = "platform-repository-version-list";
  for (const entry of page.entries) {
    const item = document.createElement("li");
    const label = `${new Date(entry.lastModified).toLocaleString()}${entry.isLatest ? " · latest" : ""}`;
    if (entry.isDeleteMarker) {
      item.append(
        text("strong", `${label} · deletion marker`),
        text("small", entry.versionId, "platform-repository-facts")
      );
    } else {
      const select = action(label, () => inspectVersion(entry.versionId));
      select.type = "button";
      select.classList.add("platform-repository-version");
      select.setAttribute("aria-label", `Inspect version ${entry.versionId}`);
      item.append(
        select,
        text(
          "small",
          [repositorySize(entry.sizeBytes), entry.storageClass, entry.versionId]
            .filter(Boolean)
            .join(" · "),
          "platform-repository-facts"
        )
      );
    }
    list.append(item);
  }
  if (!page.entries.length) {
    list.append(text("li", "No retained object versions were returned.", "platform-note"));
  }
  root.replaceChildren(heading, controls, note, list);
  if (page.truncated && page.nextCursor) {
    const more = action("Next version page", () => loadVersions(page.nextCursor));
    more.type = "button";
    root.append(more);
  }
}

function repositorySize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

function connectionOverviewPanel(connection, state, rerender) {
  const section = document.createElement("section");
  section.className = "platform-connection-verification platform-field-wide";
  section.append(text("h3", "Health and project use"));
  const statusLine = text(
    "p",
    verificationStatusText(connection),
    "platform-note"
  );
  statusLine.setAttribute("aria-live", "polite");
  const details = document.createElement("div");
  details.className = "platform-source-overview";
  details.append(text("p", "Open this connection to load its current health and project references.", "platform-note"));
  const controls = document.createElement("div");
  controls.className = "platform-source-overview-controls";
  const refresh = action("Refresh health and use", () => {});
  refresh.type = "button";
  controls.append(refresh);
  let generation = 0;

  const load = async () => {
    const current = ++generation;
    refresh.disabled = true;
    details.setAttribute("aria-busy", "true");
    details.replaceChildren(text("p", "Loading current health and project references…", "platform-note"));
    try {
      const overview = await state.adapter.getMyDatasetConnectionOverview(connection.id);
      if (current !== generation) return;
      statusLine.textContent = connectionHealthText(overview);
      renderConnectionOverview(details, overview, state);
    } catch (error) {
      if (current !== generation) return;
      details.replaceChildren(text(
        "p",
        `Health and project use could not be loaded (${error?.code ?? "unexpected_error"}).`,
        "platform-note"
      ));
    } finally {
      if (current === generation) {
        refresh.disabled = false;
        details.removeAttribute("aria-busy");
      }
    }
  };
  refresh.addEventListener("click", () => void load());

  if (connection.verificationAvailable) {
    const verify = action("Test connection", () => {});
    verify.type = "button";
    verify.disabled = connection.status === "disabled" || !connection.credentialReady;
    verify.addEventListener("click", async () => {
      verify.disabled = true;
      statusLine.textContent = "Connection check queued…";
      try {
        const submission = await state.adapter.requestMyDatasetConnectionVerification(
          connection.id
        );
        statusLine.textContent = submission.created
          ? "Connection check is running…"
          : "The current connection check is still running…";
        const terminal = await waitForDatasetVerification(
          state.adapter,
          connection.id,
          section
        );
        if (terminal) {
          const refreshed = await state.adapter.listMyDatasetConnections();
          state.userConnections.splice(0, state.userConnections.length, ...refreshed);
          rerender();
          return;
        }
        statusLine.textContent = "Connection check continues in the background.";
      } catch (error) {
        statusLine.textContent = `Connection check was not started (${error?.code ?? "unexpected_error"}).`;
        verify.disabled = false;
      }
    });
    controls.prepend(verify);
  } else {
    controls.prepend(text(
      "p",
      "Live S3 verification is not enabled for this deployment.",
      "platform-note"
    ));
  }
  section.append(statusLine, details, controls);
  return {section, load, reload: () => load()};
}

function renderConnectionOverview(root, overview, state) {
  const facts = document.createElement("dl");
  facts.className = "platform-source-overview-facts";
  const latest = overview.latestVerification;
  const currentCheck = latest !== null
    && latest.targetRevision === overview.targetRevision
    && latest.credentialRevision === overview.credentialRevision;
  for (const [label, value] of [
    ["Target version", String(overview.targetRevision)],
    ["Credential version", String(overview.credentialRevision)],
    ["Latest check", latest?.finishedAt
      ? new Date(latest.finishedAt).toLocaleString()
      : latest?.createdAt
        ? `${latest.state} · ${new Date(latest.createdAt).toLocaleString()}`
        : "No recorded check"],
    ["Check scope", latest === null
      ? "No recorded check"
      : currentCheck
        ? "Current target and credentials"
        : `Earlier target ${latest.targetRevision} and credentials ${latest.credentialRevision}`]
  ]) {
    facts.append(text("dt", label), text("dd", value));
  }
  if (latest?.state === "succeeded") {
    facts.append(
      text("dt", "Verified controls"),
      text(
        "dd",
        [
          latest.bucketAccessConfirmed ? "bucket list" : null,
          latest.objectAccessConfirmed ? "object metadata" : null,
          latest.denyCanariesConfirmed ? "denial canaries" : null,
          latest.durationMs === null ? null : `${latest.durationMs} ms`
        ].filter(Boolean).join(" · ") || "No controls reported"
      )
    );
  }

  const projects = document.createElement("section");
  projects.className = "platform-source-projects";
  projects.append(text(
    "h4",
    `Used by ${overview.projectReferences.length} visible ${overview.projectReferences.length === 1 ? "project" : "projects"}`
  ));
  if (overview.projectReferences.length) {
    const list = document.createElement("ul");
    for (const reference of overview.projectReferences) {
      const item = document.createElement("li");
      item.append(
        link(
          reference.projectName,
          applicationProjectHref(reference.projectId, {
            adapterKind: state.adapter?.kind,
            management: "data"
          })
        ),
        text(
          "small",
          `${reference.displayName} · ${reference.projectStatus}`,
          "platform-note"
        )
      );
      list.append(item);
    }
    projects.append(list);
  } else {
    projects.append(text(
      "p",
      "This source is not referenced by a project currently visible to you.",
      "platform-note"
    ));
  }
  root.replaceChildren(facts, projects);
}

function connectionHealthText(overview) {
  if (overview.health === "healthy") {
    return `Healthy for target ${overview.targetRevision} and credentials ${overview.credentialRevision}.`;
  }
  if (overview.health === "checking") return "A check for the current target and credentials is running.";
  if (overview.health === "check_failed") return "The current connection check failed. Review the sanitized result below and test again after correcting access.";
  if (overview.health === "needs_credentials") return "Store the required credentials before testing this source.";
  if (overview.health === "disabled") return "This source is disabled.";
  return "The current target or credentials need a connection check.";
}

async function waitForDatasetVerification(adapter, connectionId, section) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!section.isConnected) return null;
    const records = await adapter.listMyDatasetConnectionVerifications(connectionId);
    const latest = records[0];
    if (latest && ["succeeded", "failed", "cancelled"].includes(latest.state)) {
      return latest;
    }
  }
  return null;
}

function verificationStatusText(connection) {
  if (connection.status === "verified" && connection.lastVerifiedAt) {
    return `Verified ${new Date(connection.lastVerifiedAt).toLocaleString()}.`;
  }
  if (connection.status === "error") {
    return `Last check failed (${connection.sanitizedErrorCode ?? "verification_failed"}).`;
  }
  if (connection.status === "disabled") return "Enable this connection before testing it.";
  if (!connection.credentialReady) return "Store the required credentials before testing.";
  return "Ready for a live, least-privilege connection check.";
}

function connectionTargetForm(connection, state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form";
  const name = inputWithValue(connection.displayName, 200);
  const bucket = inputWithValue(connection.bucketName, 63);
  const region = inputWithValue(connection.regionName, 32);
  const prefix = inputWithValue(connection.objectPrefix, 1024, false);
  const roleArn = connection.credentialMode === "assume_role"
    ? inputWithValue(connection.roleArn ?? "", 2048)
    : null;
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = connection.status !== "disabled";
  const submit = action("Save target settings", () => {});
  submit.type = "submit";
  const feedback = text("p", "Any target change resets verification status.", "platform-note");
  form.append(
    labeledField("Connection name", name),
    labeledField("S3 bucket", bucket),
    labeledField("AWS Region", region),
    labeledField("Object prefix", prefix),
    ...(roleArn ? [labeledField("IAM role ARN", roleArn, "platform-field-wide")] : []),
    labeledField("Enabled", enabled, "platform-checkbox-field"),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Saving target settings…";
    try {
      const updated = await state.adapter.updateMyDatasetConnection(connection.id, {
        displayName: name.value.trim(),
        bucketName: bucket.value.trim(),
        regionName: region.value.trim(),
        objectPrefix: prefix.value,
        ...(roleArn ? {roleArn: roleArn.value.trim()} : {}),
        enabled: enabled.checked
      });
      replaceConnection(state.userConnections, updated);
      rerender();
    } catch (error) {
      feedback.textContent = `Target settings were not saved (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function connectionCredentialForm(connection, state, rerender) {
  const form = document.createElement("form");
  form.className = "platform-connection-form platform-secret-form";
  form.autocomplete = "off";
  const fields = [];
  if (connection.credentialMode === "assume_role") {
    const externalId = secretInput("External ID");
    fields.push(["External ID", "externalId", externalId]);
  } else {
    fields.push(
      ["Access key ID", "accessKeyId", secretInput("Access key ID")],
      ["Secret access key", "secretAccessKey", secretInput("Secret access key")],
      ["Session token (optional)", "sessionToken", secretInput("Session token", false)]
    );
  }
  const submit = action(
    connection.credentialRevision ? "Replace credentials" : "Store credentials",
    () => {}
  );
  submit.type = "submit";
  const feedback = text(
    "p",
    `Configured fields: ${connection.configuredSecretFields.join(", ") || "none"}. Existing values can never be displayed.`,
    "platform-note platform-field-wide"
  );
  form.append(
    text("h3", "Write-only credentials", "platform-field-wide"),
    ...fields.map(([label, , input]) => labeledField(label, input)),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Replacing the encrypted credential version…";
    const credentials = Object.fromEntries(fields
      .filter(([, , input]) => input.value)
      .map(([, key, input]) => [key, input.value]));
    try {
      const updated = await state.adapter.replaceMyDatasetConnectionCredentials(
        connection.id,
        connection.credentialRevision,
        credentials
      );
      form.reset();
      replaceConnection(state.userConnections, updated);
      rerender();
    } catch (error) {
      form.reset();
      feedback.textContent = `Credentials were not replaced (${error?.code ?? "unexpected_error"}). Re-enter values to retry.`;
      submit.disabled = false;
    }
  });
  return form;
}

function connectionBindingForm(connection, state, onChanged = () => {}) {
  const form = document.createElement("form");
  form.className = "platform-inline-admin-form";
  const project = document.createElement("select");
  project.required = true;
  project.append(option("", "Choose a project"));
  for (const record of state.projects.filter(({status}) => status === "active")) {
    project.append(option(record.id, record.name));
  }
  const alias = inputWithValue(connection.displayName, 200);
  const submit = action("Add to project", () => {});
  submit.type = "submit";
  const feedback = text(
    "p",
    "Binding reuses this connection; each project keeps its own maps, layer stack, and styles.",
    "platform-note"
  );
  form.append(
    labeledField("Project", project),
    labeledField("Project label", alias),
    submit,
    feedback
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Adding connection reference to project…";
    try {
      await state.adapter.createProjectDatasetConnectionBinding(
        project.value,
        connection.id,
        alias.value.trim()
      );
      feedback.textContent = "Connection added. No credential was copied.";
      try {
        await onChanged();
      } catch {
        feedback.textContent = "Connection added. Refresh health and use to see the new project reference.";
      }
    } catch (error) {
      feedback.textContent = `Connection was not added (${error?.code ?? "unexpected_error"}).`;
      submit.disabled = false;
    }
  });
  return form;
}

function inputWithValue(value, maximum, required = true) {
  const input = document.createElement("input");
  input.required = required;
  input.maxLength = maximum;
  input.value = value;
  input.spellcheck = false;
  return input;
}

function secretInput(label, required = true) {
  const input = document.createElement("input");
  input.type = "password";
  input.required = required;
  input.maxLength = 4096;
  input.placeholder = label;
  input.autocomplete = "new-password";
  input.spellcheck = false;
  return input;
}

function replaceConnection(records, updated) {
  const index = records.findIndex(({id}) => id === updated.id);
  if (index >= 0) records.splice(index, 1, updated);
}

function labeledField(label, control, className = "") {
  const field = document.createElement("label");
  field.className = `platform-labeled-field${className ? ` ${className}` : ""}`;
  field.append(text("span", label), control);
  return field;
}

export function organizationCatalog(state, {autoload = false, publicResourceTarget = null} = {}) {
  const section = document.createElement("section");
  section.className = "platform-catalog-search";
  const registration = CatalogSourceRegistration({adapter: state.adapter, projects: state.projects, organization: state.organization});
  if (registration) section.append(registration);
  section.append(
    text("p", "Governed discovery", "platform-eyebrow"),
    text("h2", "Layers, datasets and files"),
    text(
      "p",
      "Select a resource to inspect its metadata and reuse it. Saved layer presentations show how resources appear in maps.",
      "platform-subtitle"
    )
  );
  const form = document.createElement("form");
  form.className = "platform-controls platform-catalog-controls";
  const mode = document.createElement("select");
  mode.ariaLabel = "Catalog audience";
  mode.append(
    option("authorized", "My accessible data"),
    option("published", "Published catalog")
  );
  const query = document.createElement("input");
  query.type = "search";
  query.maxLength = 200;
  query.placeholder = "Search all accessible data";
  query.ariaLabel = "Search organization datasets";
  const entries = document.createElement("select");
  entries.ariaLabel = "Catalog entries";
  entries.append(option("datasets", "Resources"));
  if (typeof state.adapter.searchLayers === "function") entries.append(option("layers", "Saved layer presentations"));
  let displayedLayers = null;
  const loadPreview = typeof state.adapter.getMap === "function" || typeof state.adapter.getSource === "function"
    ? createCatalogPreviewLoader({adapter: state.adapter}) : null;
  const client = document.createElement("select");
  client.ariaLabel = "Catalog client";
  client.append(option("", "All clients"));
  for (const record of state.clients) client.append(option(record.id, record.name));
  const project = document.createElement("select");
  project.ariaLabel = "Catalog project";
  project.append(option("", "All projects"));
  for (const record of state.projects) project.append(option(record.id, record.name));
  const classification = document.createElement("select");
  classification.ariaLabel = "Catalog sensitivity";
  for (const [value, label] of [["", "All sensitivity"], ["public", "Public"], ["internal", "Internal"], ["confidential", "Confidential"], ["restricted", "Restricted"]]) {
    classification.append(option(value, label));
  }
  const bounds = document.createElement("input");
  bounds.ariaLabel = "Catalog bounds west,south,east,north";
  bounds.placeholder = "west,south,east,north"; bounds.maxLength = 200;
  const temporalStart = document.createElement("input");
  const temporalEnd = document.createElement("input");
  for (const control of [temporalStart, temporalEnd]) {control.type = "datetime-local"; control.step = "1";}
  const startField = labeledField("Updated after (UTC)", temporalStart);
  const endField = labeledField("Updated before (UTC)", temporalEnd);
  temporalStart.ariaLabel = "Catalog updated after (UTC)";
  temporalEnd.ariaLabel = "Catalog updated before (UTC)";
  const timeNote = text("p", "Optional update times in UTC; blank endpoints stay open.", "platform-note");
  const place = document.createElement("input");place.ariaLabel="Catalog place identity URL";
  place.placeholder="Wikidata or GeoNames place URL";place.maxLength=2048;
  const placeNote = text("p", "Matches current curated place tags and their latest retained country, continent or administrative relationships. Open a Layer’s metadata to inspect the source. This is descriptive context, not verified containment.", "platform-note");
  const boundsNote = text("p", "Optional longitude/latitude bounds. West greater than east crosses the date line. Only known, transformable source extents match; an extent is not exact feature coverage.", "platform-note");
  const updateBounds = () => {
    const published = mode.value === "published";
    const authorizedResources = !published && entries.value === "datasets";
    bounds.disabled = temporalStart.disabled = temporalEnd.disabled = !published && !authorizedResources;
    boundsNote.hidden = timeNote.hidden = bounds.disabled;
    place.disabled = !authorizedResources; placeNote.hidden = place.disabled;
    boundsNote.textContent = published
      ? "Optional longitude/latitude rectangle. West must not exceed east; this matches recorded resource extents, not exact feature coverage."
      : "Optional longitude/latitude bounds. West greater than east crosses the date line. Only known, transformable source extents match; an extent is not exact feature coverage.";
    startField.querySelector("span").textContent = published ? "Time from (UTC)" : "Updated after (UTC)";
    endField.querySelector("span").textContent = published ? "Time through (UTC)" : "Updated before (UTC)";
    temporalStart.ariaLabel = published ? "Catalog time from (UTC)" : "Catalog updated after (UTC)";
    temporalEnd.ariaLabel = published ? "Catalog time through (UTC)" : "Catalog updated before (UTC)";
    timeNote.textContent = published ? "Matches recorded resource time intervals. Times are UTC; blank endpoints stay open." : "Optional update times in UTC; blank endpoints stay open.";
    const locationControl = form.querySelector(".catalog-location-bounds"); if (locationControl) locationControl.disabled = !authorizedResources;
  };
  mode.addEventListener("change", updateBounds); entries.addEventListener("change", updateBounds);
  const publicKind = document.createElement("select");
  publicKind.ariaLabel = "Published resource type";
  for (const [value, label] of [
    ["", "All resource types"], ["dataset", "Datasets"], ["map", "Maps"],
    ["document", "Documents"], ["story", "Stories"], ["dashboard", "Dashboards"],
    ["service", "Services"]
  ]) publicKind.append(option(value, label));
  publicKind.hidden = true;
  const submit = action("Search catalog", () => {});
  submit.type = "submit";
  const feedback = text("p", "Enter search terms or choose a filter.", "platform-note");
  feedback.ariaLive = "polite";
  const results = document.createElement("div");
  results.style.minWidth = "0";
  const disposeResults = () => {for (const child of results.children) child.dispose?.();};
  const replaceResults = (...children) => {disposeResults(); results.replaceChildren(...children);};
  const discoveryNote = text("small", "Search covers all accessible records. Load more browses the next page.", "platform-note");
  const filters = document.createElement("details");
  filters.className = "catalog-directory-filters";
  filters.append(text("summary", "Filter by area, time, project, client or sensitivity"));
  const initialQuery = new URL(section.ownerDocument.defaultView.location.href).searchParams;
  if (initialQuery.get("view") === "data" && !publicResourceTarget) {
    const selectedPlace = initialQuery.get("place"), selectedBounds = initialQuery.get("bbox");
    if (selectedPlace && selectedPlace.length <= 2048) place.value = selectedPlace;
    if (selectedBounds && selectedBounds.length <= 200) bounds.value = selectedBounds;
    if (place.value || bounds.value) filters.open = true;
    const areaName = initialQuery.get("areaName"), areaRevision = initialQuery.get("areaRevision");
    if (bounds.value && areaName && areaName.length <= 200 && /^[1-9][0-9]{0,9}$/.test(areaRevision ?? "")) {
      filters.append(text("p", `${areaName} · saved tag revision ${areaRevision}. Search uses its enclosing rectangle; it does not clip Layer data.`, "platform-note"));
    }
  }
  const filterFields = document.createElement("div");
  filterFields.className = "platform-controls";
  filterFields.append(client, project, classification, bounds, boundsNote, startField, endField, timeNote, place, placeNote);
  if (typeof state.adapter.listLocations === "function" && typeof state.adapter.getLocation === "function") {
    const locationBounds = CatalogLocationBounds({adapter:state.adapter,getDraft:()=>bounds.value,
      applyBounds:values=>{if(bounds.disabled)return false;bounds.value=values.join(",");bounds.dispatchEvent(new Event("input",{bubbles:true}));return true;}});
    const updateLocationBounds=()=>{locationBounds.disabled=mode.value !== "authorized" || entries.value !== "datasets";};
    mode.addEventListener("change",updateLocationBounds);entries.addEventListener("change",updateLocationBounds);
    filterFields.append(locationBounds);
  }
  filters.append(filterFields);
  form.append(mode, entries, query, publicKind, submit, filters);
  const pageSize = 24;
  const layerPageSize = 50;
  let offset = 0;
  let nextOffset = null;
  let searchGeneration = 0;
  let loadedDatasets = [];
  const continuousResources = () => mode.value === "authorized" && entries.value === "datasets";
  const previousPage = action("Previous page", () => void search(Math.max(0, offset - (mode.value === "authorized" && entries.value === "layers" ? layerPageSize : pageSize))));
  const nextPage = action("Next page", () => {if (nextOffset !== null) void search(nextOffset);});
  previousPage.disabled = nextPage.disabled = true;
  const pagination = document.createElement("nav");
  pagination.className = "platform-controls";
  pagination.setAttribute("aria-label", "Dataset catalog pages");
  pagination.append(previousPage, nextPage);
  const currentGroupState = () => new Map([...results.querySelectorAll("details[data-group-key]")]
    .map(group => [group.dataset.groupKey, group.open]));
  const search = async (requestedOffset = 0) => {
    const generation = ++searchGeneration;
    submit.disabled = true;
    results.setAttribute("aria-busy", "true");
    previousPage.disabled = nextPage.disabled = true;
    const published = mode.value === "published";
    displayedLayers = null;
    feedback.textContent = published
      ? "Searching the published, anonymous-safe catalog…"
      : "Searching all accessible catalog records…";
    try {
      const bbox = bounds.disabled || !bounds.value.trim() ? null : bounds.value.split(",").map(value => value.trim() ? Number(value) : NaN);
      if (bbox && (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))
        || bbox[0] < -180 || bbox[0] > 180 || bbox[2] < -180 || bbox[2] > 180
        || bbox[1] < -90 || bbox[3] > 90 || bbox[1] > bbox[3]
        || (published && bbox[0] > bbox[2]))) throw Object.assign(new Error(), {code:"catalog_bbox_invalid"});
      const from = temporalStart.disabled || !temporalStart.value ? null : `${temporalStart.value}Z`;
      const through = temporalEnd.disabled || !temporalEnd.value ? null : `${temporalEnd.value}Z`;
      if ((from && !Number.isFinite(Date.parse(from))) || (through && !Number.isFinite(Date.parse(through)))
        || (from && through && Date.parse(from) > Date.parse(through))) throw Object.assign(new Error(), {code:"catalog_time_invalid"});
      if (published) {
        if (typeof state.adapter.listPublicResources !== "function") {
          throw Object.assign(new Error("public catalog unavailable"), {
            code: "public_catalog_unavailable"
          });
        }
        const page = await state.adapter.listPublicResources(state.organization.id, {
          query: query.value.trim() || null,
          projectId: project.value || null,
          kind: publicKind.value || null,
          bbox,
          temporalStart: from,
          temporalEnd: through,
          limit: pageSize,
          offset: requestedOffset
        });
        if (generation !== searchGeneration) return;
        offset = requestedOffset;
        nextOffset = page.nextOffset ?? null;
        replaceResults(publicCatalogTable(page, state.adapter));
        feedback.textContent = `${page.numberMatched} published resource${page.numberMatched === 1 ? "" : "s"} found. Page ${Math.floor(offset / pageSize) + 1}.`;
      } else if (entries.value === "layers") {
        const records = await state.adapter.searchLayers({query: query.value.trim() || null,
          clientId: client.value || null, projectId: project.value || null,
          classification: classification.value || null, limit: layerPageSize + 1, offset: requestedOffset});
        if (generation !== searchGeneration) return;
        offset = requestedOffset;
        nextOffset = records.length > layerPageSize ? offset + layerPageSize : null;
        displayedLayers = records.slice(0,layerPageSize);
        const groupState = currentGroupState();
        const layerResults = LayerCatalogResults({records: displayedLayers, adapter: state.adapter, adapterKind: state.adapter?.kind, loadPreview});
        for (const group of layerResults.querySelectorAll(".catalog-source-group, .catalog-dataset-group")) {
          group.open = groupState.get(group.dataset.groupKey) ?? true;
          if (group.matches(".catalog-source-group")) {
            group.querySelector("summary").append(text("span", `${group.querySelectorAll(".layer-catalog-entry").length} loaded layers`));
          }
        }
        replaceResults(layerResults);
        feedback.textContent = displayedLayers.length
          ? `${offset + 1}–${offset + displayedLayers.length} layers and datasets${nextOffset !== null ? " · more available" : ""}.`
          : "No matching layers or datasets.";
      } else {
        const placeUri = place.value.trim() ? placeIdentity(place.value) : null;
        const records = await state.adapter.searchDatasets({
          bbox,
          placeUri,
          query: query.value.trim() || null,
          clientId: client.value || null,
          projectId: project.value || null,
          classification: classification.value || null,
          updatedAfter: from,
          updatedBefore: through,
          limit: pageSize + 1,
          offset: requestedOffset
        });
        if (generation !== searchGeneration) return;
        offset = requestedOffset;
        nextOffset = records.length > pageSize ? offset + pageSize : null;
        const selected = records.slice(0, pageSize);
        const existing = new Set((requestedOffset === 0 ? [] : loadedDatasets).map(record => record.id));
        const added = selected.filter(record => !existing.has(record.id));
        loadedDatasets = requestedOffset === 0 ? added : [...loadedDatasets, ...added];
        const current = results.querySelector(".platform-catalog-grouped-results");
        if (requestedOffset > 0 && current) {
          current.appendRecords(added);
        } else replaceResults(catalogTable(added, state.projects, state.adapter?.kind,
          {adapter:state.adapter,placeUri,groupState:currentGroupState()}));
        const total = records[0]?.catalogMatchCount;
        feedback.textContent = loadedDatasets.length
          ? `${Number.isInteger(total) ? `${total.toLocaleString()} matching records · ` : ""}${loadedDatasets.length.toLocaleString()} loaded${nextOffset !== null ? " · load more available" : " · all results loaded"}.`
          : "0 matching records.";
      }
    } catch (error) {
      if (generation !== searchGeneration) return;
      if (error?.status !== 401 && error?.status !== 403 && results.children.length) {
        // A temporary failure keeps the current authorized view readable. A
        // denied account read must clear it, rather than retain private records.
        if (requestedOffset > 0 && continuousResources()) nextOffset = requestedOffset;
        else nextOffset = null;
        feedback.textContent = `Current results retained. ${requestedOffset > 0 ? "More results could not load; use Load more to retry" : "Search could not complete; try Search again"} (${error?.code ?? "unexpected_error"}).`;
      } else {
        nextOffset = null;
        replaceResults();
        feedback.textContent = `Catalog search failed safely (${error?.code ?? "unexpected_error"}).`;
      }
    } finally {
      if (generation === searchGeneration) {
        submit.disabled = false;
        results.setAttribute("aria-busy", "false");
        previousPage.disabled = offset === 0;
        nextPage.disabled = nextOffset === null;
        previousPage.hidden = continuousResources();
        nextPage.textContent = continuousResources() ? "Load more" : "Next page";
      }
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void search(0);
  });
  for (const control of [mode, entries, query, client, project, classification, publicKind, bounds, place, temporalStart, temporalEnd]) control.addEventListener([query, bounds, place, temporalStart, temporalEnd].includes(control) ? "input" : "change", () => {
    searchGeneration++;
    displayedLayers = null;
    offset = 0;
    nextOffset = null;
    submit.disabled = false;
    results.setAttribute("aria-busy", "false");
    previousPage.disabled = nextPage.disabled = true;
    feedback.textContent = results.children.length
      ? "Search to apply these filters. Showing previous results."
      : "Search to apply these filters.";
  });
  mode.addEventListener("change", () => {
    const published = mode.value === "published";
    client.hidden = published;
    classification.hidden = published;
    entries.hidden = published;
    publicKind.hidden = !published;
    query.placeholder = published ? "Search published resources" : "Search all accessible data";
    query.ariaLabel = published
      ? "Search published resources"
      : "Search organization datasets";
    discoveryNote.textContent = published
      ? "Published search covers explicitly public, published resources."
      : "Search covers all accessible records. Load more browses the next page.";
  });
  section.append(form, discoveryNote, feedback, results, pagination);
  const staticSearch = !state.directoryDetailsLoading && !publicResourceTarget ? StaticItemSearch({
    onReference: ["searchDatasets", "getSource", "createSource"].every(key => typeof state.adapter[key] === "function")
      ? reference => StaticItemCatalogRegistration({adapter: state.adapter, reference, projects: state.projects, organization: state.organization}) : null
  }) : null;
  if (staticSearch) section.append(staticSearch);
  const ckan = !state.directoryDetailsLoading && !publicResourceTarget ? CkanCatalog({
    adapter: state.adapter, projects: state.projects, organization: state.organization
  }) : null;
  if (ckan) section.append(ckan);
  section.dispose = () => {searchGeneration++; loadPreview?.dispose?.(); disposeResults(); staticSearch?.dispose(); ckan?.dispose();};
  section.shouldBlockNavigation = options => Boolean(ckan?.shouldBlockNavigation(options));
  if(state.directoryDetailsLoading) {
    form.inert=true;
    // The completed account render replaces this provisional catalog. Do not accept
    // a search draft that would be erased when its filter options finish loading.
    for(const control of form.querySelectorAll("input,select,button")) control.disabled=true;
    feedback.textContent="Loading catalog filters…";
  }
  if (publicResourceTarget) {
    mode.value = "published";
    updateBounds();
    client.hidden = true;
    classification.hidden = true;
    publicKind.hidden = false;
    query.placeholder = "Search published resources";
    query.ariaLabel = "Search published resources";
  }
  if (autoload) {
    if (publicResourceTarget) {
      feedback.textContent = "Loading published resource…";
      void loadPublicResourceDetail({
        state,
        target: publicResourceTarget,
        results,
        feedback,
        controls: [mode, query, client, project, classification, publicKind, submit]
      });
    } else {
      feedback.textContent = "Loading authorized datasets…";
      void search();
    }
  }
  return section;
}

async function loadPublicResourceDetail({state, target, results, feedback, controls}) {
  for (const control of controls) control.disabled = true;
  try {
    if (typeof state.adapter.getPublicResource !== "function") {
      throw Object.assign(new Error("public resource unavailable"), {
        code: "public_resource_unavailable"
      });
    }
    const record = await state.adapter.getPublicResource(
      state.organization.id,
      target.projectId,
      target.resourceId
    );
    if (record.community.organizationId !== state.organization.id
      || record.community.projectId !== target.projectId
      || record.id !== target.resourceId) {
      throw Object.assign(new Error("public resource identity changed"), {
        code: "public_resource_identity_changed"
      });
    }
    const detail = publicResourceDetail(record, state.adapter);
    results.replaceChildren(detail);
    feedback.textContent = `Published ${record.kind} · version ${record.versionNumber}`;
    if (record.preview.kind === "map"
      && typeof state.adapter.getPublicMapPreview === "function") {
      try {
        const preview = await state.adapter.getPublicMapPreview(
          state.organization.id,
          target.projectId,
          target.resourceId
        );
        if (preview.resourceId !== record.id
          || preview.resourceVersionNumber !== record.versionNumber) {
          throw Object.assign(new Error("public preview identity changed"), {
            code: "public_map_preview_identity_changed"
          });
        }
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, preview));
        feedback.textContent = `Published map · version ${record.versionNumber} · ${preview.layers.length} layer composition ready`;
      } catch (error) {
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, null, error?.code ?? "unavailable"));
        feedback.textContent = `Published map · version ${record.versionNumber} · composition preview unavailable`;
      }
    } else if (record.preview.kind === "dataset"
      && typeof state.adapter.getPublicSpatialPreview === "function") {
      try {
        const preview = await state.adapter.getPublicSpatialPreview(
          state.organization.id,
          target.projectId,
          target.resourceId
        );
        if (preview.resourceId !== record.id
          || preview.resourceVersionNumber !== record.versionNumber) {
          throw Object.assign(new Error("public preview identity changed"), {
            code: "public_spatial_preview_identity_changed"
          });
        }
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, preview));
        feedback.textContent = `Published ${record.kind} · version ${record.versionNumber} · feature preview ready`;
      } catch (error) {
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, null, error?.code ?? "unavailable"));
        feedback.textContent = `Published ${record.kind} · version ${record.versionNumber} · feature preview unavailable`;
      }
    } else if (record.preview.kind === "dataset-document"
      && typeof state.adapter.getPublicDatasetDocumentPreview === "function") {
      try {
        const preview = await state.adapter.getPublicDatasetDocumentPreview(
          state.organization.id,
          target.projectId,
          target.resourceId
        );
        if (preview.resourceId !== record.id
          || preview.resourceVersionNumber !== record.versionNumber) {
          throw Object.assign(new Error("public preview identity changed"), {
            code: "public_dataset_document_preview_identity_changed"
          });
        }
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, preview));
        feedback.textContent = `Published dataset · version ${record.versionNumber} · ${preview.sourceFormat.toUpperCase()} preview ready`;
      } catch (error) {
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, null, error?.code ?? "unavailable"));
        feedback.textContent = `Published dataset · version ${record.versionNumber} · document preview unavailable`;
      }
    } else if (record.preview.kind === "document"
      && typeof state.adapter.getPublicDocumentPreview === "function") {
      try {
        const preview = await state.adapter.getPublicDocumentPreview(
          state.organization.id,
          target.projectId,
          target.resourceId
        );
        if (preview.resourceId !== record.id
          || preview.resourceVersionNumber !== record.versionNumber
          || preview.resourceKind !== record.kind) {
          throw Object.assign(new Error("public preview identity changed"), {
            code: "public_document_preview_identity_changed"
          });
        }
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, preview));
        feedback.textContent = `Published ${record.kind} · version ${record.versionNumber} · content preview ready`;
      } catch (error) {
        detail.querySelector(".platform-public-resource-preview")
          ?.replaceWith(publicResourcePreview(record, null, error?.code ?? "unavailable"));
        feedback.textContent = `Published ${record.kind} · version ${record.versionNumber} · content preview unavailable`;
      }
    }
  } catch (error) {
    results.replaceChildren(publicResourceUnavailable(state.adapter?.kind));
    feedback.textContent = `Published resource could not be opened (${error?.code ?? "unexpected_error"}).`;
  } finally {
    for (const control of controls) control.disabled = false;
  }
}

function publicCatalogTable(page, adapter) {
  if (!page.records.length) {
    return text("p", "No matching published resources are visible.", "platform-note");
  }
  const wrapper = document.createElement("div");
  wrapper.className = "platform-public-catalog-results";
  const facets = document.createElement("p");
  facets.className = "platform-note";
  const kinds = page.facets.kind.slice(0, 4)
    .map(({label, count}) => `${label} ${count}`)
    .join(" · ");
  facets.textContent = kinds ? `Published mix · ${kinds}` : "Published resources";
  const table = document.createElement("table");
  table.className = "data-table platform-catalog-table platform-public-catalog-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Resource", "Project", "Type", "License", "Updated"]) {
    headRow.append(text("th", label));
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const record of page.records) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    identity.append(
      link(
        record.title,
        directoryHref("data", adapter?.kind, {
          projectId: record.community.projectId,
          resourceId: record.id
        })
      ),
      text(
        "small",
        `${record.community.organizationName} · ${record.provenance.namespace ?? "OpenGeo Studio native"}`
      ),
      ...(record.ratings.count > 0
        ? [text(
          "small",
          `Rated ${record.ratings.average.toFixed(1)} of 5 · ${record.ratings.count} ${record.ratings.count === 1 ? "rating" : "ratings"}`
        )]
        : [])
    );
    row.append(
      identity,
      text("td", record.community.projectName),
      badgeCell(record.kind),
      text("td", record.license ?? "Not stated"),
      text("td", new Date(record.freshness.catalogUpdatedAt).toLocaleDateString())
    );
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(facets, table);
  return wrapper;
}

function publicResourceUnavailable(adapterKind = null) {
  const panel = document.createElement("section");
  panel.className = "platform-public-resource-state";
  panel.append(
    text("h3", "Published resource unavailable"),
    text(
      "p",
      "The resource may have been withdrawn, or this site could not verify its current public record.",
      "platform-note"
    ),
    link("Return to the data catalog", directoryHref("data", adapterKind), "platform-button secondary")
  );
  return panel;
}

function publicResourceDetail(record, adapter) {
  const article = document.createElement("article");
  article.className = "platform-public-resource-detail";
  article.dataset.resourceKind = record.kind;
  const heading = document.createElement("header");
  heading.className = "platform-public-resource-heading";
  const title = document.createElement("div");
  title.append(
    text("p", `${record.kind} · published version ${record.versionNumber}`, "platform-eyebrow"),
    text("h3", record.title),
    text("p", record.abstract ?? "No public description has been provided.", "platform-subtitle")
  );
  heading.append(
    title,
    link("Back to data catalog", directoryHref("data", adapter?.kind), "platform-button secondary")
  );

  const preview = publicResourcePreview(record);
  const facts = document.createElement("dl");
  facts.className = "platform-public-resource-facts";
  for (const [label, value] of [
    ["Project", record.community.projectName],
    ["Organization", record.community.organizationName],
    ["License", record.license ?? "Not stated"],
    ["Attribution", record.attribution ?? "Not stated"],
    ["Language", record.language],
    ["Updated", new Date(record.freshness.catalogUpdatedAt).toLocaleString()],
    ["Source", record.provenance.namespace ?? "OpenGeo Studio native"],
    ["Source version", record.freshness.sourceVersion ?? "Not reported"],
    ["Public relationships", String(record.relationships.publicCount)],
    ["Rating", record.ratings.count > 0
      ? `${record.ratings.average.toFixed(1)} of 5 from ${record.ratings.count} ${record.ratings.count === 1 ? "rating" : "ratings"}`
      : "No ratings yet"]
  ]) {
    facts.append(text("dt", label), text("dd", value));
  }

  const keywords = document.createElement("div");
  keywords.className = "platform-public-resource-keywords";
  keywords.append(text("h4", "Keywords"));
  if (record.keywords.length) {
    const list = document.createElement("ul");
    for (const value of record.keywords) list.append(text("li", value));
    keywords.append(list);
  } else {
    keywords.append(text("p", "No public keywords.", "platform-note"));
  }

  const base = typeof adapter?.baseUrl === "string" ? adapter.baseUrl.replace(/\/$/, "") : "/api";
  const actions = document.createElement("div");
  actions.className = "platform-public-resource-actions";
  const metadata = link(
    "Open metadata JSON",
    `${base}${record.relationships.detailHref}`,
    "platform-button secondary"
  );
  metadata.rel = "nofollow";
  actions.append(metadata);
  if (record.preview.kind === "dataset") {
    const content = link(
      "Open preview GeoJSON",
      `${base}${record.preview.href}`,
      "platform-button secondary"
    );
    content.rel = "nofollow";
    actions.append(content);
  } else if (record.preview.kind === "dataset-document") {
    const content = link(
      "Open document presentation JSON",
      `${base}${record.preview.href}`,
      "platform-button secondary"
    );
    content.rel = "nofollow";
    actions.append(content);
  } else if (record.preview.kind === "map") {
    const content = link(
      "Open map composition JSON",
      `${base}${record.preview.href}`,
      "platform-button secondary"
    );
    content.rel = "nofollow";
    actions.append(content);
  }
  article.append(heading, preview, facts, keywords, actions);
  return article;
}

function publicResourcePreview(record, preview = null, previewError = null) {
  const figure = document.createElement("figure");
  figure.className = "platform-public-resource-preview";
  figure.dataset.previewKind = record.preview.kind;
  if (preview && record.preview.kind === "map") {
    const rendered = publicMapPreviewGraphic(record, preview);
    figure.append(rendered.graphic, rendered.legend);
    const visible = preview.layers.filter((layer) => layer.visible).length;
    const returned = preview.layers.reduce((sum, layer) => sum + layer.numberReturned, 0);
    figure.append(text(
      "figcaption",
      `Published map v${preview.mapVersion} with ${preview.layers.length} exact-version ${preview.layers.length === 1 ? "layer" : "layers"}; ${visible} visible and ${returned.toLocaleString()} preview features rendered in saved draw order.`
    ));
    return figure;
  }
  if (preview && record.preview.kind === "document") {
    const frame = document.createElement("iframe");
    frame.className = "platform-public-resource-document-frame";
    frame.title = `${record.title} published content`;
    frame.setAttribute("sandbox", "");
    frame.referrerPolicy = "no-referrer";
    frame.srcdoc = preview.html;
    figure.append(frame);
    const omitted = preview.dependencyReferencesOmitted;
    figure.append(text(
      "figcaption",
      omitted === 0
        ? `Authored content from published version ${preview.resourceVersionNumber}. This preview runs without scripts or external requests.`
        : `Authored content from published version ${preview.resourceVersionNumber}. ${omitted} embedded ${omitted === 1 ? "reference is" : "references are"} omitted here; a sealed publication can present authorized maps, datasets, and files.`
    ));
    return figure;
  }
  if (preview && record.preview.kind === "dataset-document") {
    const presentation = publicDatasetDocumentPresentation(preview.presentation);
    figure.append(presentation);
    const visual = preview.presentationKind === "visual";
    figure.append(text(
      "figcaption",
      `${preview.sourceFormat.toUpperCase()} dataset v${preview.datasetVersionNumber}. ${visual ? "Each page uses a bounded, metadata-stripped image with semantic text below it." : "This bounded semantic presentation does not reproduce page layout or embedded media."}`
    ));
    return figure;
  }
  if (preview) {
    const rendered = publicSpatialPreviewGraphic(record, preview);
    figure.append(rendered.graphic);
    const matched = preview.numberMatched === null
      ? "an unreported source total"
      : `${preview.numberMatched.toLocaleString()} source features`;
    const qualifier = preview.mayBeTruncated
      ? " The derivative is a bounded sample."
      : " The derivative contains the full reported source count.";
    figure.append(text(
      "figcaption",
      `Rendered ${rendered.featureCount.toLocaleString()} of ${preview.numberReturned.toLocaleString()} returned features from ${matched}.${qualifier} Neutral catalog styling is shown here; saved map styles are not applied.`
    ));
    return figure;
  }
  if (["map", "dataset"].includes(record.preview.kind) && record.spatialExtent) {
    const [west, south, east, north] = record.spatialExtent;
    const width = 320;
    const height = 180;
    const rawX = (west + 180) / 360 * width;
    const rawY = (90 - north) / 180 * height;
    const rawWidth = (east - west) / 360 * width;
    const rawHeight = (north - south) / 180 * height;
    const boxWidth = Math.max(8, rawWidth);
    const boxHeight = Math.max(8, rawHeight);
    const boxX = Math.max(0, Math.min(width - boxWidth, rawX - (boxWidth - rawWidth) / 2));
    const boxY = Math.max(0, Math.min(height - boxHeight, rawY - (boxHeight - rawHeight) / 2));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Declared coverage from ${west}, ${south} to ${east}, ${north}`);
    const world = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    world.setAttribute("class", "platform-public-resource-world");
    world.setAttribute("x", "1");
    world.setAttribute("y", "1");
    world.setAttribute("width", String(width - 2));
    world.setAttribute("height", String(height - 2));
    const extent = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    extent.setAttribute("class", "platform-public-resource-extent");
    extent.setAttribute("x", boxX.toFixed(3));
    extent.setAttribute("y", boxY.toFixed(3));
    extent.setAttribute("width", boxWidth.toFixed(3));
    extent.setAttribute("height", boxHeight.toFixed(3));
    svg.append(world, extent);
    figure.append(svg);
  } else {
    const page = document.createElement("div");
    page.className = "platform-public-resource-page-preview";
    page.append(
      text("strong", record.kind === "service" ? "Published service record" : "Published resource summary"),
      text("p", record.abstract ?? "No public description has been provided.")
    );
    figure.append(page);
  }
  const caption = record.preview.kind === "metadata"
    ? "Metadata preview. Open the source project for governed content and version history."
    : record.preview.kind === "document"
      ? previewError
        ? "Authored content is unavailable. The public record and version details remain available."
        : "Loading authored content from the current published version."
    : record.preview.kind === "dataset-document"
      ? previewError
        ? "The document presentation is unavailable. The public record and version details remain available."
        : "Loading the exact published document presentation."
    : record.spatialExtent
      ? previewError
        ? "Feature preview is unavailable; declared coverage is shown instead. Saved map styling is not loaded."
        : "Declared coverage preview. A bounded feature preview is used when a current public derivative is available."
      : "No public spatial extent is available for this resource.";
  figure.append(text("figcaption", caption));
  return figure;
}

function publicDatasetDocumentPresentation(preview) {
  const article = document.createElement("article");
  article.className = "project-document-preview-content platform-public-dataset-document";
  if (preview.language) article.lang = preview.language;
  article.append(text(
    "h4",
    preview.title ?? (preview.sourceFormat === "pdf" ? "PDF presentation" : "OpenDocument preview")
  ));
  for (const page of preview.pages) {
    const section = document.createElement("section");
    section.className = "project-document-preview-page";
    section.setAttribute("aria-label", `Document page ${page.number}`);
    section.append(text(
      "p",
      `Page ${page.number}${page.textSource === "ocr" ? " · OCR text" : ""}`,
      "project-document-preview-page-number"
    ));
    if (page.imageBase64) {
      const image = document.createElement("img");
      image.className = "platform-public-dataset-document-page";
      image.src = `data:image/jpeg;base64,${page.imageBase64}`;
      image.alt = `Rendered page ${page.number}`;
      image.width = page.width;
      image.height = page.height;
      image.loading = "lazy";
      image.decoding = "async";
      section.append(image);
    }
    for (const block of page.blocks) {
      section.append(publicDatasetDocumentBlock(block, page.number));
    }
    if (!page.blocks.length) {
      section.append(text("p", "No semantic text was available for this page.", "platform-note"));
    }
    article.append(section);
  }
  return article;
}

function publicDatasetDocumentBlock(block, pageNumber) {
  if (block.type === "heading") {
    const heading = text("div", block.text, "project-document-preview-heading");
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", String(block.level));
    return heading;
  }
  if (block.type === "paragraph") return text("p", block.text);
  if (block.type === "list") {
    const list = document.createElement(block.ordered ? "ol" : "ul");
    for (const value of block.items) list.append(text("li", value));
    return list;
  }
  const table = document.createElement("table");
  table.className = "project-document-preview-table";
  const caption = document.createElement("caption");
  caption.textContent = block.label ?? `Table on document page ${pageNumber}`;
  table.append(caption);
  for (const [rowIndex, values] of block.rows.entries()) {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement(rowIndex < block.headerRows ? "th" : "td");
      if (cell.tagName === "TH") cell.scope = "col";
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);
  }
  return table;
}

function publicMapPreviewGraphic(record, preview) {
  const width = 640;
  const height = 360;
  const padding = 18;
  const maximumPositions = 50_000;
  const bounds = publicMapPreviewBounds(preview.layers, record.spatialExtent);
  const [west, south, east, north] = bounds;
  const longitudeSpan = Math.max(east - west, 0.000001);
  const latitudeSpan = Math.max(north - south, 0.000001);
  const projected = ([longitude, latitude]) => [
    padding + (longitude - west) / longitudeSpan * (width - padding * 2),
    padding + (north - latitude) / latitudeSpan * (height - padding * 2)
  ];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  const visibleLayerCount = preview.layers.filter((layer) => layer.visible).length;
  svg.setAttribute(
    "aria-label",
    `Published map composition with ${visibleLayerCount} visible ${visibleLayerCount === 1 ? "layer" : "layers"}`
  );
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("class", "platform-public-resource-world");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", String(width - 2));
  background.setAttribute("height", String(height - 2));
  svg.append(background);
  const budget = {positions: 0};
  const drawOrder = [...preview.layers]
    .filter((layer) => layer.visible)
    .sort((left, right) => right.order - left.order || right.layerId.localeCompare(left.layerId));
  drawOrder.forEach((layer) => {
    if (budget.positions >= maximumPositions) return;
    const paths = {points: [], lines: [], polygons: []};
    for (const feature of layer.geojson.features) {
      if (budget.positions >= maximumPositions) break;
      if (feature.geometry !== null) {
        publicSpatialGeometryPath(
          feature.geometry,
          projected,
          paths,
          budget,
          maximumPositions
        );
      }
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.dataset.layerId = layer.layerId;
    group.setAttribute("opacity", String(layer.opacity));
    const colors = publicMapLayerColors(layer.style, preview.layers.indexOf(layer));
    for (const [kind, values] of Object.entries(paths)) {
      if (!values.length) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `platform-public-resource-feature-${kind}`);
      path.setAttribute("d", values.join(" "));
      path.setAttribute("stroke", colors.stroke);
      path.setAttribute("stroke-width", String(colors.strokeWidth));
      if (kind === "polygons") {
        path.setAttribute("fill", colors.fill);
        path.setAttribute("fill-rule", "evenodd");
      } else if (kind === "points") {
        path.setAttribute("fill", colors.point);
      }
      group.append(path);
    }
    svg.append(group);
  });
  const legend = document.createElement("ol");
  legend.className = "platform-public-map-legend";
  for (const layer of [...preview.layers]
    .sort((left, right) => left.order - right.order || left.layerId.localeCompare(right.layerId))
  ) {
    const item = document.createElement("li");
    if (!layer.visible) item.dataset.visible = "false";
    const swatch = document.createElement("span");
    swatch.className = "platform-public-map-swatch";
    swatch.style.backgroundColor = publicMapLayerColors(
      layer.style,
      preview.layers.indexOf(layer)
    ).fill;
    item.append(
      swatch,
      text("span", layer.title),
      text("small", layer.visible ? `${layer.numberReturned.toLocaleString()} shown` : "hidden")
    );
    legend.append(item);
  }
  return {graphic: svg, legend};
}

function publicMapPreviewBounds(layers, fallback) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const layer of layers.filter((candidate) => candidate.visible)) {
    const candidate = publicSpatialPreviewBounds(layer.geojson, null);
    bounds[0] = Math.min(bounds[0], candidate[0]);
    bounds[1] = Math.min(bounds[1], candidate[1]);
    bounds[2] = Math.max(bounds[2], candidate[2]);
    bounds[3] = Math.max(bounds[3], candidate[3]);
  }
  if (bounds.every(Number.isFinite)) return nonzeroSpatialBounds(bounds);
  return nonzeroSpatialBounds(fallback ?? [-180, -90, 180, 90]);
}

function publicMapLayerColors(style, index) {
  const palette = ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#4d7c0f"];
  const fallback = palette[index % palette.length];
  const color = (value, alternative) => typeof value === "string"
    && /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,% ]+\))$/i.test(value)
    ? value
    : alternative;
  const width = Number(style?.strokeWidth ?? style?.lineWidth ?? 1.5);
  return {
    fill: color(style?.fill ?? style?.fillColor, fallback),
    stroke: color(style?.stroke ?? style?.lineColor, fallback),
    point: color(style?.circleColor ?? style?.color, fallback),
    strokeWidth: Number.isFinite(width) && width >= 0 && width <= 12 ? width : 1.5
  };
}

function publicSpatialPreviewGraphic(record, preview) {
  const width = 640;
  const height = 360;
  const padding = 18;
  const maximumFeatures = 1_000;
  const maximumPositions = 25_000;
  const bounds = publicSpatialPreviewBounds(preview.geojson, record.spatialExtent);
  const [west, south, east, north] = bounds;
  const longitudeSpan = Math.max(east - west, 0.000001);
  const latitudeSpan = Math.max(north - south, 0.000001);
  const projected = ([longitude, latitude]) => [
    padding + (longitude - west) / longitudeSpan * (width - padding * 2),
    padding + (north - latitude) / latitudeSpan * (height - padding * 2)
  ];
  const paths = {points: [], lines: [], polygons: []};
  const budget = {positions: 0};
  let featureCount = 0;
  for (const feature of preview.geojson.features.slice(0, maximumFeatures)) {
    if (budget.positions >= maximumPositions) break;
    if (feature.geometry !== null
      && publicSpatialGeometryPath(feature.geometry, projected, paths, budget, maximumPositions)) {
      featureCount += 1;
    }
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Public feature preview showing ${featureCount} of ${preview.numberReturned} returned features`
  );
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("class", "platform-public-resource-world");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", String(width - 2));
  background.setAttribute("height", String(height - 2));
  svg.append(background);
  for (const [kind, values] of Object.entries(paths)) {
    if (!values.length) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", `platform-public-resource-feature-${kind}`);
    path.setAttribute("d", values.join(" "));
    if (kind === "polygons") path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
  }
  return {graphic: svg, featureCount};
}

function publicSpatialPreviewBounds(geojson, fallback) {
  if (Array.isArray(geojson.bbox) && geojson.bbox.length >= 4) {
    const half = geojson.bbox.length / 2;
    return nonzeroSpatialBounds([
      geojson.bbox[0],
      geojson.bbox[1],
      geojson.bbox[half],
      geojson.bbox[half + 1]
    ]);
  }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
      return;
    }
    for (const item of value) visit(item);
  };
  const geometryCoordinates = (geometry) => {
    if (geometry?.type === "GeometryCollection") {
      for (const child of geometry.geometries) geometryCoordinates(child);
    } else {
      visit(geometry?.coordinates);
    }
  };
  for (const feature of geojson.features) geometryCoordinates(feature.geometry);
  if (bounds.every(Number.isFinite)) return nonzeroSpatialBounds(bounds);
  return nonzeroSpatialBounds(fallback ?? [-180, -90, 180, 90]);
}

function nonzeroSpatialBounds([west, south, east, north]) {
  const longitudePadding = west === east ? 0.01 : 0;
  const latitudePadding = south === north ? 0.01 : 0;
  return [
    Math.max(-180, west - longitudePadding),
    Math.max(-90, south - latitudePadding),
    Math.min(180, east + longitudePadding),
    Math.min(90, north + latitudePadding)
  ];
}

function publicSpatialGeometryPath(geometry, project, paths, budget, maximumPositions) {
  const coordinate = (position) => {
    if (budget.positions >= maximumPositions) return null;
    budget.positions += 1;
    return project(position).map((value) => value.toFixed(2));
  };
  const point = (position) => {
    const value = coordinate(position);
    if (!value) return false;
    const [x, y] = value;
    paths.points.push(`M${x},${y}m-2,0a2,2 0 1,0 4,0a2,2 0 1,0 -4,0`);
    return true;
  };
  const line = (positions, target, close = false) => {
    const values = [];
    for (const position of positions) {
      const value = coordinate(position);
      if (!value) break;
      values.push(value);
    }
    if (values.length < (close ? 3 : 2)) return false;
    target.push(`${values.map(([x, y], index) => `${index ? "L" : "M"}${x},${y}`).join("")}${close ? "Z" : ""}`);
    return true;
  };
  if (geometry.type === "Point") return point(geometry.coordinates);
  if (geometry.type === "MultiPoint") {
    return geometry.coordinates.map(point).some(Boolean);
  }
  if (geometry.type === "LineString") return line(geometry.coordinates, paths.lines);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map((positions) => line(positions, paths.lines)).some(Boolean);
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) => line(ring, paths.polygons, true)).some(Boolean);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap((polygon) => polygon)
      .map((ring) => line(ring, paths.polygons, true)).some(Boolean);
  }
  return geometry.geometries
    .map((child) => publicSpatialGeometryPath(child, project, paths, budget, maximumPositions))
    .some(Boolean);
}

function publicationDirectory(state) {
  const section = document.createElement("section");
  section.className = "platform-publication-directory";
  section.append(
    text("p", "Account publication registry", "platform-eyebrow"),
    text("h2", "Listed publications"),
    text(
      "p",
      "Each row is one active immutable edition. Open the public result directly, or open its project to edit the private source and prepare the next reviewed edition.",
      "platform-subtitle"
    )
  );
  if (state.directoryDetailsLoading) {
    section.append(text("p", "Loading the publication registry…", "platform-note"));
    return section;
  }
  const page = state.publicSiteDirectory ?? {records: [], numberMatched: 0};
  if (!page.records.length) {
    section.append(
      text(
        "p",
        "No active listed publication is visible. Open a publication project, choose Listed, complete review, and publish an edition.",
        "platform-note"
      )
    );
    return section;
  }
  const table = document.createElement("table");
  table.className = "data-table platform-publication-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Publication", "Source project", "Pages", "Published", "Actions"]) {
    headRow.append(text("th", label));
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  const apiBase = typeof state.adapter?.baseUrl === "string"
    ? state.adapter.baseUrl.replace(/\/$/, "")
    : "/api";
  for (const record of page.records) {
    const row = document.createElement("tr");
    if (record.isPrimary) row.dataset.primary = "true";
    const publication = document.createElement("td");
    const identity = document.createElement("div");
    identity.className = "platform-publication-identity";
    identity.append(
      link(record.title, `${apiBase}${record.href}`),
      text(
        "small",
        `${record.isPrimary ? "Primary home · " : ""}/${record.listedSlug}/ · ${record.theme}`
      )
    );
    publication.append(identity);
    const actions = document.createElement("td");
    actions.className = "platform-publication-actions";
    actions.append(
      link("Open public site", `${apiBase}${record.href}`, "platform-button platform-button-secondary"),
      link(
        "Edit source",
        applicationProjectHref(record.projectId, {
          adapterKind: state.adapter?.kind,
          management: "publishing"
        }),
        "platform-button platform-button-secondary"
      )
    );
    row.append(
      publication,
      text("td", record.projectName),
      text("td", String(record.pageCount)),
      text("td", new Date(record.publishedAt).toLocaleDateString()),
      actions
    );
    body.append(row);
  }
  table.append(head, body);
  section.append(
    text(
      "p",
      `${page.numberMatched} active listed publication${page.numberMatched === 1 ? "" : "s"}. Primary resolution uses the newest active edition sealed as primary; named paths remain independent.`,
      "platform-note"
    ),
    table
  );
  return section;
}

export function catalogTable(datasets, projects, adapterKind = null, {adapter=null,placeUri=null,expandGroups=true,groupState=null} = {}) {
  if (!datasets.length) return text("p", "No matching datasets are visible to your role.", "platform-note");
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const root = document.createElement("div");
  root.className = "platform-catalog-grouped-results";
  root.style.minWidth = "0";
  root.append(text("small", "Grouped by data library · counts show loaded records", "platform-note"));
  const groups = new Map(), retainedIds = new Set();
  const previews = new Set();
  let disposed = false;
  root.dispose = () => {disposed = true; for (const preview of previews) preview.dispose(); previews.clear();};
  const appendRecords = records => {for (const dataset of records) {
    if (disposed) return;
    if (retainedIds.has(dataset.id)) continue;
    retainedIds.add(dataset.id);
    // Only the recorded library identity defines a relationship. Similar names,
    // provider types and geographic tags do not establish one.
    const key = dataset.projectId ?? null;
    let group = groups.get(key);
    if (!group) {
      const details = document.createElement("details");
      details.className = "catalog-source-group platform-catalog-resource-group";
      if (key) details.dataset.projectId = key;
      details.dataset.groupKey = JSON.stringify(["resource-library", key]);
      details.open = groupState?.get(details.dataset.groupKey) ?? expandGroups;
      const summary = document.createElement("summary"), count = text("span", "");
      summary.append(text("strong", projectNames.get(key) ?? (key ? "Data library unavailable" : "Individually accessible datasets")), count);
      const scroll = document.createElement("div");
      scroll.className = "catalog-directory-scroll";
      scroll.style.maxWidth = "100%";
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", `${projectNames.get(key) ?? "Accessible datasets"} loaded datasets`);
      const table = document.createElement("table");
      table.className = "data-table platform-catalog-table";
      const head = document.createElement("thead"), headRow = document.createElement("tr");
      for (const label of ["Dataset", "Data library", "Format", "Preservation", "Sensitivity", "Spatial search", "Updated"]) {
        const heading = text("th", label); heading.scope = "col"; headRow.append(heading);
      }
      head.append(headRow);
      const body = document.createElement("tbody");
      table.append(head, body); scroll.append(table); details.append(summary, scroll); root.append(details);
      group = {body, count, loaded:0}; groups.set(key, group);
    }
    const row = document.createElement("tr");
    row.className = "platform-catalog-resource-row";
    row.dataset.datasetId = dataset.id;
    const identity = document.createElement("td");
    identity.append(link(dataset.name, layerHref(dataset.id, {adapterKind})));
    const mapAction = CatalogResourceMapAction({dataset, adapter, beforeOpen: () => {
      if (mapAction.panel.isConnected) return;
      const previewRow = document.createElement("tr");
      previewRow.className = "platform-catalog-map-row";
      const previewCell = document.createElement("td");
      previewCell.colSpan = 7;
      previewCell.append(mapAction.panel);
      previewRow.append(previewCell);
      row.after(previewRow);
    }});
    if (mapAction) {previews.add(mapAction); identity.append(mapAction.button);}
    if(placeUri && typeof adapter?.getDatasetKnowledge === "function") identity.append(CatalogPlaceMatch({adapter,datasetId:dataset.id,placeUri}));
    const preservation = document.createElement("td");
    preservation.append(CatalogPreservationStatus({dataset, detailsHref: layerHref(dataset.id, {adapterKind}), compact:true}));
    row.append(
      identity,
      text("td", projectNames.get(dataset.projectId) ?? "Explicit dataset grant"),
      text("td", dataset.format),
      preservation,
      badgeCell(dataset.classification),
      text("td", catalogSpatialStatus(dataset)),
      text("td", new Date(dataset.updatedAt).toLocaleDateString())
    );
    group.body.append(row);
    group.loaded++;
    group.count.textContent = `${group.loaded} loaded ${group.loaded === 1 ? "dataset" : "datasets"}`;
  }};
  root.appendRecords = appendRecords;
  appendRecords(datasets);
  return root;
}

export function modeBanner(adapter) {
  const banner = document.createElement("div");
  banner.className = `platform-mode platform-mode-${adapter?.kind ?? "unknown"}`;
  banner.dataset.adapter = adapter?.kind ?? "unknown";
  banner.textContent = adapter?.kind === "fixture"
    ? "Fixture adapter · browser test data · changes are memory-only"
    : "Live API adapter · PostgreSQL-backed records";
  return banner;
}

function projectTable(projects, clients, adapterKind = null) {
  if (!projects.length) {
    const empty = document.createElement("section");
    empty.className = "platform-state platform-state-empty";
    empty.dataset.state = "empty";
    empty.append(text("h3", "No matching access workspaces"), text("p", "Change the filters or ask an account admin for workspace access."));
    return empty;
  }

  const list = document.createElement("ul");
  list.className = "platform-project-list platform-project-table";
  list.setAttribute("aria-label", "Available access workspaces");
  for (const project of projects) {
    const item = document.createElement("li");
    const row = link("", applicationProjectHref(project.id, {
      adapterKind, management: "settings"
    }), "platform-project-row");
    row.setAttribute("aria-label", `Open ${project.name}`);
    const identity = document.createElement("span");
    identity.className = "platform-project-row-identity";
    const title = document.createElement("span");
    title.className = "platform-project-row-title";
    title.append(text("strong", project.name));
    if (project.projectCode === "MASSGIS-DEMO" || /^MassGIS\b/i.test(project.name)) {
      title.append(text("span", "MassGIS", "platform-project-kind"));
    }
    title.append(text(
      "span",
      project.visibility === "published" ? "Published" : "Internal",
      `platform-project-kind ${project.visibility === "published" ? "published" : "internal"}`
    ));
    identity.append(
      title,
      text("span", project.description ?? "No description", "platform-record-description")
    );
    const client = clients.get(project.clientId);
    const metadata = document.createElement("span");
    metadata.className = "platform-project-row-metadata";
    metadata.append(
      labeledValue("Client", client?.name ?? (project.clientId ? "Restricted client" : "No client")),
      labeledValue("Role", project.callerRole ?? "organization admin", "badge"),
      labeledValue("Status", project.status, `badge ${project.status}`),
      labeledValue("Updated", new Date(project.updatedAt).toLocaleDateString())
    );
    const open = text("span", "Open", "platform-project-row-open");
    open.setAttribute("aria-hidden", "true");
    row.append(identity, metadata, open);
    item.append(row);
    list.append(item);
  }
  return list;
}

function labeledValue(label, value, valueClass = "") {
  const item = document.createElement("span");
  item.className = "platform-project-row-value";
  item.append(
    text("small", label),
    text("span", value, valueClass)
  );
  return item;
}

function projectHref(projectId, adapterKind = null) {
  return applicationProjectHref(projectId, {adapterKind});
}

function badgeCell(value) {
  const cell = document.createElement("td");
  const badge = text("span", value, `badge ${value}`);
  cell.append(badge);
  return cell;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function link(label, href, className = "") {
  const element = text("a", label, className);
  element.href = href;
  return element;
}

function badge(value) {
  return text("span", value, `badge ${value}`);
}

function action(label, handler) {
  const button = text("button", label, "platform-button");
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function option(value, label) {
  const element = text("option", label);
  element.value = value;
  return element;
}
