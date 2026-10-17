import {ResourceKnowledge} from "./ResourceKnowledge.js";
import {CollectionSharing} from "./CollectionSharing.js";
import {collectionHref, collectionRouteTarget, compositionHref, publicationHref} from "../lib/applicationRoutes.js";
import {serializeSavedCollection} from "../lib/collectionExport.js";

export function CollectionDirectory({adapter, initialCollectionId = null, updateLocation = true}) {
  const root = node("section"), status = node("p"), directory = node("div"), editor = node("div");
  root.className = "collection-directory"; status.setAttribute("role", "status");
  let disposed = false, busy = false, blockingRequest = false, dirty = false, selected = null, draft = null, offset = 0;
  let savedRecord = null, savedContext = null, renderGeneration = 0;
  const downloadUrls = new Set();
  directory.className = "collection-gallery"; directory.setAttribute("role", "region"); directory.setAttribute("aria-label", "Collection gallery");
  let activeFilters = {query: "", visibility: "", sort: "updated"};
  const search = input("Find Collections", 200);
  const visibilityFilter = node("select"); visibilityFilter.setAttribute("aria-label", "Filter Collection visibility");
  for (const [value, label] of [["", "All visibility"], ["private", "Private"], ["account", "Account"], ["public", "Public"]]) {
    const option = node("option", label); option.value = value; visibilityFilter.append(option);
  }
  const sort = node("select"); sort.setAttribute("aria-label", "Sort Collections");
  for (const [value, label] of [["updated", "Last updated"], ["title", "Title"], ["created", "Newest created"]]) {
    const option = node("option", label); option.value = value; sort.append(option);
  }
  const apply = button("Apply Collection filters", () => runRead(async () => {
    const filters = {query: search.value.trim(), visibility: visibilityFilter.value, sort: sort.value};
    const page = await adapter.listCollections({...filters, limit: 50, offset: 0});
    await ensureRequestedAccount();
    if (disposed) return;
    activeFilters = filters; offset = 0; directory.replaceChildren(); showPage(page);
  }));
  let memberView = {query: "", kind: "", sort: "order"};
  let knowledge=null;
  const knowledgeBlocked=()=>knowledge?.shouldBlockNavigation()??false;
  const controls = node("fieldset"), title = input("New Collection title", 200);
  const createOwner = typeof adapter?.listCollectionOwnerCandidates === "function"
    ? ownerPicker({creating: true}) : null;
  const create = button("Create Collection", async () => {
    if (!title.value.trim()) {status.textContent = "Enter a Collection title."; return;}
    if (createOwner && !createOwner.ready()) {status.textContent = "Load and select an owner of this type before creating the Collection."; return;}
    await run(async () => {
      const context = await currentActionContext();
      await createOwner?.assertCurrent();
      await assertActionContext(context);
      const owner = createOwner?.owner();
      const receipt = await adapter.createCollection({title: title.value.trim(), ...(owner ? {owner} : {})}, {context});
      await assertActionContext(context);
      title.value = "";
      createOwner?.reset();
      await open(receipt.id);
      await assertActionContext(context);
      const page = await adapter.listCollections({...activeFilters, limit: 50, offset: 0});
      await assertActionContext(context);
      if (!disposed) {offset = 0; directory.replaceChildren(); showPage(page);}
    }, "Collection created. It is private to its owner and account administrators; member content keeps its own access.");
  });
  const more = button("Load Collections", () => runRead(load));
  controls.append(title);
  if (createOwner) controls.append(createOwner.element);
  controls.append(create, search, visibilityFilter, sort, apply, more); root.append(status, controls, directory, editor);
  root.hasUnsavedChanges = () => dirty || (knowledge?.hasUnsavedChanges()??false);
  root.shouldBlockNavigation = () => dirty || blockingRequest || knowledgeBlocked();
  root.currentHref = () => selected ? collectionNavigationHref(selected) : browser.location.href;
  root.dispose = () => {
    disposed = true; ++renderGeneration;
    for (const url of downloadUrls) browser.URL.revokeObjectURL(url);
    downloadUrls.clear();
  };
  const beforeUnload = event => {if (root.shouldBlockNavigation()) {event.preventDefault(); event.returnValue = "";}};
  const browser = root.ownerDocument.defaultView;
  const routeParameters = new URL(browser.location.href).searchParams;
  const requestedAccount = initialCollectionId || collectionRouteTarget(routeParameters)
    ? routeParameters.get("collectionAccount") : null;
  const accountPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let routeAccountReady = requestedAccount === null;
  browser.addEventListener("beforeunload", beforeUnload);
  const originalDispose = root.dispose;
  root.dispose = () => {originalDispose(); browser.removeEventListener("beforeunload", beforeUnload);};
  if (typeof adapter?.listCollections !== "function") {
    controls.disabled = true; status.textContent = "Collections require a connected Studio account.";
  } else void runRead(async () => {
    const id = initialCollectionId ?? collectionRouteTarget(new URL(browser.location.href).searchParams);
    if (id) await open(id);
    else await load();
  });
  return root;

  function lock() {
    if(disposed)return;
    controls.disabled=busy||dirty||knowledgeBlocked()||!routeAccountReady;
    editor.querySelectorAll("fieldset").forEach(field=>{
      field.disabled=field.dataset.collectionExport==="true" ? busy||dirty||knowledgeBlocked()||
        !savedContext||savedRecord?.revision!==draft?.revision||field.dataset.available!=="true"
        : field.dataset.collectionOwner==="true" ? busy||dirty||knowledgeBlocked()||draft?.role!=="owner"
        : field.dataset.knowledge==="true" ? busy||dirty
        : busy||knowledgeBlocked()||(draft?.role==="reader"&&field.dataset.edit==="true");
    });
  }
  // Read-only loading still serializes controls; other operations keep navigation guarded.
  function runRead(action) {return run(action, "", {readOnly: true});}
  async function run(action, success = "", {readOnly = false} = {}) {
    if (busy || disposed || knowledgeBlocked()) return;
    busy = true; blockingRequest = !readOnly; controls.disabled = true;
    editor.querySelectorAll("fieldset").forEach(field => {field.disabled = true;});
    status.textContent = "Loading…";
    try {await ensureRequestedAccount(); if (disposed) return; await action(); if (!disposed && success !== null) status.textContent = success;}
    catch (error) {
      if (requestedAccount !== null && error?.code === "organization_scope_changed") routeAccountReady = false;
      if (!disposed) status.textContent = error?.code === "collection_account_required"
        || (requestedAccount !== null && error?.code === "organization_scope_changed")
        ? "Select the account associated with this Collection, then reopen its link."
        : ["collection_export_changed", "collection_context_changed"].includes(error?.code)
        ? "Your sign-in, account or saved Collection changed. Reopen the saved Collection before continuing."
        : error?.status === 409
        ? "The Collection changed or a member is unavailable. Your draft is retained. Discard and reload to review the saved version."
        : "The request could not be completed. Your draft is retained; retry or reopen the saved Collection.";
    } finally {
      busy = false; blockingRequest = false;
      if (!disposed) {
        lock();
      }
    }
  }
  function card(record) {
    const item = node("article"); item.className = "collection-card"; item.dataset.collectionId = record.id; item.collectionRecord = record;
    const preview = node("div"); preview.className = "collection-card-preview";
    for (const member of record.member_preview ?? []) {
      preview.append(node("p", `${member.kind === "project" ? "Project" : "Publication"} · ${member.title}`));
    }
    if (!preview.childElementCount) preview.append(node("p", "Projects and Publications"));
    const openButton = button(record.title, () => {
      if (dirty || knowledgeBlocked()) {status.textContent = "Save or discard your draft before opening another Collection."; return;}
      void runRead(() => open(record.id));
    });
    openButton.className = "collection-card-title";
    const scope = {private: "Private", account: "Account", public: "Public"}[record.visibility ?? "private"];
    const details = [scope, record.visible_member_count == null ? null : `${record.visible_member_count} accessible members`, ownerDescription(record)].filter(Boolean);
    item.append(preview, openButton, node("p", details.join(" · ")));
    if (typeof adapter.collectionImagePreviews === "function") {
      const feedback = node("p"); feedback.setAttribute("role", "status");
      const loadImages = button("Load image previews", async () => {
        if (disposed || !item.isConnected || loadImages.disabled) return;
        loadImages.disabled = true; feedback.textContent = "Loading available image previews…";
        try {
          const images = await adapter.collectionImagePreviews(record.id);
          if (disposed || !item.isConnected) return;
          for (const old of preview.querySelectorAll("figure")) old.remove();
          for (const image of images.slice(0, 4)) {
            const figure = node("figure"), img = node("img");
            img.loading = "lazy"; img.alt = image.title; img.referrerPolicy = "no-referrer";
            img.src = image.url;
            img.addEventListener("error", () => {
              if (disposed || !img.isConnected) return;
              figure.remove(); loadImages.disabled = false;
              feedback.textContent = "An image is unavailable. Use Load image previews to retry; text previews remain available.";
            });
            figure.append(img, node("figcaption", `${image.title} · ${image.attribution} · ${image.license}`));
            preview.append(figure);
          }
          feedback.textContent = images.length ? "Available image previews loaded." : "No eligible image previews. Text previews remain available.";
        } catch {
          if (!disposed && item.isConnected) {
            loadImages.disabled = false;
            feedback.textContent = "Image previews could not load. Use Load image previews to retry; text previews remain available.";
          }
        }
      });
      item.append(loadImages, feedback);
    }
    if (record.description) item.append(node("p", record.description));
    if (record.updated_at) {
      const date = new Date(record.updated_at);
      if (Number.isFinite(date.getTime())) {const time = node("time", `Updated ${date.toLocaleDateString()}`); time.dateTime = record.updated_at; item.append(time);}
    }
    return item;
  }
  function showPage(page) {
    if (!offset) directory.replaceChildren();
    for (const record of page) directory.append(card(record));
    offset += page.length; more.hidden = page.length < 50; more.textContent = "Load more Collections";
    if (!offset) directory.textContent = activeFilters.query || activeFilters.visibility
      ? "No Collections match these filters." : "No Collections yet. Create one to organize your work.";
  }
  async function load() {
    await ensureRequestedAccount();
    const page = await adapter.listCollections({...activeFilters, limit: 50, offset});
    await ensureRequestedAccount();
    if (!disposed) showPage(page);
  }
  async function open(id) {
    await ensureRequestedAccount();
    const context = await currentExportContext();
    const record = await adapter.getCollection(id);
    await ensureRequestedAccount();
    if (disposed) return;
    if (context && (!await exportContextMatches(context) || !exportContextMatchesNow(context))) throw exportChanged();
    if (disposed) return;
    if (selected !== id) memberView = {query: "", kind: "", sort: "order"};
    selected = id; savedRecord = structuredClone(record); savedContext = context;
    draft = structuredClone(record); dirty = false;
    const existingCard = [...directory.children].find(item => item.dataset.collectionId === id);
    if (existingCard) existingCard.replaceWith(card({...existingCard.collectionRecord, ...record,
      visible_member_count: record.members.filter(member => member.available).length,
      member_preview: record.members.filter(member => member.available).slice(0, 4)}));
    if (updateLocation) browser.history.replaceState(null, "", collectionNavigationHref(id));
    render();
  }
  function changed() {dirty = true; lock(); status.textContent = "Unsaved Collection changes.";}
  function collectionNavigationHref(id) {
    const href = collectionHref(id, {adapterKind: adapter.kind});
    return requestedAccount === null ? href : `${href}&collectionAccount=${encodeURIComponent(requestedAccount)}`;
  }
  async function ensureRequestedAccount() {
    if (requestedAccount === null) return;
    routeAccountReady = accountPattern.test(requestedAccount) && typeof adapter.organizationProvider === "function" &&
      String(await adapter.organizationProvider()).toLowerCase() === requestedAccount.toLowerCase() &&
      String(adapter.organizationProvider()).toLowerCase() === requestedAccount.toLowerCase();
    if (!routeAccountReady) {
      throw Object.assign(new Error("Collection account must be selected"), {code: "collection_account_required"});
    }
  }
  function exportChanged() {
    return Object.assign(new Error("Collection export context changed"), {code: "collection_export_changed"});
  }
  async function currentExportContext() {
    const tokenProvider = adapter.tokenProvider, organizationProvider = adapter.organizationProvider, baseUrl = adapter.baseUrl;
    if (typeof tokenProvider !== "function" || typeof organizationProvider !== "function") return null;
    const organization = await organizationProvider.call(adapter);
    const token = await tokenProvider.call(adapter);
    if (typeof token !== "string" || !token || !accountPattern.test(organization ?? "")) return null;
    const context = {tokenProvider, organizationProvider, baseUrl, token, organization: organization.toLowerCase()};
    return await exportContextMatches(context) ? context : null;
  }
  async function currentActionContext() {
    const context = await currentExportContext();
    if (!context && (typeof adapter.tokenProvider === "function" || typeof adapter.organizationProvider === "function")) throw exportChanged();
    return context;
  }
  async function assertActionContext(context) {
    await ensureRequestedAccount();
    if (disposed || (context && (!await exportContextMatches(context) || !exportContextMatchesNow(context)))) throw exportChanged();
  }
  function ownerPicker({creating = false, collectionId = null, generation = null, revision = null} = {}) {
    const element = node("fieldset"), kind = node("select"), choice = node("select");
    const feedback = node("p"); feedback.setAttribute("role", "status");
    element.append(node("legend", creating ? "Collection owner" : "Transfer Collection ownership"));
    if (!creating) element.dataset.collectionOwner = "true";
    kind.setAttribute("aria-label", creating ? "Collection owner type" : "New owner type");
    choice.setAttribute("aria-label", creating ? "Collection owner" : "New owner");
    for (const [value, label] of [["user", "User"], ["team", "Team"], ["organization", "Organization"]]) {
      const option = node("option", label); option.value = value; kind.append(option);
    }
    let records = new Map(), pageOffset = 0, context = null, selectionGeneration = 0;
    const current = () => !disposed && element.isConnected && (creating ||
      generation === renderGeneration && selected === collectionId && draft?.revision === revision && !dirty && !knowledgeBlocked());
    const reset = () => {
      records = new Map(); pageOffset = 0; context = null; ++selectionGeneration;
      const option = node("option", creating && kind.value === "user" ? "Myself (default)" : "Select a loaded owner");
      option.value = ""; choice.replaceChildren(option); browse.hidden = false;
      browse.textContent = creating ? "Load eligible owners" : "Load transfer owners";
      feedback.textContent = "Load owners you can assign in the selected account. This changes no member access.";
    };
    const assertCurrent = async () => {
      if (!current()) throw exportChanged();
      if (choice.value) {
        if (!records.has(choice.value)) throw exportChanged();
        await assertActionContext(context);
      }
      if (!current()) throw exportChanged();
    };
    const browse = button(creating ? "Load eligible owners" : "Load transfer owners", () => runRead(async () => {
      const originalGeneration = selectionGeneration, originalKind = kind.value;
      const requestContext = context ?? await currentActionContext();
      await assertActionContext(requestContext);
      if (!current()) throw exportChanged();
      const page = await adapter.listCollectionOwnerCandidates(originalKind, {collectionId, limit: 50, offset: pageOffset, context: requestContext});
      await assertActionContext(requestContext);
      if (!current() || originalGeneration !== selectionGeneration || originalKind !== kind.value) throw exportChanged();
      context = requestContext;
      for (const candidate of page) {
        const key = `${candidate.principal_type}:${candidate.principal_id}`;
        if (records.has(key)) continue;
        records.set(key, candidate);
        const option = node("option", candidate.name); option.value = key; choice.append(option);
      }
      pageOffset += page.length; browse.hidden = page.length < 50;
      browse.textContent = creating ? "Load more eligible owners" : "Load more transfer owners";
      feedback.textContent = records.size ? `${records.size} eligible owners loaded. Select one before applying ownership.`
        : "No eligible owners of this type in this account.";
    }));
    kind.addEventListener("change", reset);
    element.append(kind, choice, browse, feedback); reset();
    return {element, reset, assertCurrent,
      ready: () => Boolean(records.has(choice.value) || creating && kind.value === "user" && !choice.value),
      owner: () => {
        const candidate = records.get(choice.value);
        return candidate ? {principal_type: candidate.principal_type, principal_id: candidate.principal_id} : undefined;
      }};
  }
  async function exportContextMatches(context) {
    if (disposed || adapter.tokenProvider !== context.tokenProvider || adapter.organizationProvider !== context.organizationProvider ||
        adapter.baseUrl !== context.baseUrl) return false;
    const organization = await context.organizationProvider.call(adapter);
    const token = await context.tokenProvider.call(adapter);
    return String(organization).toLowerCase() === context.organization && token === context.token && exportContextMatchesNow(context);
  }
  function exportContextMatchesNow(context) {
    return !disposed && adapter.tokenProvider === context.tokenProvider && adapter.organizationProvider === context.organizationProvider &&
      adapter.baseUrl === context.baseUrl && context.tokenProvider.call(adapter) === context.token &&
      String(context.organizationProvider.call(adapter)).toLowerCase() === context.organization;
  }
  function matchesSavedContext(record, context) {
    const reference = record.definition.reference;
    const authority = new URL(context.baseUrl, browser.location.href).href.replace(/\/$/, "");
    return reference.authority === authority && reference.workspace_id === `account:${context.organization}`;
  }
  function render() {
    const generation = ++renderGeneration;
    knowledge=null;
    editor.replaceChildren();
    const permalink = node("a", "Link to this Collection");
    permalink.href = collectionNavigationHref(selected);
    const heading = node("h3", draft.title), fields = node("fieldset"); fields.dataset.edit = "true";
    fields.disabled = draft.role === "reader";
    const name = input("Collection title", 200); name.value = draft.title;
    const description = node("textarea"); description.setAttribute("aria-label", "Collection description");
    description.maxLength = 10000; description.value = draft.description;
    name.addEventListener("input", () => {draft.title = name.value; changed();});
    description.addEventListener("input", () => {draft.description = description.value; changed();});
    const members = node("ol"); members.className = "collection-member-grid"; members.setAttribute("aria-label", "Collection members");
    const memberFilters = node("fieldset"), memberQuery = input("Find Collection members", 200);
    memberFilters.append(node("legend", "Browse Collection members"));
    memberQuery.value = memberView.query;
    const memberKind = node("select"), memberSort = node("select");
    memberKind.setAttribute("aria-label", "Filter Collection member type");
    memberSort.setAttribute("aria-label", "Sort Collection members");
    for (const [value, label] of [["", "Projects and Publications"], ["project", "Projects"], ["publication", "Publications"]]) {
      const option = node("option", label); option.value = value; memberKind.append(option);
    }
    for (const [value, label] of [["order", "Saved order"], ["title", "Title"]]) {
      const option = node("option", label); option.value = value; memberSort.append(option);
    }
    memberKind.value = memberView.kind; memberSort.value = memberView.sort;
    const memberStatus = node("p"); memberStatus.setAttribute("role", "status");
    const memberImages = new Map();
    const previewStatus = node("p"); previewStatus.setAttribute("role", "status");
    let loadMemberImages = null;
    if (typeof adapter.collectionImagePreviews === "function") {
      const previewCollectionId = selected;
      loadMemberImages = button("Load member previews", async () => {
        if (loadMemberImages.disabled || disposed) return;
        loadMemberImages.disabled = true;
        previewStatus.textContent = "Loading up to four available previews…";
        try {
          const images = await adapter.collectionImagePreviews(previewCollectionId);
          if (disposed || !members.isConnected || selected !== previewCollectionId) return;
          memberImages.clear();
          for (const image of images.slice(0, 4)) {
            if (draft.members.some(member => member.available && member.entry_id === image.entryId)) memberImages.set(image.entryId, image);
          }
          showMembers();
          previewStatus.textContent = memberImages.size ? "Available previews loaded. Other members retain their text links." : "No eligible image previews. Member links remain available.";
        } catch {
          if (!disposed && members.isConnected && selected === previewCollectionId) {
            loadMemberImages.disabled = false;
            previewStatus.textContent = "Previews could not load. Use Load member previews to retry; your draft and member links remain available.";
          }
        }
      });
      memberFilters.append(loadMemberImages, previewStatus);
    }
    const applyMemberView = () => {
      memberView = {query: memberQuery.value, kind: memberKind.value, sort: memberSort.value};
      showMembers();
    };
    memberQuery.addEventListener("input", applyMemberView);
    memberKind.addEventListener("change", applyMemberView); memberSort.addEventListener("change", applyMemberView);
    memberFilters.append(memberQuery, memberKind, memberSort, button("Reset member view", () => {
      memberQuery.value = memberKind.value = ""; memberSort.value = "order"; applyMemberView();
    }), memberStatus);
    function showMembers() {
      const query = memberView.query.trim().toLocaleLowerCase();
      const canReorder = !query && !memberView.kind && memberView.sort === "order";
      const visible = draft.members.map((member, index) => ({member, index})).filter(({member}) =>
        (!memberView.kind || (member.available && member.kind === memberView.kind)) &&
        (!query || (member.available && member.title.toLocaleLowerCase().includes(query))));
      if (memberView.sort === "title") visible.sort((a, b) =>
        Number(b.member.available) - Number(a.member.available) ||
        (a.member.title ?? "").localeCompare(b.member.title ?? "") || a.index - b.index);
      memberStatus.textContent = `Showing ${visible.length} of ${draft.members.length} references. ${canReorder ? "" : "Reset to the full saved order to move references."}`;
      members.replaceChildren(...visible.map(({member, index}) => {
        const row = node("li"); row.className = "collection-member-card";
        if (member.available) {
          const link = node("a", `${member.kind === "project" ? "Project" : "Publication"}: ${member.title}`);
          link.href = (member.kind === "project" ? compositionHref : publicationHref)(member.target_id, {adapterKind: adapter.kind}); row.append(link);
          const image = memberImages.get(member.entry_id);
          if (image) {
            const figure = node("figure"), img = node("img");
            img.loading = "lazy"; img.alt = member.title; img.referrerPolicy = "no-referrer";
            img.src = image.url;
            img.addEventListener("error", () => {
              if (disposed || !img.isConnected) return;
              figure.remove(); memberImages.delete(member.entry_id);
              if (loadMemberImages) loadMemberImages.disabled = false;
              previewStatus.textContent = "An image is unavailable. Use Load member previews to retry; the member link remains available.";
            });
            figure.append(img, node("figcaption", `${image.attribution} · ${image.license}`)); row.append(figure);
          }
        } else row.append(node("span", "Unavailable member"));
        if (draft.role !== "reader") {
          const up = button("Move up", () => move(index, -1)), down = button("Move down", () => move(index, 1));
          up.disabled = !canReorder || index === 0; down.disabled = !canReorder || index === draft.members.length - 1;
          row.append(up, down, button("Remove reference", () => {draft.members.splice(index, 1); changed(); showMembers();}));
        }
        return row;
      }));
    }
    function move(index, delta) {
      [draft.members[index], draft.members[index + delta]] = [draft.members[index + delta], draft.members[index]];
      changed(); showMembers();
    }
    showMembers();
    const picker = node("div");
    const kind = node("select"); kind.setAttribute("aria-label", "Member type");
    for (const [value, label] of [["project", "Projects"], ["publication", "Publications"]]) {
      const option = node("option", label); option.value = value; kind.append(option);
    }
    let pageOffset = 0, candidates = new Map();
    const candidateSearch = input("Find loaded member candidates", 200);
    const candidateFeedback = node("p"); candidateFeedback.setAttribute("role", "status");
    const results = node("div");
    function showCandidates() {
      const query = candidateSearch.value.trim().toLocaleLowerCase();
      const matches = [...candidates.values()].filter(record =>
        (record.name ?? record.title ?? "").toLocaleLowerCase().includes(query));
      results.replaceChildren(...matches.map(record => {
        const id = record.id, selectedKind = kind.value;
        return button(record.name ?? record.title, () => {
          if (draft.members.length >= 200) {status.textContent = "A Collection can contain up to 200 references."; return;}
          if (draft.members.some(member => member.kind === selectedKind && member.target_id === id)) {
            status.textContent = "This item is already in the Collection."; return;
          }
          draft.members.push({available: true, kind: selectedKind, target_id: id, title: record.name ?? record.title});
          changed(); showMembers();
        });
      }));
      candidateFeedback.textContent = !pageOffset
        ? "Browse members to load accessible candidates. Search checks loaded pages only."
        : !candidates.size ? "No accessible items of this type."
        : `Showing ${matches.length} of ${candidates.size} loaded candidates. ${browse.hidden ? "All available pages loaded." : "Load another page to search further."}`;
    }
    const browse = button("Browse members", () => runRead(async () => {
      const selectedKind = kind.value;
      const page = await adapter.listCollectionCandidates(selectedKind, {limit: 50, offset: pageOffset});
      if (disposed || selectedKind !== kind.value) return;
      for (const record of page) {
        const id = record.id;
        if (!id || candidates.has(id)) continue;
        candidates.set(id, record);
      }
      pageOffset += page.length; browse.hidden = page.length < 50;
      showCandidates();
    }));
    kind.addEventListener("change", () => {pageOffset = 0; candidates = new Map(); results.replaceChildren(); browse.hidden = false; showCandidates();});
    candidateSearch.addEventListener("input", showCandidates);
    showCandidates();
    picker.append(kind, candidateSearch, browse, candidateFeedback, results);
    const save = button("Save Collection", () => {
      if (!draft.title.trim()) {status.textContent = "Enter a Collection title."; return;}
      void run(async () => {
        await adapter.updateCollection(selected, draft);
        await open(selected);
      }, "Collection saved.");
    });
    fields.append(name, description, members);
    if (draft.role !== "reader") fields.append(picker, save);
    const recovery = node("fieldset");
    recovery.append(button("Discard draft and reload", () => runRead(() => open(selected))));
    editor.append(heading, permalink, memberFilters, node("p", "Removing a reference leaves the Project or Publication intact. Sharing this Collection does not grant access to its members."), fields, recovery);
    const ownerText = ownerDescription(draft);
    if (ownerText) editor.append(node("p", `Owner: ${ownerText}`));
    if (draft.owner && draft.role === "owner" && typeof adapter.listCollectionOwnerCandidates === "function" &&
        typeof adapter.transferCollectionOwner === "function") {
      const originalId = selected, originalRevision = draft.revision, originalRecord = savedRecord, originalContext = savedContext;
      const picker = ownerPicker({collectionId: originalId, generation, revision: originalRevision});
      picker.element.append(node("p", "Transfer changes who manages this Collection. You may lose access. Its visibility, sharing and member content permissions stay separate."),
        button("Transfer Collection ownership", () => {
          if (dirty || knowledgeBlocked()) {status.textContent = "Save or discard your draft before transferring ownership."; return;}
          if (!picker.ready()) {status.textContent = "Load and select the new owner before transferring ownership."; return;}
          void run(async () => {
            const current = () => !disposed && picker.element.isConnected && generation === renderGeneration && selected === originalId &&
              savedRecord === originalRecord && savedContext === originalContext && draft?.revision === originalRevision && !dirty && !knowledgeBlocked();
            const context = originalContext ?? await currentActionContext();
            await picker.assertCurrent(); await assertActionContext(context);
            if (!current()) throw exportChanged();
            const owner = picker.owner();
            if (owner.principal_type === draft.owner.principal_type && owner.principal_id === draft.owner.principal_id) {
              status.textContent = "This owner already owns the Collection."; return;
            }
            // Transfer may remove access before its response arrives. Hide this
            // clean view before dispatch; only a fresh authorized read restores it.
            editor.replaceChildren(); knowledge = null; savedRecord = savedContext = draft = null; ++renderGeneration;
            [...directory.children].find(item => item.dataset.collectionId === originalId)?.remove();
            try {await adapter.transferCollectionOwner(originalId, {expected_revision: originalRevision, owner}, {context});}
            catch (error) {
              try {
                await assertActionContext(context);
                if (selected === originalId) await open(originalId);
              } catch { /* Keep the old view hidden when authority or the fresh read fails. */ }
              throw error;
            }
            await assertActionContext(context);
            try {await open(originalId);}
            catch (error) {
              if ([403, 404].includes(error?.status)) {
                selected = null;
                const page = await adapter.listCollections({...activeFilters, limit: 50, offset: 0});
                await assertActionContext(context);
                if (!disposed) {offset = 0; directory.replaceChildren(); showPage(page);}
                status.textContent = "Collection ownership transferred. The Collection is no longer available to you.";
                return;
              }
              throw error;
            }
            status.textContent = "Collection ownership transferred.";
          }, null);
        }));
      editor.append(picker.element);
    }
    const exportFields = node("fieldset"); exportFields.dataset.collectionExport = "true";
    let exportAvailable = false;
    try {exportAvailable = Boolean(savedContext && matchesSavedContext(serializeSavedCollection(savedRecord), savedContext));}
    catch { /* Historical/incomplete authoring responses do not invent portable identities. */ }
    exportFields.dataset.available = String(exportAvailable);
    const originalRecord = savedRecord, originalContext = savedContext;
    const exportButton = button("Export saved Collection metadata", () => {
      if (disposed || !exportFields.isConnected || generation !== renderGeneration || dirty || busy || knowledgeBlocked() ||
          !exportAvailable || savedRecord !== originalRecord || draft?.revision !== originalRecord.revision) return;
      void run(async () => {
        const current = () => !disposed && root.isConnected && exportFields.isConnected && generation === renderGeneration &&
          savedRecord === originalRecord && savedContext === originalContext && selected === originalRecord.id &&
          !dirty && !knowledgeBlocked() && draft?.revision === originalRecord.revision;
        await ensureRequestedAccount();
        if (!current() || !await exportContextMatches(originalContext) || !current() || !exportContextMatchesNow(originalContext)) throw exportChanged();
        const record = await adapter.getCollection(originalRecord.id);
        await ensureRequestedAccount();
        if (!current() || !await exportContextMatches(originalContext) || !current() || !exportContextMatchesNow(originalContext) || record.id !== originalRecord.id ||
            record.revision !== originalRecord.revision) throw exportChanged();
        const output = serializeSavedCollection(record);
        if (!matchesSavedContext(output, originalContext)) throw exportChanged();
        const url = browser.URL.createObjectURL(new browser.Blob([output.text], {type: "application/json"}));
        downloadUrls.add(url);
        try {
          if (!current() || !exportContextMatchesNow(originalContext)) throw exportChanged();
          const link = node("a"); link.href = url; link.download = output.filename; link.hidden = true;
          try {root.append(link); link.click();}
          finally {link.remove();}
        } finally {
          browser.setTimeout(() => {browser.URL.revokeObjectURL(url); downloadUrls.delete(url);}, 0);
        }
      }, "Saved Collection metadata exported. It grants no access to its members.");
    });
    exportFields.append(node("legend", "Use this Collection in another app"),
      node("p", "The saved metadata includes owner and accessible private resource references. Share it deliberately. Exporting does not publish the Collection or grant access to its members."),
      exportButton);
    if (!exportAvailable) exportFields.append(node("p", "Complete saved Collection metadata is required for export. Reopen the Collection with its account selected."));
    editor.append(exportFields);
    if(typeof adapter.getAuthoredKnowledge === "function") {
      const metadata=node("fieldset");metadata.dataset.knowledge="true";
      knowledge=ResourceKnowledge({adapter,resourceKind:"collection",resourceId:selected,onStateChange:()=>lock()});
      metadata.append(knowledge);editor.append(metadata);
    }
    editor.append(node("p", draft.visibility === "public" ? "Public Collection. Member content keeps its own access."
      : draft.visibility === "account"
      ? "Visible to account members. Member content keeps its own access."
      : "Private: owner, account administrators and invited members."));
    if (draft.visibility === "public" && typeof adapter.publicCollectionUrl === "function") {
      const publicLink = node("a", "Open public Collection");
      publicLink.target = "_blank"; publicLink.rel = "noopener noreferrer";
      editor.append(publicLink);
      Promise.resolve(adapter.publicCollectionUrl(selected)).then(href => {
        if (disposed || !publicLink.isConnected) return;
        publicLink.href = href;
        const moduleUrl = new URL(href, root.ownerDocument.location.href);
        moduleUrl.pathname = moduleUrl.pathname.replace(/\/view$/, "/module.mjs");
        moduleUrl.search = ""; moduleUrl.hash = "";
        const consume = node("details"), example = node("textarea");
        example.value = `import {createGallery} from ${JSON.stringify(moduleUrl.href)};\n\nconst gallery = createGallery();\ndocument.querySelector("#gallery").append(gallery);\n// When removing this view: gallery.dispose();`;
        example.readOnly = true; example.rows = 6;
        example.setAttribute("aria-label", "JavaScript gallery import for this Collection");
        consume.append(node("summary", "Use this Collection in a website"),
          node("p", "Add an element with id gallery to your page. The gallery inherits your page's styles and shows public members in their saved order without loading their maps or images. Each member keeps its own access."),
          example,
          node("p", "Pass onSelect to handle member selections, or listen for opengeo:collection-select. Call refresh() to update the list and dispose() when removing the gallery."));
        publicLink.after(consume);
      }).catch(() => {publicLink.textContent = "Public link unavailable.";});
    }
    if (draft.role === "owner" && typeof adapter.setCollectionVisibility === "function") {
      const sharing = node("fieldset"), visibility = node("select");
      visibility.setAttribute("aria-label", "Collection visibility");
      for (const [value, label] of [["private", "Private"], ["account", "Account members"], ["public", "Public"]]) {
        const option = node("option", label); option.value = value; visibility.append(option);
      }
      visibility.value = draft.visibility ?? "private";
      sharing.append(node("legend", "Collection visibility"), node("p", "Public shares this title, description, eligible Project releases and listed Publications. Private and unlisted members stay hidden."), visibility, button("Apply visibility", () => {
        if (dirty || knowledgeBlocked()) return;
        void run(async () => {
          await adapter.setCollectionVisibility(selected, {revision: draft.revision, visibility: visibility.value});
          await open(selected);
        }, "Collection visibility saved.");
      }));
      editor.append(sharing);
    }
    if (draft.role === "owner" && typeof adapter.listCollectionGrants === "function") {
      editor.append(CollectionSharing({adapter, id: selected, getRevision: () => draft.revision,
        setRevision: revision => {draft.revision = revision; lock();}, isDirty: () => dirty || knowledgeBlocked(), run,
        feedback: message => {status.textContent = message;}}));
    }
  }
}
function node(tag, value = "") {const element = document.createElement(tag); element.textContent = value; return element;}
function input(label, maxLength) {const element = node("input"); element.setAttribute("aria-label", label); element.placeholder = label; element.maxLength = maxLength; return element;}
function button(label, action) {const element = node("button", label); element.type = "button"; element.addEventListener("click", action); return element;}
function ownerDescription(record) {
  const owner = record.owner ?? record.definition?.owner;
  const name = record.owner_name ?? owner?.principal_id;
  return owner ? `${{user: "User", team: "Team", organization: "Organization"}[owner.principal_type]} · ${name}` : name;
}
