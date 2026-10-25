import {SOCIAL_BASELINE_TOPICS, validateSocialBaselineEvidence} from "../lib/socialBaselineEvidence.js";

/** Review retained screening evidence without reading sources or running analysis. */
export function ReceptorScreeningEvidence({result, locked, onApply, onDownload, onMessage}) {
  const report = result.collection["opengeo:analysis"].screening;
  const draft = result.socialEvidenceDraft ??= structuredClone(report.evidenceReview ?? {
    schemaVersion: "opengeo.social-baseline-evidence.1.0.0", topic: "", sourceDescription: result.source.title,
    spatialUnit: "", periodStart: null, periodEnd: null, coverage: "unknown", coverageBasis: "",
    suitability: "unreviewed", suitabilityBasis: "", limitations: "", reviewer: "", reviewedAt: "", fields: []
  });
  const section = element("section"); section.className = "social-baseline-evidence";
  section.append(element("h4", "Social baseline evidence"));
  const table = element("table"); table.className = "gis-compact-table";
  table.append(element("caption", "Evidence topics in this result"));
  const head = element("thead"), heading = element("tr");
  for (const text of ["Topic", "Evidence supplied"]) {
    const cell = element("th", text); cell.scope = "col"; heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = element("tbody");
  for (const topic of SOCIAL_BASELINE_TOPICS) {
    const row = element("tr"), name = element("th", topic.label); name.scope = "row";
    row.append(name, element("td", report.evidenceReview?.topic === topic.id
      ? "One source review attached" : "Not supplied in this result")); body.append(row);
  }
  table.append(body); section.append(table,
    element("p", "Each result reviews one receptor inventory. Other topics need separate evidence. Coverage and suitability are reviewer statements; a complete social baseline is not established."),
    element("p", "Source-zone totals and rates retain their original spatial unit after clipping. They are not allocated to the clipped area or added across areas. Buildings do not establish households, land use does not establish tenure, and overlap does not establish affected people or impacts."));
  const details = element("details"); details.open = result.socialEvidenceExpanded ?? Boolean(report.evidenceReview);
  details.append(element("summary", report.evidenceReview ? "Edit source evidence review" : "Review source evidence"));
  details.addEventListener("toggle", () => {result.socialEvidenceExpanded = details.open;});
  const controls = element("fieldset"); controls.disabled = locked();
  controls.append(element("legend", "Source evidence review"));
  const change = (key, value) => {if (!locked()) draft[key] = value;};
  controls.append(choice("Evidence topic", draft.topic, [["", "Choose a topic"], ...SOCIAL_BASELINE_TOPICS.map(t => [t.id, t.label])], value => change("topic", value)),
    field("Source citation and description", draft.sourceDescription, 500, value => change("sourceDescription", value), {required: true}),
    field("Original source spatial unit", draft.spatialUnit, 160, value => change("spatialUnit", value), {required: true}),
    element("p", "For example: census reporting zone, settlement polygon, facility point or land-use parcel. Source attributes keep this meaning even when the geometry is clipped."),
    field("Observation period start", draft.periodStart ?? "", 10, value => change("periodStart", value || null), {type: "date"}),
    field("Observation period end", draft.periodEnd ?? "", 10, value => change("periodEnd", value || null), {type: "date"}),
    element("p", "Leave both dates blank when the observation period is unknown."),
    choice("Declared source coverage", draft.coverage, [["unknown", "Unknown"], ["partial", "Partial"], ["declared-complete", "Declared complete by reviewer"]], value => change("coverage", value)),
    field("Coverage evidence and limitations", draft.coverageBasis, 500, value => change("coverageBasis", value)),
    choice("Source suitability", draft.suitability, [["unreviewed", "Not reviewed"], ["suitable", "Suitable for this question"], ["limited", "Limited suitability"], ["unsuitable", "Unsuitable for this question"]], value => change("suitability", value)),
    field("Suitability basis", draft.suitabilityBasis, 500, value => change("suitabilityBasis", value)),
    field("Interpretation limits and missing evidence", draft.limitations, 500, value => change("limitations", value), {required: true}),
    field("Evidence reviewer", draft.reviewer, 160, value => change("reviewer", value), {required: true}));
  const names = [...new Set(result.collection.features.flatMap(feature => Object.keys(feature.properties.source)))].sort();
  const fields = element("div");
  const renderFields = () => {
    fields.replaceChildren();
    draft.fields.forEach((definition, index) => {
      const group = element("fieldset"); group.append(element("legend", `Source attribute ${index + 1}`));
      const update = (key, value) => {if (!locked()) definition[key] = value;};
      group.append(choice(`Source field ${index + 1}`, definition.name,
        [["", "Choose a retained source field"], ...names.map(name => [name, name])], value => update("name", value)),
      field(`Field meaning ${index + 1}`, definition.meaning, 500, value => update("meaning", value), {required: true}),
      field(`Field unit ${index + 1}`, definition.unit ?? "", 80, value => update("unit", value || null)),
      field(`Field denominator ${index + 1}`, definition.denominator ?? "", 160, value => update("denominator", value || null)),
      button(`Remove source attribute ${index + 1}`, () => {
        if (locked()) return; draft.fields.splice(index, 1); renderFields();
      }));
      fields.append(group);
    });
    const add = button("Describe another source attribute", () => {
      if (locked() || draft.fields.length >= 6) return;
      draft.fields.push({name: "", meaning: "", unit: null, denominator: null}); renderFields();
    });
    add.disabled = !names.length || draft.fields.length >= 6; fields.append(add);
  };
  renderFields(); controls.append(element("p", "Describe up to six original attributes. Export retains individual values, missing values, units and denominators without aggregation."), fields,
    button("Apply source evidence review", () => {
      if (locked()) return;
      try {
        const review = validateSocialBaselineEvidence({...structuredClone(draft), reviewedAt: new Date().toISOString()});
        onApply(review);
      } catch (error) {onMessage(error.message);}
    }));
  details.append(controls); section.append(details);
  if (report.evidenceReview) {
    const review = report.evidenceReview;
    section.append(element("p", `Attached review by ${review.reviewer} · ${review.reviewedAt}. Observation period: ${review.periodStart ?? "Unknown"}${review.periodEnd ? ` to ${review.periodEnd}` : ""}.`),
      button("Download social baseline evidence CSV", () => {if (!locked()) onDownload();}));
  }
  return section;
}

function element(tag, text) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
function field(label, value, maxLength, change, {required = false, type = "text"} = {}) {
  const wrapper = element("label", label), input = element("input");
  input.type = type; input.value = value; input.maxLength = maxLength; input.required = required; input.setAttribute("aria-label", label);
  input.addEventListener("input", () => change(input.value)); wrapper.append(input); return wrapper;
}
function choice(label, value, choices, change) {
  const wrapper = element("label", label), input = element("select"); input.setAttribute("aria-label", label);
  for (const [id, title] of choices) {const option = element("option", title); option.value = id; input.append(option);}
  input.value = value; input.addEventListener("change", () => change(input.value)); wrapper.append(input); return wrapper;
}
function button(label, action) {
  const node = element("button", label); node.type = "button"; node.addEventListener("click", action); return node;
}
