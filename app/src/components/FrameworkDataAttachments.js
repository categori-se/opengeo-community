import {layerHref} from "../lib/applicationRoutes.js";
import {observablePublicFileCandidates} from "../lib/apiClient.js";

// Registration retains an archive reference; it does not bind a compiler input.
export function FrameworkDataAttachments({state, sourceProject, canManage, isLocked = () => false, onRegistered, onRegisteredPublic}) {
  const root = node("details");
  root.className = "observable-data-attachments";
  const connectsDraft = Boolean(onRegistered || onRegisteredPublic);
  root.append(node("summary", connectsDraft ? "Connect a Catalog file" : "Registered data files"), node("p",
    connectsDraft ? "Choose a dataset, version and file, then give it a FileAttachment name in your draft."
      : "Connect an existing dataset file to this publication. Add it under Data files, then Save draft."));
  const adapter = state.adapter;
  const contextProject = state.project, contextProjectId = state.project.id, contextSourceId = sourceProject.id;
  const contextOrganization = state.organization?.id, contextUser = state.session?.userId;
  const sameContext = () => root.isConnected && state.adapter === adapter && state.project === contextProject
    && state.project.id === contextProjectId && sourceProject.id === contextSourceId
    && state.organization?.id === contextOrganization && state.session?.userId === contextUser;
  const current = () => sameContext() && !isLocked();
  const canUsePublic = ["listObservablePublicFileReferences", "registerObservablePublicFileReference",
    "listDatasetResources", "getResource"].every(name => typeof adapter[name] === "function");
  let publicReferencesAvailable = true;
  if (typeof adapter.listObservableDataAttachments !== "function") {
    root.append(node("p", "Archived data references are not available in this connection."));
    return root;
  }
  const status = node("p", "Open this section to load registered references.");
  status.setAttribute("role", "status");
  const records = node("div");
  const reload = button("Reload references");
  let listGeneration = 0, busy = false, loaded = false, inventory = [];
  function renderRecords() {
    records.replaceChildren(...inventory.map(record => {
      const entry = node("div");
      entry.className = "framework-archive-facts";
      const name = state.datasets?.find(dataset => dataset.id === record.datasetId)?.name ?? "Registered dataset";
      entry.append(node("span", `${name} · ${record.contentType} · ${record.sizeBytes.toLocaleString()} bytes${record.available ? "" : " · Unavailable"}`));
      const details = node("details");
      details.append(node("summary", "File details"), facts(record));
      entry.append(details, catalogReviewLink(record.datasetId, state.adapter?.kind));
      return entry;
    }));
  }
  async function load() {
    const generation = ++listGeneration;
    reload.disabled = true;
    status.textContent = "Loading registered references…";
    try {
      const result = await adapter.listObservableDataAttachments(state.project.id, sourceProject.id);
      if (generation !== listGeneration) return;
      inventory = result;
      renderRecords();
      status.textContent = result.length ? `${result.length} registered reference${result.length === 1 ? "" : "s"}.` : "No archived files registered.";
    } catch {
      if (generation !== listGeneration) return;
      records.replaceChildren();
      status.textContent = "References could not be loaded. Check your connection and access; this server may need the archive-reference update. Retry with Reload references.";
    } finally {
      if (generation === listGeneration) reload.disabled = busy;
    }
  }
  reload.addEventListener("click", () => { if (!busy) void load(); });
  root.addEventListener("toggle", () => {
    if (!connectsDraft && root.open && !loaded) { loaded = true; void load(); }
  });
  if (!connectsDraft) root.append(reload, status, records);
  if (!canManage || typeof adapter.registerObservableDataAttachment !== "function"
    || typeof adapter.listDatasetVersions !== "function") return root;

  const isPublicDataset = dataset => dataset?.status === "active" && dataset.capabilities?.read !== false
    && (dataset.sourceType === "cog" || dataset.format === "cog");
  const isEligible = dataset => dataset.status === "active" && (dataset.capabilities?.download || (canUsePublic && publicReferencesAvailable && isPublicDataset(dataset)));
  const eligible = new Map((state.datasets ?? []).filter(isEligible).map(dataset => [dataset.id, dataset]));
  const linked = new Set((state.datasets ?? []).map(dataset => dataset.id));
  const unconfirmedLinks = new Set();
  const fields = node("fieldset");
  fields.append(node("legend", "Choose a dataset file"));
  const search = node("input");
  search.type = "search";
  search.maxLength = 200;
  search.placeholder = "Find a dataset in Catalog";
  search.setAttribute("aria-label", "Find a registered dataset");
  const find = button("Search Catalog");
  if (typeof adapter.searchDatasets === "function") fields.append(search, find);
  const dataset = select("Dataset", fields);
  function renderDatasets() {
    const selectedId = dataset.value;
    dataset.replaceChildren(option("", "Choose a dataset"), ...[...eligible.values()].map(item => {
      const choice = option(item.id, item.name); choice.disabled = !isEligible(item); return choice;
    }));
    if (eligible.has(selectedId)) dataset.value = selectedId;
  }
  renderDatasets();
  const mode = canUsePublic ? select("File location", fields) : null;
  if (mode) {
    mode.append(option("public", "Public source"), option("archive", "Archived copy"));
    mode.parentElement.hidden = true;
  }
  const version = select("Dataset version", fields);
  const file = select("Archived file", fields);
  const resource = canUsePublic ? select("Catalog metadata record", fields) : null;
  const distribution = canUsePublic ? select("Public source file", fields) : null;
  if (resource) {resource.parentElement.hidden = distribution.parentElement.hidden = true; resource.disabled = distribution.disabled = true;}
  const moreMetadata = button("Load more metadata records");
  moreMetadata.hidden = true;
  const more = button("Load more versions");
  more.hidden = true;
  const review = node("div");
  const feedback = node("p", eligible.size ? "Choose a dataset or search Catalog." : "Search Catalog for a dataset you can download.");
  feedback.setAttribute("role", "status");
  const register = button("Connect file");
  register.disabled = true;
  version.disabled = file.disabled = true;
  const reloadPublic = button("Reload public references");
  reloadPublic.hidden = !canUsePublic;
  fields.append(more, moreMetadata, review, register, feedback, ...(canUsePublic ? [reloadPublic] : []));
  root.append(fields);
  let generation = 0, searchGeneration = 0, versions = [], offset = 0, selected = null;
  let metadataRecords = [], metadataOffset = 0, candidates = [], publicSelected = null, publicInventory = [];
  const uncertainPublic = new Map();
  const publicMode = () => Boolean(publicReferencesAvailable && mode && mode.value === "public" && isPublicDataset(eligible.get(dataset.value)));
  const publicKey = selection => JSON.stringify([selection.datasetId, selection.sourceVersion, selection.resourceId,
    selection.resourceVersionId, selection.distributionId]);
  const matchesPublic = (record, candidate) => Object.entries(candidate.selection).every(([key, value]) => record[key] === value)
    && ["url", "contentType", "sizeBytes", "checksumSha256"].every(key => record[key] === candidate[key]);
  const reflectPublic = () => {
    register.textContent = linked.has(dataset.value) ? "Connect file" : "Link dataset and use file";
    register.disabled = !publicSelected || isLocked() || busy || unconfirmedLinks.has(dataset.value)
      || uncertainPublic.has(publicKey(publicSelected?.selection ?? {}))
      || (!linked.has(dataset.value) && typeof adapter.attachDataset !== "function");
  };
  function clearPublic() {
    publicSelected = null; candidates = []; register.disabled = true;
    if (distribution) {distribution.replaceChildren(); distribution.disabled = true;}
    review.replaceChildren();
  }
  const clearFile = () => { selected = null; register.disabled = true; file.replaceChildren(); file.disabled = true; review.replaceChildren(); };
  async function loadVersions(append = false) {
    const current = ++generation;
    clearFile();
    if (!append) { versions = []; offset = 0; version.replaceChildren(); }
    version.disabled = true;
    more.disabled = true;
    more.hidden = true;
    if (!dataset.value) return;
    feedback.textContent = "Loading archived versions…";
    try {
      const chosenDataset = eligible.get(dataset.value);
      const page = await adapter.listDatasetVersions(chosenDataset?.projectId ?? state.project.id, dataset.value, {limit: 50, offset});
      if (current !== generation) return;
      offset += page.length;
      versions.push(...page.filter(item => item.state === "active" && !versions.some(prior => prior.id === item.id)));
      version.replaceChildren(option("", "Choose a version"), ...versions.map(item => option(item.id, `Version ${item.versionNumber} · ${item.createdAt}`)));
      version.disabled = !versions.length;
      more.hidden = page.length < 50;
      feedback.textContent = versions.length ? "Choose the exact version to inspect its files." : "No active archived versions are available.";
    } catch {
      if (current !== generation) return;
      feedback.textContent = "Versions could not be loaded. Select the dataset again to retry.";
    } finally {
      if (current === generation) more.disabled = false;
    }
  }
  async function loadMetadata(append = false) {
    const requestGeneration = ++generation, datasetId = dataset.value;
    clearFile(); clearPublic();
    if (!append) {metadataRecords = []; metadataOffset = 0; resource.replaceChildren();}
    resource.disabled = moreMetadata.disabled = true; moreMetadata.hidden = true;
    if (!datasetId) return;
    feedback.textContent = "Loading accessible Catalog metadata records…";
    try {
      const page = await adapter.listDatasetResources(datasetId, {limit: 25, offset: metadataOffset});
      if (requestGeneration !== generation || !current() || !publicMode() || dataset.value !== datasetId) return;
      if (!Array.isArray(page) || page.length > 25 || page.some(record => record.datasetId !== datasetId)) throw Error("Catalog binding changed");
      metadataOffset += page.length;
      metadataRecords.push(...page.filter(record => record.kind === "dataset" && record.state !== "archived"
        && !metadataRecords.some(prior => prior.id === record.id)));
      resource.replaceChildren(option("", "Choose a metadata record"), ...metadataRecords.map(record => option(record.id, `${record.title} · revision ${record.versionNumber}`)));
      resource.disabled = !metadataRecords.length;
      moreMetadata.hidden = page.length < 25 || metadataOffset >= 50;
      feedback.textContent = metadataRecords.length ? "Choose the Catalog metadata record to review its exact public files."
        : "No accessible Catalog metadata records are available for this dataset.";
      if (metadataOffset >= 50 && page.length === 25) feedback.textContent += " The first 50 records are shown.";
    } catch {
      if (requestGeneration === generation && current()) feedback.textContent = "Catalog metadata could not be loaded. Select the dataset again to retry.";
    } finally {
      if (requestGeneration === generation && current()) moreMetadata.disabled = false;
    }
  }
  function chooseLocation() {
    clearFile(); clearPublic();
    const chosen = eligible.get(dataset.value), publicAvailable = canUsePublic && publicReferencesAvailable && isPublicDataset(chosen);
    if (mode) {
      mode.parentElement.hidden = !publicAvailable;
      mode.querySelector('[value="archive"]').disabled = !chosen?.capabilities?.download;
      if (!publicAvailable) mode.value = "archive";
    }
    const usePublic = publicMode();
    version.parentElement.hidden = file.parentElement.hidden = usePublic;
    more.hidden = true;
    if (resource) {resource.parentElement.hidden = distribution.parentElement.hidden = !usePublic;}
    moreMetadata.hidden = true;
    if (usePublic) void loadMetadata();
    else if (chosen?.capabilities?.download) void loadVersions();
    else {++generation; feedback.textContent = "No archived copy is available to download for this dataset.";}
  }
  if (mode) mode.addEventListener("change", () => {if (!busy && current()) chooseLocation();});
  moreMetadata.addEventListener("click", () => {if (!busy && current() && publicMode() && metadataOffset < 50) void loadMetadata(true);});
  resource?.addEventListener("change", async () => {
    if (busy || !current() || !publicMode()) return;
    const requestGeneration = ++generation, datasetId = dataset.value, resourceId = resource.value;
    clearPublic();
    const summary = metadataRecords.find(record => record.id === resourceId);
    if (!summary) return;
    feedback.textContent = "Reviewing this exact Catalog metadata edition…";
    try {
      const record = await adapter.getResource(summary.projectId, summary.id);
      if (requestGeneration !== generation || !current() || !publicMode() || dataset.value !== datasetId || resource.value !== resourceId) return;
      if (record.id !== summary.id || record.projectId !== summary.projectId || record.datasetId !== datasetId) throw Error("Catalog identity changed");
      const choices = observablePublicFileCandidates(record);
      candidates = choices.candidates;
      distribution.replaceChildren(option("", "Choose an exact public TIFF"), ...candidates.map(candidate => option(candidate.selection.distributionId,
        `${candidate.filename} · ${candidate.sizeBytes.toLocaleString()} bytes`)));
      distribution.disabled = !candidates.length;
      feedback.textContent = candidates.length ? "Choose a public TIFF to review before connecting."
        : choices.unavailableReason ?? "Metadata not ready: an exact public TIFF URL, size and SHA-256 are required.";
    } catch {
      if (requestGeneration === generation && current()) feedback.textContent = "This Catalog metadata record is unavailable. Check access or choose another record.";
    }
  });
  distribution?.addEventListener("change", () => {
    if (busy || !current() || !publicMode()) return;
    ++generation;
    publicSelected = candidates.find(candidate => candidate.selection.distributionId === distribution.value) ?? null;
    review.replaceChildren(); reflectPublic();
    if (publicSelected) {
      const details = node("details"); details.append(node("summary", "File details"), publicFacts(publicSelected));
      review.append(node("p", `${publicSelected.filename} · ${publicSelected.contentType} · ${publicSelected.sizeBytes.toLocaleString()} bytes`),
        details, catalogReviewLink(dataset.value, adapter.kind), node("p", "This connection keeps the original public source and its exact Catalog edition. It does not create an archived copy or grant publication rights."));
      if (unconfirmedLinks.has(dataset.value)) feedback.textContent = "Dataset linking remains unconfirmed. Reopen this publication to check its data before trying again.";
      else if (uncertainPublic.has(publicKey(publicSelected.selection))) feedback.textContent = "Public file connection remains unconfirmed. Reload public references to check before trying this exact file again.";
    }
  });
  reloadPublic.addEventListener("click", async () => {
    if (busy || !current() || !publicReferencesAvailable) return;
    const requestGeneration = generation;
    reloadPublic.disabled = true;
    feedback.textContent = "Checking retained public references…";
    try {
      const result = await adapter.listObservablePublicFileReferences(contextProjectId, contextSourceId);
      if (requestGeneration !== generation || !current()) return;
      if (!Array.isArray(result) || result.length > 128 || result.some(record => record.sourceProjectId !== contextSourceId)) throw Error("Public registry scope changed");
      publicInventory = result;
      const key = publicSelected && publicKey(publicSelected.selection), pending = key && uncertainPublic.get(key);
      const retained = pending && result.find(record => matchesPublic(record, pending.candidate));
      if (retained) {
        uncertainPublic.delete(key);
        if (retained.available) {linked.add(retained.datasetId); unconfirmedLinks.delete(retained.datasetId);}
        feedback.textContent = retained.available ? "Public source reference confirmed. Its original file is reused." : "Public source reference retained; current access is unavailable.";
        if (retained.available && onRegisteredPublic) {
          try {await onRegisteredPublic({...retained, filename: pending.filename, datasetName: pending.datasetName});}
          catch {if (current()) feedback.textContent = "Public source reference confirmed. Choose it under Data files to add its FileAttachment name.";}
        }
      } else {
        if (pending && !unconfirmedLinks.has(pending.candidate.selection.datasetId)) uncertainPublic.delete(key);
        feedback.textContent = unconfirmedLinks.has(dataset.value)
          ? "Dataset linking remains unconfirmed. Reopen this publication to check its data before trying again."
          : `${result.length} public reference${result.length === 1 ? "" : "s"} retained.${pending ? " This exact file was not registered; you can retry the connection." : ""}`;
      }
      if (publicMode()) reflectPublic();
    } catch {
      if (current()) feedback.textContent = "Public references could not be checked. Keep this selection and retry Reload public references.";
    } finally {if (current()) reloadPublic.disabled = !publicReferencesAvailable;}
  });
  find.addEventListener("click", async () => {
    if (busy || !current() || typeof adapter.searchDatasets !== "function") return;
    const currentSearch = ++searchGeneration;
    find.disabled = true;
    feedback.textContent = "Searching Catalog…";
    try {
      const result = await adapter.searchDatasets({query: search.value.trim() || undefined, limit: 25, offset: 0});
      if (currentSearch !== searchGeneration || !current()) return;
      const accessible = result.filter(isEligible);
      for (const item of accessible) eligible.set(item.id, item);
      renderDatasets();
      feedback.textContent = accessible.length ? `${accessible.length} datasets added to the choices.${result.length === 25 ? " Refine your search for more results." : ""}`
        : canUsePublic ? "No accessible downloadable or public TIFF datasets matched. Try a different name." : "No downloadable datasets matched. Try a different name.";
    } catch {
      if (currentSearch === searchGeneration && current()) feedback.textContent = "Catalog could not be searched. Your current file selection is unchanged.";
    } finally {
      if (currentSearch === searchGeneration && current()) find.disabled = false;
    }
  });
  search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); find.click(); } });
  dataset.addEventListener("change", () => { if (!busy && current()) {if (mode) mode.value = isPublicDataset(eligible.get(dataset.value)) ? "public" : "archive"; chooseLocation();} });
  more.addEventListener("click", () => { if (!busy) void loadVersions(true); });
  version.addEventListener("change", () => {
    if (busy) return;
    clearFile();
    const chosen = versions.find(item => item.id === version.value);
    if (!chosen) return;
    file.append(option("", "Choose a file"), ...chosen.objects.map(item => option(item.id, `${item.filename} · ${item.sizeBytes.toLocaleString()} bytes`)));
    file.disabled = !chosen.objects.length;
    feedback.textContent = chosen.objects.length ? "Choose a file to review before registration." : "This version has no archived files.";
  });
  file.addEventListener("change", () => {
    if (busy) return;
    selected = versions.find(item => item.id === version.value)?.objects.find(item => item.id === file.value) ?? null;
    review.replaceChildren();
    const needsLink = !linked.has(dataset.value);
    register.disabled = !selected || unconfirmedLinks.has(dataset.value)
      || (needsLink && typeof adapter.attachDataset !== "function");
    register.textContent = needsLink ? "Link dataset and use file" : "Connect file";
    if (selected) {
      const details = node("details");
      details.append(node("summary", "File details"), facts({...selected, datasetVersionId: version.value, dataObjectId: selected.id}));
      review.append(node("p", `${selected.filename} · ${selected.contentType} · ${selected.sizeBytes.toLocaleString()} bytes`),
        details, catalogReviewLink(dataset.value, state.adapter?.kind), node("p", fileReviewGuidance(selected)));
    }
  });
  register.addEventListener("click", async () => {
    if (mode?.value === "public" && !publicReferencesAvailable) return;
    if (publicMode()) {
      if (busy || !current() || !publicSelected || unconfirmedLinks.has(dataset.value)) return;
      const candidate = publicSelected, key = publicKey(candidate.selection), selectionGeneration = generation;
      if (uncertainPublic.has(key)) return;
      const filename = candidate.filename, datasetName = eligible.get(dataset.value)?.name;
      const stillSelected = () => current() && generation === selectionGeneration && publicMode()
        && dataset.value === candidate.selection.datasetId && publicSelected === candidate
        && resource.value === candidate.selection.resourceId && distribution.value === candidate.selection.distributionId;
      busy = true; fields.disabled = reloadPublic.disabled = true;
      uncertainPublic.set(key, {candidate, filename, datasetName});
      feedback.textContent = "Connecting this exact public source reference…";
      try {
        if (!linked.has(candidate.selection.datasetId)) {
          if (typeof adapter.attachDataset !== "function") throw Error("Dataset linking is unavailable");
          unconfirmedLinks.add(candidate.selection.datasetId);
          const attached = await adapter.attachDataset(contextProjectId, candidate.selection.datasetId);
          if (attached?.id && attached.id !== candidate.selection.datasetId) throw Error("Dataset link identity changed");
          linked.add(candidate.selection.datasetId); unconfirmedLinks.delete(candidate.selection.datasetId);
          if (!stillSelected()) return;
        }
        const retained = publicInventory.find(record => record.available && matchesPublic(record, candidate));
        const result = retained ?? await adapter.registerObservablePublicFileReference(contextProjectId, contextSourceId, candidate.selection);
        if (result.sourceProjectId !== contextSourceId || !matchesPublic(result, candidate)) throw Error("Public reference identity changed");
        uncertainPublic.delete(key);
        publicInventory = [...publicInventory.filter(record => record.id !== result.id), result];
        if (!stillSelected()) return;
        feedback.textContent = result.available ? "Public source connected. Its original file is reused."
          : "Public source reference retained; current access is unavailable.";
        if (result.available && onRegisteredPublic) {
          try {await onRegisteredPublic({...result, filename, datasetName});}
          catch {if (stillSelected()) feedback.textContent = "Public source connected. Choose it under Data files to add its FileAttachment name.";}
        }
      } catch {
        if (stillSelected()) feedback.textContent = unconfirmedLinks.has(candidate.selection.datasetId)
          ? "Dataset linking could not be confirmed. Reopen this publication to check its data before trying again."
          : "Public file connection could not be confirmed. Reload public references to check before trying this exact file again.";
      } finally {
        busy = false;
        if (sameContext()) {fields.disabled = false; reloadPublic.disabled = !publicReferencesAvailable || isLocked(); reflectPublic();}
      }
      return;
    }
    if (busy || !current() || !selected || unconfirmedLinks.has(dataset.value)) return;
    const selection = {datasetId: dataset.value, datasetVersionId: version.value, dataObjectId: selected.id};
    const filename = selected.filename;
    const chosenFile = selected, selectionGeneration = generation;
    const stillSelected = () => current() && generation === selectionGeneration && !publicMode()
      && selected === chosenFile && dataset.value === selection.datasetId
      && version.value === selection.datasetVersionId && file.value === selection.dataObjectId;
    const datasetName = eligible.get(dataset.value)?.name;
    busy = true;
    fields.disabled = reload.disabled = true;
    feedback.textContent = "Registering this exact archive reference…";
    try {
      if (!linked.has(selection.datasetId)) {
        if (typeof adapter.attachDataset !== "function") throw new TypeError("Dataset linking is unavailable");
        feedback.textContent = "Linking the existing dataset to this publication…";
        unconfirmedLinks.add(selection.datasetId);
        await adapter.attachDataset(state.project.id, selection.datasetId);
        linked.add(selection.datasetId);
        unconfirmedLinks.delete(selection.datasetId);
        if (!stillSelected()) return;
      }
      const result = await adapter.registerObservableDataAttachment(state.project.id, sourceProject.id, selection);
      if (!stillSelected()) return;
      inventory = [...inventory.filter(item => item.id !== result.id), result];
      renderRecords();
      feedback.textContent = result.available ? "File connected. Its existing archive is reused."
        : "File reference retained; download access is no longer available.";
      if (onRegistered && result.available) {
        try { await onRegistered({...result, filename, datasetName}); }
        catch { feedback.textContent = "File connected. Choose it under Data files to add its FileAttachment name."; }
      } else if (!loaded) {
        feedback.textContent += " Reload references to see all connected files.";
      }
    } catch {
      if (stillSelected()) feedback.textContent = unconfirmedLinks.has(selection.datasetId)
        ? "Dataset linking could not be confirmed. Reopen this publication to check its data before trying again."
        : "File connection could not be confirmed. Reload references to check. The dataset link is retained; retrying the same file reuses its reference.";
    } finally {
      busy = false;
      if (!sameContext()) return;
      fields.disabled = reload.disabled = false;
      register.disabled = isLocked() || unconfirmedLinks.has(selection.datasetId);
      register.textContent = linked.has(selection.datasetId) ? "Connect file" : "Link dataset and use file";
    }
  });
  root.setPublicReferencesAvailable = available => {
    if (publicReferencesAvailable === available) return;
    publicReferencesAvailable = available;
    if (!mode) return;
    mode.querySelector('[value="public"]').disabled = !available;
    reloadPublic.disabled = !available || busy || isLocked();
    renderDatasets();
    if (!available && mode.value === "public") {
      ++generation; clearPublic(); mode.value = "archive";
      version.parentElement.hidden = file.parentElement.hidden = false;
      resource.parentElement.hidden = distribution.parentElement.hidden = true;
      moreMetadata.hidden = true;
      feedback.textContent = "Public source references are unavailable in this connection. Choose an archived copy.";
    }
  };
  return root;
}

function catalogReviewLink(datasetId, adapterKind) {
  const link = node("a", "Review in Catalog (new tab)");
  link.href = layerHref(datasetId, {adapterKind});
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function fileReviewGuidance(file) {
  if (/\.pdf$/i.test(file.filename) || file.contentType === "application/pdf") {
    return "Review the document and its page references in Catalog. An accessible text preview is available only when recorded for that version. A PDF reference does not become a notebook table.";
  }
  if (/\.(?:xlsx?|ods)#?$/i.test(file.filename)) {
    return "Review the workbook's sheets, units, dates and missing values before analysis. Excel and OpenDocument workbooks are not parsed by the bundled notebook runtime. Preserve the workbook and use a documented CSV or JSON extract for charts.";
  }
  if (/\.(?:png|jpe?g)$/i.test(file.filename)) {
    return "Review the image and supply a description or transcription of essential information. A table image does not supply machine-readable values.";
  }
  return "Review the source, units, reference period, missing values and reuse rights before connecting this exact file. The Catalog review opens separately so your draft stays here.";
}

function facts(record) {
  const list = node("dl");
  list.style.overflowWrap = "anywhere";
  for (const [label, value] of [["Dataset version", record.datasetVersionId], ["File identity", record.dataObjectId],
    ["Size", `${record.sizeBytes.toLocaleString()} bytes`], ["Media type", record.contentType],
    ["SHA-256", record.checksumSha256], ["Storage version", record.s3VersionId ?? "Verified by the server when registered"]]) {
    list.append(node("dt", label), node("dd", value));
  }
  return list;
}
function publicFacts(candidate) {
  const list = node("dl"); list.style.overflowWrap = "anywhere";
  for (const [label, value] of [["Source version", candidate.selection.sourceVersion],
    ["Catalog metadata edition", candidate.resourceVersionNumber], ["Distribution", candidate.selection.distributionId],
    ["Public source", candidate.url], ["Size", `${candidate.sizeBytes.toLocaleString()} bytes`],
    ["Media type", candidate.contentType], ["SHA-256", candidate.checksumSha256]]) {
    list.append(node("dt", label), node("dd", String(value)));
  }
  return list;
}
function node(tag, value) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  return element;
}
function button(label) {
  const element = node("button", label);
  element.type = "button";
  element.className = "platform-button secondary";
  return element;
}
function option(value, label) {
  const element = node("option", label);
  element.value = value;
  return element;
}
function select(label, parent) {
  const wrapper = node("label");
  const element = node("select");
  element.setAttribute("aria-label", label);
  wrapper.append(node("span", label), element);
  parent.append(wrapper);
  return element;
}
