import {ServiceConnection} from "./ServiceConnection.js";

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,62}(?::[A-Za-z][A-Za-z0-9._-]{0,62})?$/;

export function ProjectWmsPublications({state}) {
  const panel = node("details", "", "project-wms-publications project-service-disclosure");
  panel.append(node("summary", "WMS map publishing"));
  panel.append(node("p", "Publish named map layers for QGIS and other WMS clients. This authenticated project endpoint is separate from sealed feature and tile collections. It follows the resource’s current published metadata and render profiles; each requested image pins its inputs."));
  panel.append(node("p", "Publishing a name or previewing capabilities starts no processing and grants no anonymous access. Requesting an uncached map in a GIS client can start a bounded render, subject to your permissions and project limits. Use prepared WMTS tiles when reads must never start rendering."));
  const feedback = node("p", "Open to load this project’s WMS publications.", "project-resource-feedback");
  feedback.setAttribute("role", "status");
  const content = node("div");
  const retry = button("Reload WMS publications");
  let revision = 0, loaded = false;
  async function load() {
    const current = ++revision;
    retry.disabled = true;
    feedback.textContent = "Loading WMS publications…";
    try {
      const publications = await state.adapter.listWmsPublications(state.project.id);
      if (current !== revision || !panel.isConnected) return;
      const entries = publications.map(publication => publicationRow(state, publication, load));
      content.replaceChildren(...entries);
      if (!entries.length) content.append(node("p", "No named WMS layers yet. Publish a dataset or service resource and save its render profile in Resources, then choose it below."));
      content.append(publicationForm(state, load));
      loaded = true;
      feedback.textContent = `${publications.filter(item => !item.withdrawnAt).length} active WMS layer names. Withdrawn names remain reserved.`;
    } catch {
      if (current !== revision) return;
      feedback.textContent = "WMS publications could not be loaded. Check your connection and access, then reload. Existing publications have not been changed.";
    } finally {
      if (current === revision) retry.disabled = false;
    }
  }
  panel.addEventListener("toggle", () => {if (panel.open && !loaded && !retry.disabled) void load();});
  retry.addEventListener("click", () => void load());
  panel.append(feedback, retry, content, ServiceConnection({state, service: {slug: "project", disabledAt: null}, projectWms: true}));
  return panel;
}

function publicationForm(state, refresh) {
  const form = node("form", "", "project-resource-editor-panel");
  const resources = (state.resources ?? []).filter(resource => resource.state === "published" && ["dataset", "service"].includes(resource.kind));
  if (!resources.length) return document.createDocumentFragment();
  form.append(node("h3", "Publish a WMS layer"));
  const resource = select("WMS resource", resources.map(item => [item.id, item.title]));
  const profile = select("WMS default style", []);
  const name = node("input");
  name.required = true; name.maxLength = 127; name.pattern = NAME.source;
  const submit = button("Publish WMS layer"); submit.type = "submit"; submit.disabled = true;
  const feedback = node("p", "Loading styles and publishing permissions…", "project-resource-feedback");
  feedback.setAttribute("role", "status");
  let revision = 0, allowed = false;
  async function update() {
    const current = ++revision, id = resource.value;
    allowed = false; submit.disabled = true; profile.replaceChildren();
    feedback.textContent = "Loading styles and publishing permissions…";
    try {
      const [profiles, capabilities] = await Promise.all([
        state.adapter.listRenderProfiles(state.project.id, id),
        state.adapter.getResourceCapabilities(state.project.id, id)
      ]);
      if (current !== revision) return;
      for (const item of profiles) profile.append(option(item.id, `${item.title} · v${item.versionNumber}`));
      allowed = capabilities.canPublish === true;
      submit.disabled = !allowed || !profile.value;
      feedback.textContent = !allowed ? "You need publishing permission for this resource."
        : !profile.value ? "Save a render profile for this resource in Resources first."
        : "Choose a stable layer name. It cannot be reassigned after publication or withdrawal.";
    } catch {
      if (current === revision) feedback.textContent = "Styles or permissions could not be loaded. Select the resource again or reload publications.";
    }
  }
  resource.addEventListener("change", () => void update());
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled || !allowed || !profile.value || !NAME.test(name.value.trim())) return;
    submit.disabled = true; resource.disabled = profile.disabled = name.disabled = true;
    feedback.textContent = "Publishing WMS layer…";
    try {
      await state.adapter.createWmsPublication(state.project.id, resource.value, {name: name.value.trim(), defaultProfileId: profile.value});
    } catch (error) {
      feedback.textContent = error?.status === 409 ? "That name is reserved or the resource changed. Your entries are retained; reload publications before choosing another name."
        : "The publication could not be confirmed. Your entries are retained; reload publications to check before retrying.";
      resource.disabled = profile.disabled = name.disabled = false;
      return;
    }
    feedback.textContent = "WMS layer published. No render was queued.";
    await refresh();
  });
  form.append(label("WMS resource", resource), label("WMS default style", profile), label("WMS layer name", name), submit, feedback);
  void update();
  return form;
}

function publicationRow(state, publication, refresh) {
  const row = node("details", "", "project-wms-publication");
  row.append(node("summary", `${publication.name} · ${publication.withdrawnAt ? "withdrawn" : "active"}`));
  const resource = (state.resources ?? []).find(item => item.id === publication.resourceId);
  row.append(node("p", `Resource: ${resource?.title ?? publication.resourceId} · Default style: ${publication.defaultProfileId}`));
  if (publication.withdrawnAt) return row;
  const ack = node("input"); ack.type = "checkbox";
  const withdraw = button("Withdraw WMS layer"); withdraw.disabled = true;
  const feedback = node("p", "Open to check publishing permission.", "project-resource-feedback"); feedback.setAttribute("role", "status");
  let allowed = false, checked = false;
  row.addEventListener("toggle", async () => {
    if (!row.open || checked) return;
    checked = true;
    try {
      allowed = (await state.adapter.getResourceCapabilities(state.project.id, publication.resourceId)).canPublish === true;
      feedback.textContent = allowed ? "Withdrawal is permanent for this name. It does not delete source data or revoke other publication endpoints." : "You need publishing permission to withdraw this layer.";
      withdraw.disabled = !allowed || !ack.checked;
    } catch {checked = false; feedback.textContent = "Permissions could not be checked. Close and reopen this layer to retry.";}
  });
  ack.addEventListener("change", () => {withdraw.disabled = !allowed || !ack.checked;});
  withdraw.addEventListener("click", async () => {
    if (withdraw.disabled || !allowed || !ack.checked) return;
    withdraw.disabled = ack.disabled = true; allowed = false;
    try {
      await state.adapter.withdrawWmsPublication(state.project.id, publication.resourceId, publication.id);
      feedback.textContent = "WMS layer withdrawn. Source data was retained.";
      await refresh();
    } catch {feedback.textContent = "Withdrawal could not be confirmed. Reload publications to check its status before retrying.";}
  });
  row.append(feedback, label(`Permanently withdraw ${publication.name}`, ack), withdraw);
  return row;
}

function node(tag, value = "", className = "") {const item = document.createElement(tag); item.textContent = value; item.className = className; return item;}
function button(value) {const item = node("button", value, "platform-button secondary"); item.type = "button"; return item;}
function label(value, control) {const item = node("label", value); item.append(control); return item;}
function option(value, title) {const item = node("option", title); item.value = value; return item;}
function select(name, choices) {const item = node("select"); item.setAttribute("aria-label", name); for (const [value, title] of choices) item.append(option(value, title)); return item;}
