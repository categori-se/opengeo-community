import {SOCIAL_BASELINE_TOPICS} from "../lib/socialBaselineEvidence.js";
import {validateProjectSocialBaselineSelection, readProjectSocialReview, composeProjectSocialBaseline} from "../lib/projectSocialBaseline.js";

/** Project composition uses already-loaded reports or deliberate authorized
 * metadata reads. Rendering this control never reads an original or provider. */
export function ProjectSocialBaseline(context, {download}) {
  const model = modelFor(context), panel = element("section"); panel.className = "project-social-baseline";
  if (model.overview && !model.snapshotCurrent?.()) {
    invalidate(model); model.message = "The selected Project or Layer version changed. Load the current reviews again.";
  }
  panel.append(element("h3", "Project social baseline"), element("p", "Bring together up to four reviewed evidence Layers for one Project footprint. Each topic needs its own source review; presence does not establish complete coverage or an impact finding."));
  const controls = element("fieldset"); controls.disabled = locked(context) || Boolean(model.controller);
  const question = element("input"); question.setAttribute("aria-label", "Social baseline question"); question.maxLength = 500; question.value = model.question;
  const questionLabel = element("label", "Social baseline question"); questionLabel.append(question); controls.append(questionLabel);
  question.addEventListener("input", () => {if (!controls.disabled && !locked(context)) {
    const hadOverview = Boolean(model.overview), caret = [question.selectionStart, question.selectionEnd];
    model.question = question.value; invalidate(model);
    if (hadOverview) {context.render(); const current = (context.shell ?? document).querySelector('[aria-label="Social baseline question"]');
      if (current) {current.focus(); current.setSelectionRange(...caret);}}
  }});
  for (let index = 0; index < 4; index++) {
    const label = element("label", `Evidence Layer ${index + 1}`), select = element("select"); select.setAttribute("aria-label", `Evidence Layer ${index + 1}`);
    const empty = element("option", "Choose a Layer or leave missing"); empty.value = ""; select.append(empty);
    for (const layer of context.layers) {
      const option = element("option", layer.title); option.value = layer.layerId; select.append(option);
    }
    if (model.layerIds[index] && !context.layers.some(layer => layer.layerId === model.layerIds[index])) {
      const missing = element("option", "Layer unavailable in this Project"); missing.value = model.layerIds[index]; select.append(missing);
    }
    select.value = model.layerIds[index] ?? "";
    select.addEventListener("change", () => {if (!controls.disabled && !locked(context)) {model.layerIds[index] = select.value; invalidate(model); context.render();}});
    label.append(select); controls.append(label);
  }
  controls.append(button("Load selected evidence reviews", () => {void load(context, false);}),
    button("Refresh selected evidence reviews", () => {void load(context, true);}));
  panel.append(controls);
  if (model.controller) panel.append(button("Cancel evidence review loading", () => {
    model.controller?.abort(); model.controller = null; model.overview = null;
    model.message = "Evidence review loading cancelled."; context.render();
  }));
  const message = element("p", model.message ?? "Choose the study question and evidence Layers, then load their reviews. Saved selections reopen without reading metadata."); message.role = "status"; message.setAttribute("aria-live", "polite"); panel.append(message);
  const table = element("table"); table.className = "gis-compact-table"; table.append(element("caption", "Social baseline evidence topics"));
  const header = element("tr"); for (const title of ["Topic", "Review", "Observation period", "Suitability"]) {const cell = element("th", title); cell.scope = "col"; header.append(cell);}
  const head = element("thead"); head.append(header); table.append(head); const body = element("tbody");
  for (const topic of SOCIAL_BASELINE_TOPICS) {
    const found = model.overview?.topics.find(row => row.id === topic.id), review = found?.review, source = review?.report.evidenceReview;
    const row = element("tr"), name = element("th", topic.label); name.scope = "row"; row.append(name,
      element("td", review ? review.title : model.overview ? "Not supplied" : "Not loaded"),
      element("td", source?.periodStart ? `${source.periodStart} to ${source.periodEnd}` : "Unknown"),
      element("td", source?.suitability ?? "Not reviewed")); body.append(row);
  }
  table.append(body); const scroll = element("div"); scroll.className = "receptor-screening-table-scroll"; scroll.append(table); panel.append(scroll);
  const unresolved = model.overview?.unresolvedSelections ?? [];
  if (unresolved.length) {const list = element("ul"); for (const row of unresolved) list.append(element("li", `${row.title}: ${row.status}. ${row.reason}`)); panel.append(list);}
  if (model.overview) {
    const supplied = model.overview.topics.filter(row => row.review).length;
    panel.append(element("p", `${supplied} of 4 topics have a source review. Source completeness, dates and professional interpretation still need assessment. Each source retains its own influence area and screening question; there is no combined population, area or impact total.`));
    for (const topic of model.overview.topics.filter(row => row.review)) {
      const review = topic.review;
      panel.append(element("p", `${review.title}: ${review.representation === "catalog-metadata-summary" ? "Catalog metadata summary; original audit not downloaded or independently verified." : "Resident report and feature bindings checked."}`));
    }
    const exportButton = button("Download Project social baseline JSON", () => {
      if (locked(context) || model.controller || !model.overview) return;
      if (!model.snapshotCurrent?.(true)) {invalidate(model); model.message = "The selected Project or Layer version changed. Load the current reviews again."; context.render(); return;}
      download("project-social-baseline.json", JSON.stringify(model.overview, null, 2), "application/json");
    }); exportButton.disabled = locked(context); panel.append(exportButton);
    panel.append(element("p", "The selection is in this Project draft. Save the Project to retain it; load reviews again after reopening. Selections for temporary or removed Layers are omitted from the saved Project. Retain temporary results through the existing Layer workflow."));
  }
  return panel;
}

function modelFor(context) {
  if (context.state.projectSocialBaseline) return context.state.projectSocialBaseline;
  let selection = {question: "", layerIds: []}, message;
  const saved = context.project?.extensions?.opengeoSocialBaseline;
  if (saved) try {selection = validateProjectSocialBaselineSelection(saved);} catch {message = "The saved social baseline selection is invalid. Choose a question and Layers to replace it.";}
  return context.state.projectSocialBaseline = {...selection, layerIds: [...selection.layerIds], message, overview: null, controller: null};
}
function locked(context) {return context.disposed || context.queryLocationScopeInvalid || Boolean(context.state.analysisRegistrationSession);}
function invalidate(model) {model.overview = null; model.message = "Selection changed. Load the reviews to update the baseline.";}
function layerIdentity(layer) {return JSON.stringify([layer.layerId, layer.datasetId, layer.datasetVersionId, layer.sourceVersion]);}
async function load(context, refresh) {
  const model = modelFor(context); if (locked(context) || model.controller) return;
  let selection;
  try {selection = validateProjectSocialBaselineSelection({schemaVersion: "opengeo.project-social-baseline-selection.1.0.0", question: model.question,
    layerIds: model.layerIds.filter(Boolean)});} catch (error) {model.message = error.message; context.render(); return;}
  const controller = new AbortController(), currentProject = context.project;
  model.controller = controller; model.overview = null; model.message = "Loading selected evidence reviews…";
  const selected = selection.layerIds.map(layerId => {const layer = context.layers.find(value => value.layerId === layerId); return {layerId, layer, identity: layer && layerIdentity(layer), collection: context.dataByLayerId?.get(layerId)};});
  const snapshotCurrent = (checkResidentContent = false) => !controller.signal.aborted && !locked(context) && context.project === currentProject
    && selected.every(item => {const layer = context.layers.find(value => value.layerId === item.layerId); return !item.layer ? !layer : layer && layerIdentity(layer) === item.identity
      && context.dataByLayerId?.get(item.layerId) === item.collection
      && (!checkResidentContent || item.residentSnapshot === undefined || residentUnchanged(item));});
  const current = () => snapshotCurrent(true) && model.controller === controller;
  context.project.extensions = {...context.project.extensions, opengeoSocialBaseline: selection};
  context.render();
  try {
    const metadataReads = new Map();
    const results = await Promise.all(selected.map(async item => {
      const title = item.layer?.title ?? "Unavailable Layer";
      if (!item.layer) return {unresolved: {layerId: item.layerId, title, status: "unavailable", reason: "Layer is unavailable in this Project."}};
      const receipt = item.collection?.["opengeo:analysis"] ?? item.collection?.properties?.["opengeo:analysis"];
      if (receipt) {
        try {const review = readProjectSocialReview({layer: item.layer, collection: item.collection, observedAt: new Date().toISOString()});
          item.residentSnapshot = JSON.stringify(item.collection); return {review};}
        catch (error) {return {unresolved: {layerId: item.layerId, title, status: error.code === "social_baseline_unreviewed" ? "unreviewed" : "invalid", reason: error.message.slice(0,500)}};}
      }
      if (!context.loadSocialBaselineKnowledge || item.layer.sourceType !== "governed-dataset" || !item.layer.datasetId || !item.layer.datasetVersionId) return {unresolved: {layerId: item.layerId, title, status: "unloaded", reason: "A complete resident screening report or a saved exact Layer version is required."}};
      let knowledge;
      try {
        if (!metadataReads.has(item.layer.datasetId)) metadataReads.set(item.layer.datasetId,
          context.loadSocialBaselineKnowledge(item.layer.datasetId, {signal: controller.signal, refresh}));
        knowledge = await metadataReads.get(item.layer.datasetId);
      }
      catch {return {unresolved: {layerId: item.layerId, title, status: "unavailable", reason: "Metadata could not be read with the current Project access."}};}
      try {return {review: readProjectSocialReview({layer: item.layer, knowledge, observedAt: new Date().toISOString()})};}
      catch (error) {return {unresolved: {layerId: item.layerId, title, status: error.code === "social_baseline_unreviewed" ? "unreviewed" : "invalid", reason: error.message.slice(0,500)}};}
    }));
    if (!current()) {if (model.controller === controller && !context.disposed) model.message = "The selected Project or Layer version changed. Load the current reviews again."; return;}
    model.overview = composeProjectSocialBaseline({question: selection.question, reviews: results.flatMap(row => row.review ? [row.review] : []), unresolvedSelections: results.flatMap(row => row.unresolved ? [row.unresolved] : [])});
    model.snapshotCurrent = snapshotCurrent;
    model.message = "Selected source reviews are ready. Missing and unavailable evidence remain explicit.";
  } catch (error) {if (current()) {model.overview = null; model.message = error.message;}}
  finally {if (model.controller === controller) model.controller = null; if (!context.disposed) context.render();}
}
function residentUnchanged(item) {try {return JSON.stringify(item.collection) === item.residentSnapshot;} catch {return false;}}
function element(tag, text) {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;}
function button(text, action) {const node = element("button", text); node.type = "button"; node.addEventListener("click", action); return node;}
