export function TileCacheSettings({state, service, binding, policy, refresh}) {
  const panel = document.createElement("details");
  panel.className = "project-service-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = "Tile cache settings";
  panel.append(summary);
  const manager = state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
  const eligible = manager && binding.withdrawnAt === null && !binding.stale
    && service.disabledAt === null && typeof state.adapter.configureTileCachePolicy === "function";
  const description = document.createElement("p");
  description.className = "project-resource-feedback";
  description.textContent = policy
    ? "Saving starts a new cache generation. Existing tiles stop being served but remain retained; preparing replacement tiles is a separate action."
    : "Set the zoom range and maximum number of stored tiles. Saving these limits does not create tiles or start processing.";
  panel.append(description);
  if (!eligible) {
    const note = document.createElement("p");
    note.textContent = "Cache settings require an active, current collection and permission to manage this service.";
    panel.append(note);
    return panel;
  }
  const form = document.createElement("form");
  form.className = "project-resource-editor-panel";
  function number(labelText, value, min, max) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number"; input.min = String(min); input.max = String(max);
    input.step = "1"; input.required = true; input.value = String(value);
    label.append(input); form.append(label);
    return input;
  }
  const minimum = number("Minimum tile zoom", policy?.minimumTileMatrix ?? 0, 0, 22);
  const maximum = number("Maximum tile zoom", policy?.maximumTileMatrix ?? 7, 0, 22);
  const entries = number("Maximum stored tiles", policy?.maximumEntries ?? 64, 1, 10000);
  const noteLabel = document.createElement("label"); noteLabel.textContent = "Cache change note";
  const note = document.createElement("input"); note.maxLength = 500;
  noteLabel.append(note); form.append(noteLabel);
  const confirmationLabel = document.createElement("label");
  const confirmation = document.createElement("input"); confirmation.type = "checkbox";
  confirmationLabel.append(confirmation, " I understand existing tiles will stop being served.");
  if (policy) form.append(confirmationLabel);
  const save = document.createElement("button"); save.type = "submit";
  save.className = "platform-button secondary"; save.textContent = "Save tile cache settings";
  const feedback = document.createElement("p"); feedback.setAttribute("role", "status");
  feedback.className = "project-resource-feedback";
  form.append(save, feedback); panel.append(form);
  let saving = false;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    const values = [minimum.valueAsNumber, maximum.valueAsNumber, entries.valueAsNumber];
    if (!values.every(Number.isSafeInteger) || values[1] < values[0]) {
      feedback.textContent = "Choose whole-number limits with maximum zoom at least minimum zoom.";
      return;
    }
    if (policy && !confirmation.checked) {
      feedback.textContent = "Confirm the effect on existing tiles before saving a new generation.";
      return;
    }
    saving = true; save.disabled = true;
    try {
      await state.adapter.configureTileCachePolicy(state.project.id, service.id, binding.id, {
        expectedVersion: policy?.versionNumber ?? 0, minimumTileMatrix: values[0],
        maximumTileMatrix: values[1], maximumEntries: values[2], changeMessage: note.value.trim() || null
      });
    } catch (error) {
      feedback.textContent = error?.status === 409
        ? "These settings changed elsewhere. Your entries are retained; reopen the collection to review the current generation before saving."
        : "Could not confirm the save. Your entries are retained; reopen the collection to check its settings before retrying.";
      saving = false; save.disabled = false;
      return;
    }
    feedback.textContent = "Tile cache settings saved. No tiles were queued.";
    try { await refresh(); } catch {
      feedback.textContent = "Settings were saved, but the collection could not reload. Reopen it before making another change.";
    }
  });
  return panel;
}
