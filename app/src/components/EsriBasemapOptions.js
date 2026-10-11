import {ESRI_BASEMAP_OPTIONS, esriBasemapDefinition} from "../lib/esriBasemaps.js";

export function EsriBasemapOptions({session, selectBasemap, enabled = true}) {
  const section = document.createElement("details");
  section.className = "gis-basemap-catalog-group gis-esri-basemaps";
  const summary = document.createElement("summary");
  summary.textContent = "Esri / ArcGIS · public imagery and API-key options";
  const intro = document.createElement("p");
  intro.textContent = "World Imagery’s public endpoint can respond without a key. That does not make its imagery open data. Check your permitted use and retain attribution. ArcGIS API services require a key and may incur usage charges.";
  const select = document.createElement("select");
  select.ariaLabel = "Esri basemap";
  for (const option of ESRI_BASEMAP_OPTIONS) {
    const item = document.createElement("option");
    item.textContent = option.title;
    item.value = option.id;
    select.append(item);
  }
  const keyLabel = document.createElement("label");
  keyLabel.textContent = "ArcGIS browser API key · this page only";
  const key = document.createElement("input");
  key.type = "password";
  key.autocomplete = "off";
  key.spellcheck = false;
  key.ariaLabel = "ArcGIS browser API key";
  keyLabel.append(key);
  const privacy = document.createElement("p");
  privacy.textContent = "Use a basemap-only key restricted to this site’s origin. It stays in memory until you clear it or leave this page; it is not saved with maps or shared with viewers. Re-enter it after reloading. Shared, centrally managed Esri connections are not yet available.";
  const terms = document.createElement("a");
  terms.href = "https://developers.arcgis.com/documentation/terms-of-use/";
  terms.textContent = "Esri terms and attribution";
  terms.target = "_blank";
  terms.rel = "noopener noreferrer";
  const consent = document.createElement("label");
  const accepted = document.createElement("input");
  accepted.type = "checkbox";
  consent.append(accepted, " I have permission to use this service under its terms.");
  const status = document.createElement("p");
  status.role = "status";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "gis-button";
  use.textContent = "Use Esri basemap";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "gis-button";
  clear.textContent = "Clear Esri key";
  const update = () => {
    const option = ESRI_BASEMAP_OPTIONS.find(({id}) => id === select.value);
    keyLabel.hidden = !option.requiresKey;
    privacy.hidden = !option.requiresKey;
    clear.hidden = !session.configured;
    use.disabled = !enabled || !accepted.checked || (option.requiresKey && !session.configured && !key.value.trim());
    status.textContent = !enabled ? "Esri basemaps require an Earth map." : option.requiresKey
      ? session.configured ? "Browser key configured for this page." : "API key required."
      : "No key is sent to the public endpoint. Service availability and usage terms still apply.";
  };
  select.addEventListener("change", update);
  accepted.addEventListener("change", update);
  key.addEventListener("input", update);
  clear.addEventListener("click", () => { session.clear(); key.value = ""; update(); });
  use.addEventListener("click", () => {
    if (use.disabled) return;
    try {
      const option = ESRI_BASEMAP_OPTIONS.find(({id}) => id === select.value);
      if (option.requiresKey && key.value.trim()) session.configure(key.value);
      key.value = "";
      update();
      Promise.resolve(selectBasemap(esriBasemapDefinition(select.value, `custom-${crypto.randomUUID()}`)))
        .catch(() => { status.textContent = "Esri imagery could not be applied. Your previous background remains; try again or choose another basemap."; });
    } catch (error) { status.textContent = error.message; }
  });
  const instructions = document.createElement("p");
  instructions.textContent = "Choose access, confirm permission, then select Use Esri basemap. Your current background stays until you apply the selection.";
  section.append(summary, instructions, select, keyLabel, consent, use, status, terms, intro, privacy, clear);
  update();
  return section;
}
