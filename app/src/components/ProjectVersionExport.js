export {savedProjectVersionFile} from "../lib/projectFileFormat.js";

/** A deliberate saved-definition export. Listing never reads definitions or changes a draft. */
export function ProjectVersionExport({adapter, compositionId, currentVersion, isCurrent = () => true}) {
  const root = el("section");
  root.setAttribute("aria-label", "Export saved Project version");
  const label = el("label", "Saved version"), choices = el("select"), feedback = el("p");
  choices.setAttribute("aria-label", "Saved Project version");
  feedback.setAttribute("role", "status");
  choices.disabled = true;
  let records = [], busy = false, beforeVersion = null;
  const find = button("Find saved versions", async () => {
    records = []; beforeVersion = null; choices.replaceChildren();
    await load();
  });
  const older = button("Older versions", load);
  older.hidden = true;
  const selected = () => records.find(record => String(record.version) === choices.value);
  root.append(el("p", "Includes the saved definition and recorded change. Dependent files, access and full restore are separate."),
    label, find, older, feedback);
  label.append(choices);
  choices.addEventListener("change", () => {
    const record = selected();
    feedback.textContent = record
      ? `Version ${record.version} · ${record.createdAt}${record.changeMessage ? ` · ${record.changeMessage}` : ""}`
      : "Choose a saved version.";
  });
  root.readSelected = async () => {
    if (busy || !isCurrent()) throw Error("The Project changed. Review its saved versions again.");
    const expected = selected();
    if (!expected) throw Error("Find and choose a saved version first.");
    busy = true; setBusy(true);
    try {
      const version = await adapter.getCompositionVersion(compositionId, expected.version);
      if (!isCurrent() || selected() !== expected || version.version !== expected.version
        || version.definitionBytes !== expected.definitionBytes || version.createdAt !== expected.createdAt
        || version.createdBy !== expected.createdBy || version.changeMessage !== expected.changeMessage) {
        throw Error("The selected saved version could not be verified. Find versions again.");
      }
      return version;
    } finally {busy = false; setBusy(false);}
  };
  async function load() {
    if (!isCurrent()) throw Error("The Project changed. Review its saved versions again.");
    const page = await adapter.listCompositionVersions(compositionId, {limit: 25, beforeVersion});
    if (!isCurrent()) return;
    if (!Array.isArray(page) || page.length > 25 || page.some((record, index) =>
      !Number.isSafeInteger(record.version) || record.version < 1
      || beforeVersion !== null && record.version >= beforeVersion
      || index > 0 && record.version >= page[index - 1].version)) {
      throw Error("Saved versions could not be verified. Find versions again.");
    }
    const previous = choices.value;
    records.push(...page);
    choices.replaceChildren(el("option", "Choose a saved version"));
    choices.firstChild.value = "";
    for (const record of records) {
      const option = el("option", `Version ${record.version}${record.version === currentVersion ? " · opened here" : ""} · ${record.createdAt}`);
      option.value = String(record.version); choices.append(option);
    }
    choices.value = previous;
    beforeVersion = page.at(-1)?.version ?? beforeVersion;
    older.hidden = page.length < 25;
    feedback.textContent = records.length
      ? `${records.length} saved versions listed. Choose one to export its exact definition.`
      : "No saved versions are available.";
  }
  function setBusy(value) {
    find.disabled = value; older.disabled = value; choices.disabled = value || !records.length;
  }
  function button(title, action) {
    const node = el("button", title); node.type = "button"; node.className = "platform-button secondary";
    node.addEventListener("click", async () => {
      if (busy) return;
      busy = true; setBusy(true); feedback.textContent = "Reading saved versions…";
      try {await action();}
      catch (error) {
        records = []; choices.replaceChildren(); older.hidden = true;
        feedback.textContent = [403, 404].includes(error?.status)
          ? "Saved versions are unavailable. Check Project access."
          : "Saved versions could not load. Find versions again.";
      } finally {busy = false; setBusy(false);}
    });
    return node;
  }
  return root;
}

function el(tag, text = "") {const node = document.createElement(tag); node.textContent = text; return node;}
