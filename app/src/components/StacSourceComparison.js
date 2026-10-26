import {reviewStacSources, STAC_SOURCE_SUITABILITY_LIMITS} from "../lib/stacSourceSuitability.js";
import {canonicalJson} from "../lib/artifactCanonicalJson.js";

// Reviews retained metadata only. Asset inspection and account writes remain
// deliberate actions in the existing Catalog registration panel.
export function StacSourceComparison({onReference = null, guardCurrent = async () => true} = {}) {
  const root = node("details"); root.className = "stac-source-comparison";
  root.append(node("summary", "Compare selected STAC assets"), node("p", "Add asset references from the search results, then compare them for your study. This review reads no imagery and makes no provider requests. It covers the selected metadata, not every available source."));
  const selected = node("ul"), form = node("form"), results = node("div"), status = node("p", "No assets selected.");
  form.className = "platform-controls";
  status.setAttribute("role", "status"); status.ariaLive = "polite";
  const bounds = input("text"), start = input("date"), end = input("date");
  const resolution = input("number"), bandNames = input("text"), classNames = input("text");
  const cloud = input("number"), licenses = input("text"), bytes = input("number"), priority = node("select");
  resolution.min = "0"; resolution.step = "any"; cloud.min = "0"; cloud.max = "100"; cloud.step = "any";
  bytes.min = "1"; bytes.step = "1";
  for (const [value, text] of [["coverage", "Footprint coverage"], ["dates", "Dates"], ["resolution", "Nominal resolution"],
    ["taxonomy", "Bands and class labels"], ["quality", "Scene cloud cover"], ["rights", "Asset license"], ["cost", "Declared transfer size"]]) {
    const option = node("option", text); option.value = value; priority.append(option);
  }
  const fields = [["Comparison area west, south, east, north", bounds], ["Comparison start (UTC)", start], ["Comparison end (UTC)", end],
    ["Maximum nominal resolution in meters (optional)", resolution], ["Required band names (optional, comma separated)", bandNames],
    ["Required class labels (optional, comma separated)", classNames], ["Maximum scene cloud cover percent (optional)", cloud],
    ["Accepted asset licenses (optional, comma separated)", licenses], ["Maximum declared asset bytes (optional)", bytes], ["First ranking priority", priority]];
  for (const [text, control] of fields) {control.ariaLabel = text; const label = node("label", text); label.append(control); form.append(label);}
  const compare = node("button", "Compare selected assets"); compare.type = "submit"; compare.disabled = true;
  form.append(compare); root.append(selected, form, status, results);
  let selections = [], report = null, generation = 0, controller = null, disposed = false;
  const criteria = () => ({bounds: bounds.value.split(",").map(value => value.trim() ? Number(value) : NaN),
    periodStart: start.value || null, periodEnd: end.value || null, maximumResolutionMeters: number(resolution.value),
    requiredBandNames: list(bandNames.value), requiredClassNames: list(classNames.value), maximumCloudCover: number(cloud.value),
    acceptedLicenses: list(licenses.value), maximumTransferBytes: number(bytes.value), priority: priority.value});
  const fingerprint = () => JSON.stringify(criteria());
  const clearPanels = () => {for (const panel of results.querySelectorAll(".static-item-registration")) panel.dispose?.(); results.replaceChildren();};
  function invalidate(message) {
    controller?.abort(); generation++; report = null; clearPanels(); compare.disabled = disposed || !selections.length;
    form.removeAttribute("aria-busy"); if (message) status.textContent = message;
  }
  for (const [, control] of fields) for (const event of ["input", "change"]) control.addEventListener(event, () => {
    if (!disposed) invalidate("Criteria changed. Compare again before using or downloading a review.");
  });
  function showSelection() {
    selected.replaceChildren();
    for (const selection of selections) {
      const item = node("li", `${selection.reference.collectionId}/${selection.reference.id} · ${selection.assetKey} · bands ${selection.bands.join(", ")} `);
      const remove = node("button", `Remove ${selection.reference.id} / ${selection.assetKey}`); remove.type = "button";
      remove.addEventListener("click", () => {
        if (disposed) return; selections = selections.filter(value => value !== selection); invalidate(); showSelection();
      }); item.append(remove); selected.append(item);
    }
    status.textContent = `${selections.length} selected asset${selections.length === 1 ? "" : "s"}. Compare to review the current criteria.`;
    compare.disabled = disposed || !selections.length;
  }
  root.addSelection = ({reference, assetKey, bands}) => {
    if (disposed || !root.isConnected) return;
    if (!Array.isArray(bands) || ![1, 3].includes(bands.length) || new Set(bands).size !== bands.length
      || bands.some(value => !Number.isInteger(value) || value < 1 || value > 64)) throw Error("Choose one or three explicit band numbers before adding an asset.");
    const identity = value => canonicalJson([value.reference.query.endpoint, value.reference.collectionId, value.reference.id, value.assetKey, value.bands]);
    const selection = {reference, assetKey, bands: [...bands]};
    if (selections.some(value => identity(value) === identity(selection))) {status.textContent = "This asset and band selection is already included."; return;}
    if (selections.length >= STAC_SOURCE_SUITABILITY_LIMITS.candidates) throw Error(`Compare at most ${STAC_SOURCE_SUITABILITY_LIMITS.candidates} selected assets.`);
    selections.push(selection); invalidate(); showSelection(); root.open = true;
  };
  root.reset = query => {
    invalidate(); selections = []; showSelection();
    bounds.value = query?.bbox?.join(", ") ?? ""; start.value = localTime(query?.start); end.value = localTime(query?.end);
  };
  const current = (ticket, signature, reviewed) => !disposed && generation === ticket && root.isConnected
    && signature === fingerprint() && (!reviewed || report === reviewed);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (disposed || !selections.length || !root.isConnected || !form.reportValidity()) return;
    invalidate(); const ticket = generation, signature = fingerprint(), frozen = [...selections]; controller = new AbortController();
    compare.disabled = true; form.setAttribute("aria-busy", "true"); status.textContent = "Comparing retained source metadata and footprints…";
    try {
      if (!await guardCurrent() || !current(ticket, signature)) return;
      const reviewed = await reviewStacSources({selections: frozen, criteria: criteria(), timestamp: new Date().toISOString(),
        signal: controller.signal, assertCurrent: () => {if (!current(ticket, signature)) throw Error("Source comparison changed.");}});
      if (!await guardCurrent() || !current(ticket, signature)) return;
      report = reviewed;
      status.textContent = `${reviewed.candidates.length} selected assets compared. Footprint overlap is not valid-pixel coverage; quality, rights and processing cost remain limited to their stated evidence.`;
      results.append(node("p", "The first priority decides order; the other displayed criteria break ties. Missing evidence stays unknown. Ranking does not grant access or approve a source."));
      for (const candidate of reviewed.candidates) {
        const card = node("article"); card.className = "stac-source-comparison-result"; card.dataset.candidateId = candidate.id;
        card.append(node("h4", `${candidate.rank}. ${candidate.title}`));
        const facts = node("dl");
        for (const [key, label] of [["coverage", "Declared footprint"], ["dates", "Dates"], ["resolution", "Resolution"],
          ["taxonomy", "Bands and classes"], ["quality", "Quality"], ["rights", "Rights"], ["cost", "Transfer size and cost"]]) {
          facts.append(node("dt", label), node("dd", `${factText(candidate.facts, key)} · ${candidate.assessments[key].status} · ${candidate.assessments[key].basis}`));
        }
        card.append(facts);
        const selection = frozen.find(value => value.reference.query.endpoint === candidate.identity.endpoint
          && value.reference.collectionId === candidate.identity.collectionId && value.reference.id === candidate.identity.itemId
          && value.assetKey === candidate.identity.assetKey && canonicalJson(value.bands) === canonicalJson(candidate.identity.bands));
        if (onReference && selection) {
          const use = node("button", `Review ${candidate.identity.itemId} / ${candidate.identity.assetKey} for Catalog`); use.type = "button";
          use.addEventListener("click", async () => {
            try {
              if (!current(ticket, signature, reviewed) || !await guardCurrent() || !current(ticket, signature, reviewed)) return;
              for (const panel of card.querySelectorAll(".static-item-registration")) {panel.dispose?.(); panel.remove();}
              const panel = onReference(selection.reference, {report: reviewed, candidateId: candidate.id,
                isCurrent: () => current(ticket, signature, reviewed)});
              if (panel) card.append(panel);
            } catch (error) {if (current(ticket, signature, reviewed)) status.textContent = error.message;}
          }); card.append(use);
        }
        results.append(card);
      }
      const download = node("button", "Download selected source comparison JSON"); download.type = "button";
      download.addEventListener("click", async () => {
        try {
          if (!current(ticket, signature, reviewed) || !await guardCurrent() || !current(ticket, signature, reviewed)) return;
          const url = URL.createObjectURL(new Blob([JSON.stringify(reviewed)], {type: "application/json"}));
          const link = node("a"); link.href = url; link.download = "stac-source-suitability.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (error) {if (current(ticket, signature, reviewed)) status.textContent = error.message;}
      }); results.append(download);
    } catch (error) {if (current(ticket, signature)) status.textContent = error.message;}
    finally {if (current(ticket, signature)) {compare.disabled = false; form.removeAttribute("aria-busy");}}
  });
  root.dispose = () => {disposed = true; invalidate(); selections = [];};
  return root;
}
function node(tag, text) {const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;}
function input(type) {const value = node("input"); value.type = type; return value;}
function number(value) {return value.trim() ? Number(value) : null;}
function list(value) {return value.split(",").map(text => text.trim()).filter(Boolean);}
function localTime(value) {return typeof value === "string" ? value.slice(0, 10) : "";}
function factText(facts, key) {
  switch (key) {
    case "coverage": return facts.coverage.fraction === null ? "Overlap unknown" : `${(facts.coverage.fraction * 100).toFixed(2)}% study footprint overlap`;
    case "dates": return `${facts.observationPeriod.start} to ${facts.observationPeriod.end}`;
    case "resolution": return facts.resolution.meters === null ? "Resolution unknown" : `${facts.resolution.meters} m nominal`;
    case "taxonomy": return `Bands: ${facts.taxonomy.bandNames.join(", ") || "unknown"}; classes: ${facts.taxonomy.classNames.join(", ") || "unknown"}`;
    case "quality": return facts.quality.itemCloudCoverPercent === null ? "Scene cloud cover unknown" : `${facts.quality.itemCloudCoverPercent}% scene cloud cover`;
    case "rights": return `Asset license: ${facts.rights.assetLicense ?? "unknown"}; Item license: ${facts.rights.itemLicense ?? "unknown"}`;
    case "cost": return facts.cost.assetBytes === null ? "Asset size unknown" : `${facts.cost.assetBytes} declared bytes`;
  }
}
