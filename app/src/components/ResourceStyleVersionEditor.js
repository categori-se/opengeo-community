const FORMATS = Object.freeze({
  maplibre: ["MapLibre", "json", "application/vnd.mapbox.style+json"],
  geostyler: ["GeoStyler", "json", "application/json"],
  sld_1_0: ["SLD 1.0", "sld", "application/vnd.ogc.sld+xml"],
  sld_1_1: ["SLD 1.1", "sld", "application/vnd.ogc.se+xml"],
  mapserver_mapfile: ["Mapfile", "map", "text/vnd.mapserver.mapfile"]
});

// Definitions stay inert text. Saving a version does not publish or execute it.
export function ResourceStyleVersionEditor({adapter, projectId, resourceId, style, canUpdate, onStyleChange = () => {}, historical = false}) {
  const root = document.createElement("details");
  root.className = "resource-style-version-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Inspect or edit definition";
  const identity = document.createElement("p");
  const title = field("Saved style title", "input", 300);
  const definition = field("Saved style definition", "textarea", 49_152);
  definition.control.spellcheck = false;
  const note = field("Style change note", "input", 500);
  const actions = document.createElement("div");
  actions.className = "resource-style-version-actions";
  const download = button("Download saved definition");
  const save = button("Save style version");
  const check = button("Check latest version");
  const useLatest = button("Use latest as edit base");
  const latestView = document.createElement("pre");
  latestView.tabIndex = 0;
  latestView.setAttribute("aria-label", "Latest saved style for comparison");
  const feedback = document.createElement("p");
  feedback.className = "project-resource-feedback";
  feedback.setAttribute("role", "status");
  let current = structuredClone(style);
  let latest = null;
  let busy = false;
  let needsReview = false;
  const editable = Boolean(canUpdate && typeof adapter.updateResourceStyle === "function");
  if (!editable) summary.textContent = "Inspect definition";

  function showIdentity() {
    identity.textContent = `${FORMATS[current.format]?.[0] ?? current.format} · version ${current.versionNumber} · SHA-256 ${current.checksumSha256}`;
  }
  function lock(value) {
    busy = value;
    title.control.readOnly = !editable || value;
    definition.control.readOnly = !editable || value;
    note.control.disabled = value;
    save.disabled = value || needsReview;
    check.disabled = value;
    useLatest.disabled = value;
  }
  showIdentity();
  title.control.value = current.title;
  definition.control.value = current.definition;
  note.label.hidden = !editable;
  save.hidden = !editable;
  check.hidden = !editable || typeof adapter.listResourceStyles !== "function";
  useLatest.hidden = true;
  latestView.hidden = true;
  lock(false);
  feedback.textContent = "Definitions are stored as text, not executed. New versions do not change existing render profiles or publish a service.";

  download.addEventListener("click", async () => {
    download.disabled = true;
    try {
      const artifact = await savedStyleArtifact(current);
      const url = URL.createObjectURL(new Blob([artifact.definition], {type: artifact.mediaType}));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback.textContent = `Downloaded saved version ${artifact.versionNumber}. Unsaved edits are not included.`;
    } catch {
      feedback.textContent = "The saved definition could not be verified or downloaded. Your edits are unchanged; check the latest version before retrying.";
    } finally {
      download.disabled = false;
    }
  });

  save.addEventListener("click", async () => {
    if (!editable || busy || needsReview) return;
    if (!title.control.reportValidity() || !definition.control.reportValidity()) return;
    lock(true);
    try {
      const updated = await adapter.updateResourceStyle(projectId, resourceId, current.id, {
        expectedVersion: current.versionNumber,
        format: current.format,
        title: title.control.value,
        definition: definition.control.value,
        changeMessage: note.control.value.trim() || null
      });
      assertStyleIdentity(updated, current, resourceId);
      if (updated.versionNumber !== current.versionNumber + 1) throw new Error("unexpected_version");
      current = structuredClone(updated);
      Object.assign(style, updated);
      onStyleChange(style);
      title.control.value = current.title;
      definition.control.value = current.definition;
      note.control.value = "";
      latestView.hidden = true;
      useLatest.hidden = true;
      showIdentity();
      feedback.textContent = `Saved style version ${current.versionNumber}. Existing render profiles retain their earlier style version; create a new profile to use this change.`;
    } catch (error) {
      needsReview = true;
      feedback.textContent = error?.code === "resource_style_version_conflict" || error?.code === "http_409"
        ? "Someone saved another version. Your draft is unchanged. Check the latest version and compare it before saving again."
        : "The save could not be confirmed. Your draft is unchanged. Check the latest version before retrying to avoid a duplicate update.";
    } finally {
      lock(false);
    }
  });

  check.addEventListener("click", async () => {
    if (!editable || busy) return;
    lock(true);
    latest = null;
    useLatest.hidden = true;
    latestView.hidden = true;
    try {
      const records = await adapter.listResourceStyles(projectId, resourceId);
      const found = records.find((record) => record.id === current.id);
      assertStyleIdentity(found, current, resourceId);
      if (found.versionNumber < current.versionNumber) throw new Error("older_version");
      latest = structuredClone(found);
      latestView.textContent = `Version ${latest.versionNumber}: ${latest.title}\n\n${latest.definition}`;
      latestView.hidden = false;
      useLatest.hidden = false;
      needsReview = true;
      feedback.textContent = "Compare the saved version below with your draft above. Use latest as edit base only after reviewing; it keeps your draft and changes the version required for your next save.";
    } catch {
      feedback.textContent = "The latest version could not be read. Your draft and its edit base are unchanged.";
    } finally {
      lock(false);
    }
  });

  useLatest.addEventListener("click", () => {
    if (!editable || busy || !latest) return;
    current = structuredClone(latest);
    Object.assign(style, latest);
    onStyleChange(style);
    latest = null;
    needsReview = false;
    useLatest.hidden = true;
    showIdentity();
    lock(false);
    feedback.textContent = `Your draft is unchanged and now uses version ${current.versionNumber} as its edit base. Save style version will create a new version; it has not saved yet.`;
  });

  root.hasUnsavedChanges = () => editable && (busy || needsReview
    || title.control.value !== current.title || definition.control.value !== current.definition
    || note.control.value.trim() !== "");
  actions.append(download, save, check, useLatest);
  root.append(summary, identity, title.label, definition.label, note.label, actions, feedback, latestView);
  if (typeof adapter.getResourceStyleVersion === "function" && !historical) {
    root.append(StyleVersionHistory({adapter, projectId, resourceId, style}));
  }
  return root;
}

export async function savedStyleArtifact(style) {
  const format = FORMATS[style.format];
  if (!format || typeof style.definition !== "string" || style.definition.length > 49_152
    || !Number.isSafeInteger(style.versionNumber) || style.versionNumber < 1
    || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(style.slug)
    || !/^[a-f0-9]{64}$/.test(style.checksumSha256)) throw new Error("invalid_style_artifact");
  const bytes = new TextEncoder().encode(style.definition);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  if (digest !== style.checksumSha256) throw new Error("style_checksum_mismatch");
  return {
    filename: `${style.slug}-v${style.versionNumber}.${format[1]}`,
    definition: style.definition,
    mediaType: `${format[2]};charset=utf-8`,
    versionNumber: style.versionNumber
  };
}

function assertStyleIdentity(value, current, resourceId) {
  if (!value || value.id !== current.id || value.resourceId !== resourceId
    || value.format !== current.format || value.slug !== current.slug
    || !Number.isSafeInteger(value.versionNumber)) throw new Error("style_identity_changed");
}

function button(label) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "platform-button secondary";
  control.textContent = label;
  return control;
}

function field(label, tag, maximum) {
  const wrapper = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = label;
  const control = document.createElement(tag);
  control.setAttribute("aria-label", label);
  control.maxLength = maximum;
  control.required = tag === "textarea" || label === "Saved style title";
  if (tag === "textarea") control.rows = 8;
  wrapper.append(caption, control);
  return {label: wrapper, control};
}


function StyleVersionHistory({adapter, projectId, resourceId, style}) {
  const root = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Inspect a saved version";
  const version = field("Style version number", "input", 16);
  version.control.type = "number";
  version.control.min = "1";
  version.control.step = "1";
  version.control.value = String(style.versionNumber);
  const load = button("Load exact Style version");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const content = document.createElement("div");
  status.textContent = "Read-only history. Loading a version does not replace your draft or change a map.";
  load.addEventListener("click", async () => {
    const selected = Number(version.control.value);
    if (!Number.isSafeInteger(selected) || selected < 1) {
      status.textContent = "Enter a positive whole version number.";
      return;
    }
    load.disabled = true;
    version.control.disabled = true;
    content.replaceChildren();
    status.textContent = "Loading and verifying saved version…";
    try {
      const saved = await adapter.getResourceStyleVersion(projectId, resourceId, style.id, selected);
      assertStyleIdentity(saved, style, resourceId);
      if (saved.versionNumber !== selected) throw new Error("style_version_substituted");
      await savedStyleArtifact(saved);
      content.append(ResourceStyleVersionEditor({adapter, projectId, resourceId, style: saved, canUpdate: false, historical: true}));
      status.textContent = `Verified saved version ${selected}. Your current draft is unchanged.`;
    } catch (error) {
      status.textContent = error?.status === 404
        ? "That version is unavailable or access has changed. No replacement version was loaded."
        : "The requested version could not be loaded and verified. Check access and retry. Your draft is unchanged.";
    } finally {
      load.disabled = false;
      version.control.disabled = false;
    }
  });
  root.append(summary, version.label, load, status, content);
  return root;
}
