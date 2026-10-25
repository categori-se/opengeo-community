import {ApiClientError, normalizeObservableRevisionAttachments, normalizeObservableRevisionReferencedFiles} from "../lib/apiClient.js";
import {frameworkArchiveIsSupported, validateFrameworkArchiveBindings} from "../lib/frameworkArchiveInputs.js";
import {FrameworkDataAttachments} from "./FrameworkDataAttachments.js";

// This surface changes only the working revision. Registry writes, source
// commits, data downloads, builds and publication remain separate actions.
export function FrameworkRevisionData({state, sourceProject, getBindings, getFiles, isLocked, onChange,
  getReferencedFiles = () => [], onReferencesChange,
  getFormat = () => "framework", getSourceRoot = () => "src", canManage = false, onInsert, onReload, onConnected}) {
  const root = node("details");
  root.className = "framework-revision-data";
  const summary = node("summary", "Data files");
  const notice = node("p", "Give a registered file a name for FileAttachment, then insert it into your code. Save draft keeps the chosen version and file.");
  const limits = node("p", "JSON, GeoJSON, CSV, text, PNG, JPEG and TIFF · up to 64 MiB total.");
  const rows = node("div");
  const importedRows = node("section");
  importedRows.hidden = true;
  const status = node("p", "Choose a connected source file or archived copy. Loading this list reads metadata only.");
  status.setAttribute("role", "status");
  const publicNotice = node("p", "Public source references are unavailable in this connection. Archived copies can still be used. Existing public source paths cannot be checked or saved.");
  publicNotice.hidden = true;
  const reload = button("Load registered files");
  const choose = node("select");
  choose.setAttribute("aria-label", "Registered archive file");
  const path = node("input");
  path.type = "text";
  path.maxLength = 512;
  path.placeholder = "src/data/water.geojson";
  path.setAttribute("aria-label", "FileAttachment path");
  const review = node("p");
  review.className = "framework-archive-facts";
  const add = button(onInsert ? "Insert file" : "Add file");
  const undo = button("Undo removal");
  undo.hidden = true;
  const selection = node("div");
  selection.className = "framework-archive-selection";
  selection.append(label("Registered file", choose), label("Referenced data path", path), add);
  root.append(summary, notice, limits, publicNotice, importedRows, rows, undo, reload, selection, review, status);
  let records = [], publicRecords = [], loaded = false, loading = false, generation = 0, removed = null;
  let importedReferences = [], importedPath = null;
  let publicReferencesUnavailable = false;
  const adapter = state.adapter, project = state.project, userId = state.session?.userId, organizationId = state.organization?.id;
  const canLoadArchives = typeof adapter.listObservableDataAttachments === "function";
  const canLoadPublic = typeof adapter.listObservablePublicFileReferences === "function" && typeof onReferencesChange === "function";
  const canLoad = canLoadArchives || canLoadPublic;
  const currentContext = () => state.adapter === adapter && state.project === project
    && state.session?.userId === userId && state.organization?.id === organizationId && root.isConnected;
  const isPublic = record => record?.kind === "referenced-public-file";
  const selectionValue = record => isPublic(record) ? `public:${record.id}` : record.id;
  const selectedRecord = () => [...records, ...publicRecords].find(record => selectionValue(record) === choose.value);
  const allBindings = () => [...getBindings(), ...getReferencedFiles()];
  const insertsCode = () => typeof onInsert === "function" && !["html", "jupyter"].includes(getFormat());
  const supported = frameworkArchiveIsSupported;
  const describe = record => {
    const name = record.datasetName ?? state.datasets?.find(dataset => dataset.id === record.datasetId)?.name ?? "Registered dataset";
    return `${record.filename ?? name} · ${record.contentType} · ${record.sizeBytes.toLocaleString()} bytes`;
  };
  function defaultPath(record) {
    const existing = allBindings().find(binding => (isPublic(record) ? binding.referenceId : binding.attachmentId) === record.id);
    if (existing) return existing.relativePath;
    const extension = {"application/json": "json", "application/geo+json": "geojson", "text/csv": "csv",
      "text/plain": "txt", "image/png": "png", "image/jpeg": "jpg", "image/tiff": "tif", "image/geotiff": "tif"}[record.contentType];
    const name = record.filename ?? `${record.datasetName ?? state.datasets?.find(item => item.id === record.datasetId)?.name ?? "data"}.${extension ?? "dat"}`;
    const safeName = name.split(/[\\/]/).at(-1).replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "") || `data.${extension ?? "dat"}`;
    const prefix = [getSourceRoot(), "data"].filter(Boolean).join("/");
    const stem = safeName.replace(/\.[^.]*$/, ""), suffix = safeName.slice(stem.length);
    const paths = [...getFiles(), ...allBindings()].map(file => file.relativePath.toLowerCase());
    let candidate = `${prefix}/${safeName}`, index = 2;
    while (paths.some(path => path === candidate.toLowerCase() || path.startsWith(candidate.toLowerCase() + "/")
      || candidate.toLowerCase().startsWith(path + "/"))) {
      if (index > 130) throw new TypeError("Choose a different data folder; the suggested path is already used.");
      candidate = `${prefix}/${stem}-${index++}${suffix}`;
    }
    return candidate;
  }
  function insertCode(binding) {
    const record = binding.referenceId ? publicRecords.find(item => item.id === binding.referenceId)
      : records.find(item => item.id === binding.attachmentId);
    if (!insertsCode() || !record?.available || isLocked()) return;
    validate(getBindings());
    const readMethod = /\.(?:json|geojson)$/i.test(binding.relativePath) ? "json"
      : /\.csv$/i.test(binding.relativePath) ? "csv" : /\.txt$/i.test(binding.relativePath) ? "text" : "arrayBuffer";
    onInsert({...binding, filename: record.filename, contentType: record.contentType, readMethod});
  }
  function validate(bindings, inventory = records, references = getReferencedFiles()) {
    const normalized = validateFrameworkArchiveBindings(bindings, [...getFiles(), ...references], inventory);
    validateReferences(references, normalized);
    return normalized;
  }
  function validateReferences(references, bindings = getBindings(), requireAvailable = loaded && canLoadPublic) {
    const normalized = normalizeObservableRevisionReferencedFiles(references, [...getFiles(), ...bindings]);
    if (publicReferencesUnavailable && normalized.length) throw new TypeError("Public source references are unavailable in this connection. Existing source paths are preserved; their access must be checked before saving.");
    let total = bindings.reduce((sum, binding) => sum + (records.find(item => item.id === binding.attachmentId)?.sizeBytes ?? 0), 0);
    for (const binding of normalized) {
      const record = publicRecords.find(item => item.id === binding.referenceId);
      if (requireAvailable && !record?.available) throw new TypeError(`${binding.relativePath}: source file is unavailable. Reload files or remove this path.`);
      if (record) {
        if (!supported(record) || !["image/tiff", "image/geotiff"].includes(record.contentType)) throw new TypeError("Source TIFF file is outside preview limits.");
        total += record.sizeBytes;
      }
    }
    if (total > 64 * 1024 * 1024) throw new TypeError("Source files and archived copies exceed 64 MiB; repeated references count at each path.");
    if (getFormat() === "jupyter") {
      const sourceBytes = getFiles().reduce((sum, file) => sum + (file.blob?.size ?? file.sizeBytes ?? 0), 0);
      if (sourceBytes + total > 16_777_216) throw new TypeError("Jupyter source and referenced files exceed the 16 MiB build-input limit.");
    }
    return normalized;
  }
  function reflectSelection() {
    const jupyter = getFormat() === "jupyter", html = getFormat() === "html";
    notice.textContent = jupyter ? "Link exact registered file versions for provenance. Jupyter displays saved outputs; it does not execute Python or refresh data. Execute your notebook locally before importing it." : html
      ? "Link exact registered files, then use their paths in your HTML. Save draft keeps the chosen versions and files."
      : "Give a registered file a name for FileAttachment, then insert it into your code. Save draft keeps the chosen version and file.";
    limits.textContent = jupyter ? "JSON, GeoJSON, CSV, text, PNG, JPEG and TIFF · Jupyter source and referenced files together are limited to 16 MiB, with 4 MiB per source file." : "JSON, GeoJSON, CSV, text, PNG, JPEG and TIFF · up to 64 MiB total.";
    path.setAttribute("aria-label", jupyter || html ? "Referenced data path" : "FileAttachment path");
    const record = selectedRecord();
    choose.disabled = !loaded || loading || isLocked();
    path.disabled = !canLoad || isLocked();
    add.disabled = !loaded || !record?.available || !supported(record) || loading || isLocked();
    review.textContent = record ? describe(record) : "";
    const reconnecting = importedPath === path.value.trim();
    const alreadyBound = allBindings().some(binding => binding.relativePath === path.value.trim()
      && (isPublic(record) ? binding.referenceId : binding.attachmentId) === record?.id);
    add.textContent = reconnecting ? "Reconnect file" : alreadyBound && insertsCode() ? "Insert code" : insertsCode() ? "Insert file" : "Add file";
    if (reconnecting) {
      const previous = getBindings().find(binding => binding.relativePath === importedPath);
      if (previous) review.textContent += ` · Replaces the draft reference at ${importedPath}. Earlier revisions stay unchanged.`;
      const pin = importedReferences.find(item => item.relativePath === importedPath)?.pin;
      if (record && /^[a-f0-9]{64}$/.test(pin?.checksumSha256 ?? "")) {
        review.textContent += record.checksumSha256 === pin.checksumSha256
          ? " · Matches the original file checksum."
          : " · Different bytes from the original file; review the replacement before reconnecting.";
      }
    }
  }
  function renderImported() {
    importedRows.hidden = !importedReferences.length;
    importedRows.replaceChildren(node("h5", "Imported data paths"), node("p",
      "Choose an accessible file for each imported path. Save draft checks file access again."));
    for (const reference of importedReferences) {
      const row = node("div"), binding = getBindings().find(item => item.relativePath === reference.relativePath);
      row.style.overflowWrap = "anywhere";
      const record = records.find(item => item.id === binding?.attachmentId);
      row.append(node("p", `${reference.relativePath} · ${binding
        ? loaded ? record?.available ? "Assigned in this draft" : "Assigned file unavailable" : "Assigned; access not checked"
        : "Needs a destination file"}`));
      if (/^[a-f0-9]{64}$/.test(reference.pin?.checksumSha256 ?? "")) {
        row.append(node("p", `Original file SHA-256: ${reference.pin.checksumSha256}`));
      }
      const reconnect = button("Choose destination file");
      reconnect.setAttribute("aria-label", `Choose destination file for ${reference.relativePath}`);
      reconnect.disabled = isLocked() || !canLoad;
      reconnect.addEventListener("click", () => {
        if (isLocked() || !canLoad) return;
        importedPath = reference.relativePath;
        path.value = importedPath;
        choose.value = "";
        root.open = true;
        if (!loaded) void load();
        reflectSelection();
        status.textContent = "Choose a registered destination file, then reconnect this path. No reference has changed.";
        choose.focus();
      });
      row.append(reconnect); importedRows.append(row);
    }
  }
  function renderOptions() {
    const selected = choose.value;
    choose.replaceChildren(option("", "Choose a registered file"), ...[...publicRecords, ...records].map(record => {
      const item = option(selectionValue(record), `${isPublic(record) ? "Source" : "Archive"} · ${describe(record)}${!record.available ? " · Unavailable" : supported(record) ? "" : " · Outside preview limits"}`);
      item.disabled = !record.available || !supported(record);
      return item;
    }));
    if ([...records, ...publicRecords].some(record => selectionValue(record) === selected)) choose.value = selected;
  }
  function renderRows() {
    renderImported();
    const active = document.activeElement;
    const selection = rows.contains(active) && active.tagName === "INPUT"
      ? {label: active.getAttribute("aria-label"), start: active.selectionStart, end: active.selectionEnd} : null;
    const bindings = allBindings();
    summary.textContent = `Data files (${bindings.length})${importedReferences.length ? ` · ${importedReferences.length} imported paths to review` : ""}`;
    rows.replaceChildren();
    if (!bindings.length) rows.append(node("p", "No data files assigned."));
    for (const binding of bindings) {
      const sourceFile = Boolean(binding.referenceId);
      const getCollection = sourceFile ? getReferencedFiles : getBindings;
      const changeCollection = sourceFile ? onReferencesChange : onChange;
      const position = getCollection().indexOf(binding);
      const row = node("div");
      row.className = "framework-archive-binding";
      const input = node("input");
      input.type = "text";
      input.maxLength = 512;
      input.value = binding.relativePath;
      input.setAttribute("aria-label", `${sourceFile ? "Source" : "Archive"} file path ${position + 1}`);
      input.disabled = isLocked();
      const facts = node("p");
      facts.className = "framework-archive-facts";
      const record = sourceFile ? publicRecords.find(item => item.id === binding.referenceId)
        : records.find(item => item.id === binding.attachmentId);
      facts.textContent = record ? `${describe(record)} · ${record.available ? "Available" : "Unavailable"}`
        : `Reference ${binding.referenceId ?? binding.attachmentId} · load registered files to check availability`;
      if (sourceFile) facts.textContent += " · Live preview reads this source once and reuses its verified bytes.";
      input.addEventListener("input", () => {
        if (isLocked()) return;
        const next = getCollection().map((item, offset) => offset === position ? {...item, relativePath: input.value} : item);
        changeCollection(next);
        try {
          if (sourceFile) validateReferences(next);
          else {
            normalizeObservableRevisionAttachments(next, [...getFiles(), ...getReferencedFiles()]);
            if (loaded) validate(next);
          }
          input.removeAttribute("aria-invalid");
          status.textContent = "File name changed. Save draft to keep it.";
        } catch (error) {
          input.setAttribute("aria-invalid", "true");
          status.textContent = error.message;
        }
        renderImported();
      });
      const remove = button("Remove path");
      remove.setAttribute("aria-label", `Remove ${sourceFile ? "source" : "archive"} file path ${position + 1}`);
      remove.disabled = isLocked();
      remove.addEventListener("click", () => {
        if (isLocked()) return;
        removed = {...getCollection()[position]};
        changeCollection(getCollection().filter((_, offset) => offset !== position));
        undo.hidden = false;
        renderRows();
        status.textContent = "Path removed from this draft. The Catalog file and earlier revisions remain available.";
        undo.focus();
      });
      const insert = button("Insert code");
      insert.setAttribute("aria-label", `Insert FileAttachment for ${binding.relativePath}`);
      insert.disabled = isLocked() || !record?.available;
      insert.hidden = !insertsCode();
      insert.addEventListener("click", () => {
        try { insertCode({...binding, relativePath: input.value.trim()}); status.textContent = "FileAttachment code inserted in the current page."; }
        catch (error) { status.textContent = error.message; }
      });
      const actions = node("div");
      actions.className = "project-site-actions";
      actions.style.marginTop = "0";
      actions.append(insert, remove);
      row.append(label("FileAttachment path", input), facts, actions);
      rows.append(row);
    }
    if (selection) {
      const replacement = [...rows.querySelectorAll("input")].find(input => input.getAttribute("aria-label") === selection.label);
      replacement?.focus();
      replacement?.setSelectionRange(selection.start, selection.end);
    }
  }
  async function fetchRecords() {
    if (!canLoadArchives) throw new TypeError("This connection needs the archive-reference update before saving bound files.");
    return adapter.listObservableDataAttachments(project.id, sourceProject.id);
  }
  async function fetchInventory() {
    const [archives, publicResult] = await Promise.all([
      canLoadArchives ? fetchRecords() : [],
      canLoadPublic ? adapter.listObservablePublicFileReferences(project.id, sourceProject.id)
        .then(sources => ({sources, unavailable: false}), error => {
          if (canLoadArchives && error instanceof ApiClientError && error.status === 404) return {sources: [], unavailable: true};
          throw error;
        }) : {sources: [], unavailable: false}
    ]);
    return {archives, sources: publicResult.sources, publicUnavailable: publicResult.unavailable};
  }
  function applyPublicAvailability(result, references = getReferencedFiles()) {
    publicReferencesUnavailable = result.publicUnavailable;
    publicNotice.hidden = !publicReferencesUnavailable;
    registration.setPublicReferencesAvailable?.(!publicReferencesUnavailable);
    if (publicReferencesUnavailable) publicRecords = [];
    if (publicReferencesUnavailable && references.length) {
      loaded = false; renderOptions(); renderRows(); reflectSelection();
      throw new TypeError("Public source references are unavailable in this connection. Existing source paths are preserved; their access must be checked before saving.");
    }
  }
  async function load(deliberate = false) {
    if (isLocked() || loading || !canLoad) return;
    const current = ++generation;
    loading = true;
    reload.disabled = true;
    status.textContent = "Loading registered files…";
    reflectSelection();
    try {
      const result = await fetchInventory();
      if (current !== generation || isLocked() || !currentContext()) return;
      applyPublicAvailability(result);
      if (deliberate) await onReload?.(result.archives, result.sources);
      if (current !== generation || isLocked() || !currentContext()) return;
      records = result.archives;
      publicRecords = result.sources;
      loaded = true;
      renderOptions();
      renderRows();
      status.textContent = records.length + publicRecords.length ? deliberate && onReload ? "Files refreshed. Preview uses current references."
        : "Choose a file and enter its source path. Nothing has been changed."
        : "No connected files yet. Connect a Catalog file below.";
    } catch {
      if (current !== generation || isLocked() || !currentContext()) return;
      loaded = false;
      status.textContent = "Registered files could not be loaded. Your paths and source edits are unchanged. Retry with Reload registered files.";
    } finally {
      if (current === generation) {
        loading = false;
        reload.textContent = "Reload registered files";
        reload.disabled = !canLoad || isLocked();
        reflectSelection();
      }
    }
  }
  reload.addEventListener("click", () => void load(true));
  root.addEventListener("toggle", () => { if (root.open && !loaded) void load(); });
  choose.addEventListener("change", () => {
    const record = selectedRecord();
    if (record && !importedPath) path.value = defaultPath(record);
    reflectSelection();
  });
  path.addEventListener("input", () => {
    if (path.value.trim() !== importedPath) importedPath = null;
    reflectSelection();
  });
  add.addEventListener("click", () => {
    if (isLocked() || loading || !loaded) return;
    try {
      const relativePath = path.value.trim();
      const record = selectedRecord();
      if (!record?.available || !supported(record)) throw new TypeError("Choose an available registered file.");
      const reconnecting = importedPath === relativePath;
      if (isPublic(record) && reconnecting) throw new TypeError("Reconnect imported archive paths to an archived copy.");
      const collection = isPublic(record) ? getReferencedFiles() : getBindings();
      const selectedBinding = isPublic(record) ? {referenceId: record.id, relativePath} : {attachmentId: record.id, relativePath};
      const existing = collection.find(binding => binding.relativePath === relativePath
        && (isPublic(record) ? binding.referenceId : binding.attachmentId) === record.id);
      if (existing && !reconnecting) {
        insertCode(existing);
        status.textContent = insertsCode() ? "FileAttachment code inserted. The existing file reference is reused." : "This file is already in your draft.";
        path.value = "";
        reflectSelection();
        return;
      }
      const current = reconnecting ? collection.filter(binding => binding.relativePath !== relativePath) : collection;
      if (isPublic(record)) onReferencesChange(validateReferences([...current, selectedBinding], validate(getBindings())));
      else onChange(validate([...current, selectedBinding]));
      renderRows();
      insertCode(selectedBinding);
      path.value = "";
      importedPath = null;
      reflectSelection();
      status.textContent = reconnecting ? "Imported file reconnected. Save draft to keep it."
        : insertsCode() ? "File linked and FileAttachment code inserted. Save draft to keep your changes." : "File linked. Save draft to keep it.";
      path.focus();
    } catch (error) { status.textContent = error.message; }
  });
  undo.addEventListener("click", () => {
    if (isLocked() || !removed) return;
    try {
      if (removed.referenceId) onReferencesChange(normalizeObservableRevisionReferencedFiles([...getReferencedFiles(), removed], [...getFiles(), ...getBindings()]));
      else onChange(normalizeObservableRevisionAttachments([...getBindings(), removed], [...getFiles(), ...getReferencedFiles()]));
      removed = null;
      undo.hidden = true;
      renderRows();
      status.textContent = "Removed path restored in this draft.";
    } catch (error) { status.textContent = error.message; }
  });
  async function acceptRegistered(record) {
    if (isLocked() || !currentContext()) return;
    const current = ++generation;
    loading = true; loaded = false; reload.disabled = true;
    if (isPublic(record)) publicRecords = [...publicRecords.filter(item => item.id !== record.id), record];
    else records = [...records.filter(item => item.id !== record.id), record];
    renderOptions(); choose.value = selectionValue(record); path.value = defaultPath(record);
    renderRows(); reflectSelection();
    status.textContent = "File connected. Checking the other draft file references…";
    try {
      const result = await fetchInventory();
      if (current !== generation || isLocked() || !currentContext()) return;
      applyPublicAvailability(result);
      records = result.archives; publicRecords = result.sources;
      const collection = isPublic(record) ? publicRecords : records;
      const retained = collection.find(item => item.id === record.id);
      if (retained) Object.assign(retained, {filename: record.filename, datasetName: record.datasetName});
      else collection.push(record); // Confirmed write stays visible if list readback lags.
      if (onReload) await onReload(records, publicRecords);
      else if (!isPublic(record)) await onConnected?.();
      if (current !== generation || isLocked() || !currentContext()) return;
      loaded = true; renderOptions(); renderRows();
      status.textContent = isPublic(record)
        ? "Source file connected. Review its FileAttachment name, then insert it. Live preview reads it when referenced."
        : "File connected. Review its FileAttachment name, then insert it.";
      path.focus();
    } catch {
      if (current !== generation || !currentContext()) return;
      status.textContent = "File connection is retained. Reload registered files to check the other draft references before inserting.";
    } finally {
      if (current === generation && currentContext()) {
        loading = false; reload.disabled = !canLoad || isLocked(); reflectSelection();
      }
    }
  }
  const registration = FrameworkDataAttachments({state, sourceProject, canManage, isLocked,
    onRegistered: acceptRegistered, onRegisteredPublic: canLoadPublic ? acceptRegistered : undefined});
  root.append(registration);
  reload.disabled = !canLoad;
  renderRows();
  reflectSelection();
  if (!canLoad) status.textContent = "Archived file selection is unavailable in this connection. Saved paths remain visible.";
  return {
    element: root,
    readForImport: fetchRecords,
    setImportedReferences(references) {
      // ZIP verification already checks all paths. Preserve pin details as
      // informational context only; destination identity is always chosen here.
      normalizeObservableRevisionAttachments(references);
      importedReferences = references;
      importedPath = null;
      path.value = "";
      renderRows();
      reflectSelection();
    },
    reset() { removed = null; importedReferences = []; importedPath = null; path.value = ""; undo.hidden = true; renderRows(); reflectSelection(); },
    resume() {
      reload.disabled = !canLoad || loading || isLocked();
      if (loaded) renderOptions();
      renderRows();
      reflectSelection();
    },
    assertReady() {
      if (path.value.trim()) throw new TypeError("Insert the selected file or clear its name before saving the draft.");
    },
    async prepareCommit(bindings, references = getReferencedFiles()) {
      // A click on Commit authorizes a fresh metadata check, never an archive
      // body read. Invalidate any earlier UI request while controls are locked.
      ++generation;
      loading = false;
      const result = await fetchInventory();
      if (!currentContext()) throw new TypeError("The publication account or editor changed.");
      applyPublicAvailability(result, references);
      records = result.archives; publicRecords = result.sources;
      loaded = true;
      // Legacy connections can retain public pins; the save endpoint still
      // checks authority. A capable connection also checks current metadata.
      return canLoadPublic || getFormat() === "jupyter" ? validate(bindings, records, references)
        : validateFrameworkArchiveBindings(bindings, [...getFiles(), ...references], records);
    }
  };
}

function node(tag, value) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  return element;
}
function label(name, control) { const element = node("label"); element.append(node("span", name), control); return element; }
function option(value, name) { const element = node("option", name); element.value = value; return element; }
function button(name) { const element = node("button", name); element.type = "button"; element.className = "platform-button platform-button-secondary"; return element; }
