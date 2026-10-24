import {registerStaticCogReference, cogReferenceDefaultBands} from "../lib/cogReference.js";
import {layerHref} from "../lib/applicationRoutes.js";
import {CatalogResourceMapAction} from "./CatalogResourceMapAction.js";

export function StaticItemCatalogRegistration({adapter, reference, projects, organization}) {
  const root = document.createElement("section"); root.className = "static-item-registration";
  root.append(element("h4", "Register a referenced Catalog Layer"),
    element("p", "Choose the access workspace for this Layer. Registration preserves the upstream imagery and terms. Saving it to a Project is a separate action."));
  const eligible = projects.filter(project => project.status === "active" && (organization.callerRole === "admin" || ["owner", "editor"].includes(project.callerRole)));
  if (!eligible.length) {root.append(element("p", "An existing editable access workspace is required.")); return root;}
  const form = document.createElement("form"), workspace = document.createElement("select"), asset = document.createElement("select");
  for (const project of eligible) workspace.append(option(project.id, project.name));
  for (const distribution of reference.assets.filter(asset => asset.type?.includes("tiff") && asset.cogCompatible !== false)) asset.append(option(distribution.key, `${distribution.key} · ${distribution.license ?? "terms not supplied"}`));
  if (reference.assets.some(asset => asset.key === "visual")) asset.value = "visual";
  const title = document.createElement("input"); title.required = true; title.maxLength = 200; title.value = reference.id;
  const attribution = document.createElement("input"); attribution.maxLength = 1000;
  const bands = document.createElement("input"); bands.required = true; bands.maxLength = 12;
  const size = document.createElement("input"); size.type = "number"; size.min = "1"; size.step = "1";
  const explicitBands = reference.adapter !== "opengeo.s2-geoparquet.1";
  const terms = element("p", "");
  const updateTerms = () => {
    bands.value = cogReferenceDefaultBands(reference, asset.value).join(",");
    size.value = reference.assets.find(item => item.key === asset.value)?.original?.["file:size"] ?? "";
    terms.textContent = asset.options.length ? `Selected distribution terms: ${reference.assets.find(item => item.key === asset.value)?.license ?? "not supplied"}. Registration does not establish additional rights or asset access.`
      : "This Item has no compatible public TIFF asset. Its other references remain available for inspection.";
  };
  asset.addEventListener("change", updateTerms); updateTerms();
  const submit = element("button", "Register Layer"); submit.type = "submit";
  const status = element("p", "The new Layer will use internal visibility in the chosen workspace."); status.setAttribute("role", "status");
  const result = document.createElement("div"); let busy = false, disposed = false, mapAction = null;
  form.append(label("Access workspace", workspace), label("Raster asset", asset));
  if (explicitBands) form.append(label("Raster bands (one or three)", bands), element("p", "Use one-based band numbers, such as 1 or 1,2,3. Unknown layouts require an explicit choice. Native values, scales and offsets remain in the source metadata; display does not apply physical-unit conversion."),
    label("Known asset size in bytes (optional)", size), element("p", "Retain a size established from provider metadata or an independent check when browser range headers are hidden. Leave unknown sizes blank. This value is recorded as an unverified user declaration; it does not verify the imagery snapshot."));
  form.append(label("Layer title", title), label("Attribution", attribution), terms, submit, status, result);
  submit.disabled = !asset.options.length;
  root.append(form); root.dispose = () => {disposed = true; mapAction?.dispose(); result.replaceChildren();};
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || disposed || !asset.options.length || !form.reportValidity()) return; busy = true;
    for (const control of [workspace, asset, title, attribution, bands, size, submit]) control.disabled = true;
    status.textContent = "Checking Catalog identity and registering the reference…";
    try {
      const context = await captureContext(adapter);
      const outcome = await registerStaticCogReference({adapter, projectId: workspace.value, reference, context,
        options: {assetKey: asset.value, title: title.value, attribution: attribution.value.trim() || null,
          ...(explicitBands ? {bands: bands.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN),
            sizeBytes: size.value === "" ? null : Number(size.value)} : {})},
        isCurrent: () => !disposed && root.isConnected});
      if (disposed || !root.isConnected) return;
      const source = outcome.source;
      status.textContent = outcome.reused ? "The existing Catalog Layer is ready. Its identity and metadata were preserved." : "Catalog Layer registered. No Project or imagery copy was created.";
      const details = element("a", "Metadata and access"); details.href = layerHref(source.datasetId, {adapterKind: adapter.kind}); result.append(details);
      const action = CatalogResourceMapAction({dataset: {id: source.datasetId, projectId: source.projectId, name: source.name,
        sourceType: "cog", status: source.status, capabilities: source.capabilities}, adapter});
      mapAction?.dispose(); mapAction = action;
      if (action) result.append(action.button, action.panel);
      root.dataset.registered = source.datasetId;
    } catch (error) {
      if (disposed || !root.isConnected) return;
      status.textContent = /context_changed|scope_changed/.test(error.code ?? "")
        ? "Your sign-in or selected account changed. Reopen Catalog before continuing."
        : `${error.message || "Registration could not be confirmed."} Check Catalog before trying again; a saved reference may already exist.`;
      for (const control of [workspace, asset, title, attribution, bands, size, submit]) control.disabled = false;
      if (!asset.options.length) submit.disabled = true;
    } finally {busy = false;}
  });
  return root;
}
async function captureContext(adapter) {
  if (typeof adapter.tokenProvider !== "function" && typeof adapter.organizationProvider !== "function") return null;
  const {tokenProvider, organizationProvider, baseUrl} = adapter;
  if (typeof tokenProvider !== "function" || typeof organizationProvider !== "function") throw Error("Sign-in scope unavailable.");
  const organization = await organizationProvider.call(adapter), token = await tokenProvider.call(adapter);
  const context = {tokenProvider, organizationProvider, baseUrl, organization: String(organization).toLowerCase(), token};
  await adapter.assertCollectionContext(context); return context;
}
function element(tag, value) {const node = document.createElement(tag); node.textContent = value; return node;}
function label(value, input) {const node = element("label", value); node.append(input); return node;}
function option(value, text) {const node = element("option", text); node.value = value; return node;}
