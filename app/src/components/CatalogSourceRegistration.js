import {directoryHref, layerHref} from "../lib/applicationRoutes.js";
import {canonicalJson} from "../lib/artifactCanonicalJson.js";
import {appendBackupReference, appendSourceEdition, assertKnowledgeSize} from "../lib/sourceReferenceKnowledge.js";
import {matchesReviewedDisplay} from "../lib/reviewedDisplayIdentity.js";
import {sourceLinks} from "./SourceDetails.js";
import {readProviderJson} from "../lib/providerJson.js";

// Register a provider reference without first creating or changing a composition.
// The existing source API remains the authorization and URL-validation boundary.
export function CatalogSourceRegistration({adapter, projects = [], organization, onRegistered = () => {}, fetchImplementation = globalThis.fetch}) {
  const root = document.createElement("details"); root.className = "catalog-source-registration";
  const eligible = projects.filter(project => project.status === "active"
    && (["owner", "editor"].includes(project.callerRole) || organization.callerRole === "admin"));
  if (!eligible.length || typeof adapter?.createSource !== "function") return null;
  root.append(element("summary", "Register Layer"), element("p", "Connect public tiles, an ArcGIS image service or a TIFF reference to Catalog. Choose its access workspace, review the reference, then register. Adding it to a saved Project and publishing it are separate decisions."));
  const form = document.createElement("form"), workspace = document.createElement("select");
  for (const project of eligible) workspace.append(option(project.id, project.name));
  const type = document.createElement("select"); type.append(option("xyz", "XYZ tiles"), option("imageserver", "ArcGIS ImageServer"), option("cog", "Public TIFF reference"));
  const title = document.createElement("input"); title.required = true; title.maxLength = 160;
  const url = document.createElement("input"); url.required = true; url.type = "url";
  url.placeholder = "https://provider.example/tile/{z}/{y}/{x}";
  const attribution = document.createElement("input"); attribution.maxLength = 1000;
  const description = document.createElement("textarea"); description.maxLength = 4000;
  description.placeholder = "Source description, terms and interpretation limits";
  const rasterIds = document.createElement("input"); rasterIds.placeholder = "For example: 2";
  const rasterSelection = label("Image record IDs (optional)", rasterIds);
  rasterSelection.hidden = true; rasterSelection.style.display = "none";
  const maxZoom = document.createElement("input"); maxZoom.type = "number"; maxZoom.min = "0"; maxZoom.max = "24"; maxZoom.value = "15";
  const zoomSelection = label("Maximum zoom", maxZoom), urlSelection = label("Tile URL", url);
  const bounds = document.createElement("input"); bounds.placeholder = "west, south, east, north";
  const bands = document.createElement("input"); bands.value = "1, 2, 3";
  const size = document.createElement("input"); size.type = "number"; size.min = "1"; size.max = "1099511627776"; size.step = "1"; size.disabled = true;
  const tiffSettings = document.createElement("div"); tiffSettings.hidden = true; tiffSettings.style.display = "none";
  tiffSettings.append(label("WGS84 bounds (west, south, east, north)", bounds), label("Display bands (one or three)", bands), label("Known file size in bytes (optional)", size),
    element("p", "Use the raster's actual extent and one-based band numbers. Registration saves a reference; availability and cloud-optimized layout remain unverified."));
  const references = document.createElement("details"); references.append(element("summary", "Backup and source edition (optional)"));
  const backupUri = document.createElement("input"); backupUri.placeholder = "s3://bucket/key or https://archive.example/file";
  const objectVersion = document.createElement("input"); objectVersion.maxLength = 1024;
  const edition = document.createElement("input"); edition.maxLength = 200; edition.placeholder = "For example: November 2010 snapshot";
  const editionNote = document.createElement("textarea"); editionNote.maxLength = 2000;
  editionNote.placeholder = "What this edition represents, differences from other versions, and unresolved source questions";
  const backups = backupCheckControl({adapter, workspace, sourceUrl: () => url.value.trim(),
    onReference: ({uri, version}) => {backupUri.value = uri; objectVersion.value = version ?? "";}});
  references.append(label("Backup URI", backupUri), label("Backup object version (optional)", objectVersion),
    label("Source edition (optional)", edition), label("Edition notes (optional)", editionNote),
    backups,
    element("p", "These are metadata references. Backup access and equivalence remain unverified; a label does not establish a release date. Review reads supported provider metadata before registration; it does not read dataset files."));
  const review = element("button", "Review Layer"); review.type = "submit";
  const status = element("p", "The reference starts with internal access. Registration does not copy provider data or grant public access."); status.setAttribute("role", "status");
  const result = document.createElement("div"); let disposed = false, busy = false, activeController, cachedMetadata;
  root.dispose = () => {disposed = true; activeController?.abort(); backups.dispose(); result.replaceChildren();};
  form.append(label("Access workspace", workspace), label("Layer title", title), urlSelection,
    label("Source type", type), rasterSelection, tiffSettings, label("Attribution", attribution), label("Source description and terms", description), zoomSelection, references, review);
  type.addEventListener("change", () => {
    const imagery = type.value === "imageserver", tiff = type.value === "cog";
    url.placeholder = tiff ? "https://provider.example/raster.tif" : imagery ? "https://provider.example/arcgis/rest/services/Imagery/ImageServer" : "https://provider.example/tile/{z}/{y}/{x}";
    urlSelection.firstChild.textContent = tiff ? "TIFF URL" : "Tile URL"; url.setAttribute("aria-label", tiff ? "TIFF URL" : "Tile URL");
    rasterSelection.hidden = !imagery; rasterSelection.style.display = imagery ? "" : "none";
    tiffSettings.hidden = !tiff; tiffSettings.style.display = tiff ? "" : "none";
    bounds.required = tiff; bands.required = tiff; size.disabled = !tiff;
    zoomSelection.hidden = tiff; zoomSelection.style.display = tiff ? "none" : ""; maxZoom.disabled = tiff;
  });
  root.append(form, status, result);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || disposed) return;
    busy = true; review.disabled = true;
    let context;
    try {
      context = await captureContext(adapter);
      const sourceUrl = new URL(url.value);
      if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash
        || (type.value === "xyz" && !["{z}", "{x}", "{y}"].every(key => url.value.includes(key)))
        || (type.value === "imageserver" && !/\/ImageServer\/?$/.test(sourceUrl.pathname))
        || (type.value === "cog" && !/\.tiff?$/i.test(sourceUrl.pathname))) throw Error("Use a public HTTPS source URL without credentials or query parameters. XYZ tiles need {z}, {x} and {y}; an image service must end with /ImageServer; a TIFF reference must end with .tif or .tiff.");
      const zoom = Number(maxZoom.value);
      if (type.value !== "cog" && (!Number.isInteger(zoom) || zoom < 0 || zoom > 24)) throw Error("Maximum zoom must be an integer from0 to24.");
      const selectedRasterIds = type.value === "imageserver" && rasterIds.value.trim()
        ? rasterIds.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [];
      if (selectedRasterIds.length > 32 || new Set(selectedRasterIds).size !== selectedRasterIds.length
        || selectedRasterIds.some(id => !Number.isInteger(id) || id < 0 || id > 2147483647)) {
        throw Error("Enter up to32 distinct image record IDs from0 to2147483647, separated by commas.");
      }
      const selectedBounds = type.value === "cog" ? bounds.value.split(",").map(value => value.trim() ? Number(value.trim()) : NaN) : [];
      const selectedBands = type.value === "cog" ? bands.value.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [];
      const sizeBytes = type.value === "cog" && size.value.trim() ? Number(size.value) : null;
      if (type.value === "cog") {
        if (selectedBounds.length !== 4 || selectedBounds.some(value => !Number.isFinite(value)) || selectedBounds[0] < -180 || selectedBounds[2] > 180
          || selectedBounds[1] < -90 || selectedBounds[3] > 90 || selectedBounds[0] >= selectedBounds[2] || selectedBounds[1] >= selectedBounds[3]) throw Error("Enter the raster's actual ordered WGS84 bounds: west, south, east, north.");
        if (![1, 3].includes(selectedBands.length) || new Set(selectedBands).size !== selectedBands.length
          || selectedBands.some(band => !Number.isInteger(band) || band < 1 || band > 64)) throw Error("Enter one or three distinct display band numbers from 1 to 64, separated by commas.");
        if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 1_099_511_627_776)) throw Error("Enter a known file size in whole bytes from 1 to 1099511627776, or leave it blank.");
      }
      const input = {name: title.value.trim(), description: description.value.trim() || null,
        classification: "internal", tags: [], source: {type: type.value, url: url.value,
          attribution: attribution.value.trim() || null,
          ...(type.value === "cog" ? {bands: selectedBands, bounds: selectedBounds, sizeBytes, license: null, referenceMetadata: {}}
            : {minZoom: 0, maxZoom: zoom, tileSize: 256,
              ...(type.value === "xyz" ? {scheme: "xyz"} : {imageFormat: "png32", interpolation: "RSP_NearestNeighbor", bandIds: [],
                ...(selectedRasterIds.length ? {rasterIds: selectedRasterIds} : {})})})}};
      if (!input.name) throw Error("Enter a Layer title.");
      const referenceInput = {backup: backupUri.value.trim() ? {uri: backupUri.value.trim(), objectVersion: objectVersion.value} : null,
        edition: edition.value.trim() ? {label: edition.value.trim(), sourceUri: input.source.url, note: editionNote.value.trim()} : null};
      if (!referenceInput.backup && objectVersion.value) throw Error("Enter a backup URI before its object version.");
      if (!referenceInput.edition && editionNote.value.trim()) throw Error("Enter a source edition before its notes.");
      const hasReferences = Boolean(referenceInput.backup || referenceInput.edition);
      if (hasReferences) {
        if (typeof adapter.getDatasetKnowledge !== "function" || typeof adapter.saveDatasetKnowledge !== "function") throw Error("Metadata editing is unavailable for this connection. Register the Layer first, then add its references in Catalog.");
        // Validate every reviewed pointer before creating a Catalog identity.
        applyReferences({schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []}, referenceInput);
      }
      const projectId = workspace.value;
      const confirm = element("button", "Register referenced Layer"); confirm.type = "button";
      confirm.dataset.action = "register-referenced-layer";
      const metadataPanel = element("section", ""); metadataPanel.className = "catalog-provider-metadata-review";
      const metadataStatus = element("p", ""); metadataStatus.setAttribute("role", "status");
      const metadataControls = element("div", ""), retainMetadata = document.createElement("input"), normalized = document.createElement("textarea");
      retainMetadata.type = "checkbox"; retainMetadata.checked = false; retainMetadata.disabled = true;
      normalized.rows = 6; normalized.spellcheck = false;
      const retryMetadata = element("button", "Try metadata again"); retryMetadata.type = "button"; retryMetadata.hidden = true;
      metadataPanel.append(element("h4", "Provider metadata"), metadataStatus, metadataControls, retryMetadata);
      let metadataResponse, sourceDocument;
      const metadataUrl = sourceLinks(input.source.url).metadata;
      const canSaveMetadata = typeof adapter.getDatasetKnowledge === "function" && typeof adapter.saveDatasetKnowledge === "function";
      const providerDraft = document => {
        if (!retainMetadata.checked || !metadataResponse) return document;
        let value;
        try {value = JSON.parse(normalized.value);} catch {throw Error("Check the normalized provider JSON. The metadata draft is retained; no Layer was registered.");}
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Normalized provider metadata must be a JSON object.");
        const draft = structuredClone(document);
        const retained = draft.metadata.source.find(item => item.id === sourceDocument.id || item.sourceUrl === sourceDocument.sourceUrl
          && item.retrievedAt === sourceDocument.retrievedAt && item.content === sourceDocument.content);
        if (retained && retained.content !== sourceDocument.content) throw Error("The retained provider response changed. Inspect the saved metadata before retrying.");
        if (!retained) draft.metadata.source.push(sourceDocument);
        const sourceId = retained?.id ?? sourceDocument.id;
        const existing = draft.metadata.normalized.find(item => item.evidence?.includes(sourceId));
        if (existing && canonicalJson(existing.value) !== canonicalJson(value)) throw Error("This response already has different normalized metadata. Inspect the saved revision before retrying.");
        if (!existing) draft.metadata.normalized.push({subject: "resource", property: "https://opengeo.tools/ns/arcgisLayerMetadata", value,
          provenance: canonicalJson(value) === canonicalJson(metadataResponse.data) ? "source_asserted" : "curator_asserted",
          method: "Provider JSON reviewed at registration; original response text retained separately",
          evidence: [sourceId, metadataUrl], timestamp: metadataResponse.retrievedAt});
        assertKnowledgeSize(draft);
        return draft;
      };
      const loadMetadata = async () => {
        if (!metadataUrl) {metadataStatus.textContent = "No supported metadata endpoint for this connection. Your title, description and source settings will still be saved."; return;}
        confirm.disabled = true; retryMetadata.disabled = true; metadataStatus.textContent = "Reading provider JSON · at most 2 MiB and 15 seconds; no dataset files…";
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000); activeController = controller;
        try {
          await adapter.assertCollectionContext?.(context);
          const response = cachedMetadata?.url === metadataUrl ? cachedMetadata.response
            : await readProviderJson(metadataUrl, {fetchImplementation, signal: controller.signal});
          await adapter.assertCollectionContext?.(context);
          if (disposed || !metadataPanel.isConnected || controller.signal.aborted) return;
          cachedMetadata = {url: metadataUrl, response}; metadataResponse = response;
          sourceDocument = {id: `urn:source:${crypto.randomUUID()}`, sourceUrl: metadataUrl, retrievedAt: response.retrievedAt,
            mediaType: response.contentType, content: response.text};
          normalized.value = JSON.stringify(response.data, null, 2); retainMetadata.disabled = !canSaveMetadata; retainMetadata.checked = canSaveMetadata;
          const original = element("details", ""); original.append(element("summary", "Original source JSON"), element("pre", response.text));
          metadataControls.replaceChildren(label("Save reviewed provider metadata", retainMetadata), original, label("Normalized provider metadata (editable)", normalized));
          retryMetadata.hidden = true;
          try {providerDraft(emptyKnowledge());
            metadataStatus.textContent = canSaveMetadata ? "Provider JSON received. Review its original text and editable metadata before registering. Public availability is not a license; data files and backups have not been checked."
              : "Provider JSON received for review. This connection cannot save metadata; its known reference can still be registered.";
          } catch (error) {retainMetadata.checked = false; metadataStatus.textContent = `${error.message} The full response remains visible. Register the known reference without it, or reduce the normalized draft and select Save reviewed provider metadata.`;}
        } catch (error) {
          if (disposed || !metadataPanel.isConnected) return;
          metadataStatus.textContent = /context_changed|scope_changed/.test(error.code ?? "") ? "Your sign-in or account changed. Reopen Catalog before continuing."
            : "Provider metadata is unavailable or browser access is blocked. Register the known reference now, or try metadata again. Metadata remains unknown.";
          retryMetadata.hidden = false;
        } finally {clearTimeout(timeout); activeController = null; if (!disposed) {confirm.disabled = false; retryMetadata.disabled = false;}}
      };
      result.replaceChildren(element("h3", "Review referenced Layer"), element("p", `${input.name} · ${eligible.find(project => project.id === projectId).name}`),
        element("p", input.source.url), element("p", input.description ?? "No source description supplied."),
        ...(type.value === "imageserver" ? [element("p", selectedRasterIds.length
          ? `Image records: ${selectedRasterIds.join(", ")}. Provider requests use only these records.` : "Image records: provider default.")] : []),
        ...(type.value === "cog" ? [element("p", `WGS84 bounds: ${selectedBounds.join(", ")} · display bands: ${selectedBands.join(", ")} · ${sizeBytes === null ? "file size unknown" : `${sizeBytes.toLocaleString()} bytes`}. Availability and cloud-optimized layout unverified.`)] : []),
        ...(referenceInput.backup ? [element("p", `Backup reference: ${referenceInput.backup.uri}${referenceInput.backup.objectVersion ? ` · object version ${referenceInput.backup.objectVersion}` : ""}. Access and equivalence unverified.`)] : []),
        ...(referenceInput.edition ? [element("p", `Source edition: ${referenceInput.edition.label}${referenceInput.edition.note ? ` · ${referenceInput.edition.note}` : ""}`)] : []),
        element("p", "Provider reference · internal access · no Project creation or provider copy"), metadataPanel, confirm);
      retryMetadata.addEventListener("click", async () => {if (busy || disposed) return; busy = true; review.disabled = true; try {await loadMetadata();} finally {busy = false; review.disabled = false;}});
      await loadMetadata();
      if (disposed || !root.isConnected || !confirm.isConnected) return;
      confirm.addEventListener("click", async () => {
        if (busy || disposed || !root.isConnected || !confirm.isConnected) return;
        busy = true; confirm.disabled = true; review.disabled = true;
        status.textContent = "Registering the reviewed Catalog reference…";
        let committedSource = null;
        let sourceWriteStarted = false;
        const saveReviewedMetadata = async source => {
          const knowledge = await adapter.getDatasetKnowledge(source.datasetId, {context});
          await adapter.assertCollectionContext?.(context);
          if (disposed || !root.isConnected) return;
          if (!knowledge.canEdit) throw Error("Layer metadata edit access is unavailable.");
          const document = providerDraft(applyReferences(knowledge.document, referenceInput));
          const changed = canonicalJson(document) !== canonicalJson(knowledge.document);
          if (changed) await adapter.saveDatasetKnowledge(source.datasetId, {expectedVersion: knowledge.version, document, context});
          await adapter.assertCollectionContext?.(context);
          return changed;
        };
        try {
          await adapter.assertCollectionContext?.(context);
          providerDraft(applyReferences(emptyKnowledge(), referenceInput));
          const existing = typeof adapter.listSources === "function" ? await adapter.listSources(projectId, {limit: 100, offset: 0}) : [];
          await adapter.assertCollectionContext?.(context);
          if (existing.length >= 100) throw Error("Catalog inventory is truncated; select the existing Layer through Catalog before registering.");
          const matches = existing.filter(source => source.status === "active" && source.sourceType === input.source.type && source.sourceUrl === input.source.url);
          if (matches.length > 1) throw Error("Several Catalog references match; inspect the existing Layers before registering.");
          const expectedConfiguration = input.source.type === "cog"
            ? {serviceKind: "cog", bands: input.source.bands, bounds: input.source.bounds, sizeBytes: input.source.sizeBytes,
              attribution: input.source.attribution, license: input.source.license, referenceMetadata: input.source.referenceMetadata}
            : {minZoom: input.source.minZoom, maxZoom: input.source.maxZoom,
            tileSize: input.source.tileSize, attribution: input.source.attribution,
            ...(input.source.type === "xyz" ? {scheme: input.source.scheme}
              : {serviceKind: "imageserver", imageFormat: input.source.imageFormat,
                interpolation: input.source.interpolation, bandIds: input.source.bandIds,
                ...(input.source.rasterIds ? {rasterIds: input.source.rasterIds} : {})})};
          if (matches[0] && (matches[0].accessMode !== "direct_browser" || matches[0].credentialMode !== "none"
            || canonicalJson(matches[0].configuration) !== canonicalJson(expectedConfiguration))) {
            throw Object.assign(Error(input.source.type === "cog"
              ? "Existing Layer has different raster bounds, bands or source settings. Inspect it in Catalog before reusing or changing it."
              : "Existing Layer has different image records or display settings. Inspect it in Catalog before reusing or changing it."), {code: "catalog_source_settings_conflict"});
          }
          sourceWriteStarted = !matches[0];
          const source = matches[0] ?? await adapter.createSource(projectId, input, {context});
          committedSource = source;
          await adapter.assertCollectionContext?.(context);
          if (disposed || !root.isConnected) return;
          root.dataset.registered = source.datasetId;
          const open = element("a", "Inspect Layer and open map"); open.href = layerHref(source.datasetId, {adapterKind: adapter.kind});
          result.replaceChildren(open, metadataPanel); status.textContent = matches.length
            ? "Existing Catalog Layer found. Its identity, terms and configuration are preserved. Open it to inspect or add it to a Project."
            : "Layer registered in Catalog. Its provider data was not copied. Open it to inspect or add it to a Project.";
          if (hasReferences || retainMetadata.checked) {
            status.textContent = "Layer is in Catalog. Saving the reviewed metadata…";
            await saveReviewedMetadata(source);
            if (disposed || !root.isConnected) return;
            status.textContent = "Layer and reviewed references saved. Provider source text and normalized metadata are separate; backup access and equivalence remain unverified.";
            result.replaceChildren(open);
          }
          onRegistered(source);
        } catch (error) {
          if (disposed || !root.isConnected) return;
          if (committedSource) {
            root.dataset.registered = committedSource.datasetId;
            if (!result.querySelector("a")) {
              const open = element("a", "Inspect saved Layer"); open.href = layerHref(committedSource.datasetId, {adapterKind: adapter.kind}); result.prepend(open);
            }
            status.textContent = /context_changed|scope_changed/.test(error.code ?? "")
              ? "The Layer is in the reviewed workspace. Your sign-in or account changed; reopen that account to inspect it. Metadata saving was not confirmed."
              : "The Layer is in Catalog, but metadata saving was not confirmed. Your reviewed draft is retained; do not register another Layer.";
            if (!/context_changed|scope_changed/.test(error.code ?? "")) {
              const retrySave = element("button", "Retry reviewed metadata save"); retrySave.type = "button";
              retrySave.addEventListener("click", async () => {
                if (disposed || retrySave.disabled) return; retrySave.disabled = true;
                try {await adapter.assertCollectionContext?.(context); const changed = await saveReviewedMetadata(committedSource);
                  if (!disposed) {status.textContent = changed ? "Reviewed metadata saved on the existing Layer. Its source identity and access are unchanged."
                    : "Existing Layer checked. The reviewed metadata is already present, or no additional changes were selected."; result.replaceChildren(result.querySelector("a"));}
                } catch {if (!disposed) status.textContent = "Metadata saving remains unconfirmed. Your draft and saved Layer are retained; inspect the current metadata before continuing.";}
              }, {once: true});
              result.append(retrySave);
            }
            onRegistered(committedSource);
            return;
          }
          status.textContent = /context_changed|scope_changed/.test(error.code ?? "")
            ? "Your sign-in or account changed. Reopen Catalog before continuing."
            : error.code === "catalog_source_settings_conflict" ? error.message
            : !sourceWriteStarted ? error.message
            : "Registration could not be confirmed. Search Catalog before retrying; the reference may already have been saved.";
          if (!sourceWriteStarted) {busy = false; confirm.disabled = false; review.disabled = false;}
          // An uncertain committed request must be reconciled before another write.
        }
      });
    } catch (error) { status.textContent = error.message; }
    finally {if (!disposed) {busy = false; review.disabled = false;}}
  });
  return root;
}

function applyReferences(document, input) {
  let draft = document;
  if (input.backup && !draft.metadata.curated.some(item => item.value?.role === "backup" && item.value.uri === input.backup.uri
    && (item.value.objectVersion ?? "") === input.backup.objectVersion)) draft = appendBackupReference(draft, input.backup);
  if (input.edition && !draft.metadata.curated.some(item => item.value?.role === "source_edition" && item.value.label === input.edition.label
    && item.value.sourceUri === input.edition.sourceUri && (item.value.note ?? "") === input.edition.note)) draft = appendSourceEdition(draft, input.edition);
  return draft;
}

function emptyKnowledge() {return {schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []};}

function backupCheckControl({adapter, workspace, sourceUrl, onReference}) {
  const root = element("section", ""); root.className = "catalog-backup-check";
  const check = element("button", "Check existing backups"); check.type = "button";
  const manage = element("a", "Manage backup repositories");
  manage.href = directoryHref({view: "sources", adapterKind: adapter.kind});
  manage.target = "_blank"; manage.rel = "noopener";
  manage.title = "Opens Connections in a new tab";
  const status = element("p", "Check Catalog links and your configured repositories before making another copy. This check reads metadata only; it does not download files, capture data or change access.");
  status.setAttribute("role", "status");
  const catalog = document.createElement("div"), repositories = document.createElement("div"), results = document.createElement("div");
  const connection = document.createElement("select"), prefix = document.createElement("input");
  prefix.maxLength = 1024; prefix.placeholder = "For example: nepal/icimod/";
  const browse = element("button", "Check selected folder"); browse.type = "button";
  repositories.append(label("Backup repository", connection), label("Backup folder within configured prefix", prefix), browse,
    element("p", "Choose one verified repository and a specific folder. Each check lists at most 50 entries, without recursion. File names and modification times do not establish an equivalent edition or redistribution rights."));
  repositories.hidden = true;
  root.append(check, manage, status, catalog, repositories, results);
  let disposed = false, generation = 0, context = null, profiles = [], checkedScope = null;
  const scope = () => `${workspace.value}\n${sourceUrl()}`;
  const invalidate = () => {generation++; checkedScope = null; check.disabled = false; browse.disabled = false; repositories.hidden = true; catalog.replaceChildren(); results.replaceChildren();};
  const changeFolder = () => {generation++; browse.disabled = false; results.replaceChildren();};
  connection.addEventListener("change", changeFolder); prefix.addEventListener("input", changeFolder);
  workspace.addEventListener("change", invalidate);
  root.dispose = () => {disposed = true; generation++; workspace.removeEventListener("change", invalidate);};
  const current = ticket => !disposed && root.isConnected && ticket === generation && checkedScope === scope();
  const requestOptions = () => ({context, signal: AbortSignal.timeout(15_000)});
  const guard = async ticket => {
    await adapter.assertCollectionContext?.(context);
    if (!current(ticket)) throw Error("The source or workspace changed. Check existing backups again.");
  };
  const fail = (ticket, error) => {
    if (disposed || ticket !== generation) return;
    catalog.replaceChildren(); results.replaceChildren(); repositories.hidden = true;
    status.textContent = /context_changed|scope_changed/.test(error?.code ?? "")
      ? "Your sign-in or account changed. Reopen Catalog before checking backups."
      : error?.message ?? "Backup metadata could not be checked. No absence or equivalence has been established.";
  };
  check.addEventListener("click", async () => {
    const ticket = ++generation; checkedScope = scope(); check.disabled = true;
    repositories.hidden = true; catalog.replaceChildren(); results.replaceChildren();
    status.textContent = "Checking existing Catalog references and configured repository metadata…";
    try {
      context = await captureContext(adapter); await guard(ticket);
      const uri = sourceUrl();
      if (uri) {
        const parsed = new URL(uri);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error("Use an HTTPS source URL without credentials or query parameters for the Catalog comparison.");
      }
      const [sources, connections] = await Promise.all([
        uri && typeof adapter.listSources === "function" ? adapter.listSources(workspace.value, {limit: 100, offset: 0, ...requestOptions()}) : [],
        typeof adapter.listMyDatasetConnections === "function" ? adapter.listMyDatasetConnections(requestOptions()) : []
      ]);
      await guard(ticket);
      const matches = sources.filter(source => source.status === "active" && source.sourceUrl === uri);
      catalog.append(element("h4", "Catalog backup links"), element("p", uri
        ? typeof adapter.listSources !== "function" ? "Catalog source lookup is unavailable; existing backup links have not been checked."
          : `Checked ${sources.length} source references in the selected workspace${sources.length === 100 ? "; this page is incomplete" : ""}. Same-source links are candidates; image records and editions can differ.`
        : "Enter the source URL to compare existing Catalog links. Configured repositories can still be checked below."));
      const reads = await Promise.allSettled(matches.slice(0, 3).map(async source => {
        const [knowledge, archives] = await Promise.allSettled([
          typeof adapter.getDatasetKnowledge === "function" ? adapter.getDatasetKnowledge(source.datasetId, requestOptions()) : null,
          typeof adapter.listLayerArchives === "function" ? adapter.listLayerArchives(workspace.value, source.datasetId, requestOptions()) : null
        ]);
        return {source, knowledge: knowledge.status === "fulfilled" ? knowledge.value : null,
          archives: archives.status === "fulfilled" ? archives.value : null,
          incomplete: knowledge.status === "rejected" || archives.status === "rejected"};
      }));
      await guard(ticket);
      for (const read of reads) {
        if (read.status !== "fulfilled") {catalog.append(element("p", "One Catalog Layer's backup metadata is unavailable; it has not been checked.")); continue;}
        const {source, knowledge, archives, incomplete} = read.value;
        const entry = element("article", ""), inspect = element("a", "Inspect existing Layer");
        inspect.href = layerHref(source.datasetId, {adapterKind: adapter.kind}); entry.append(inspect);
        if (incomplete) entry.append(element("p", "Some backup metadata for this Layer is unavailable and remains unchecked."));
        const claims = knowledge?.document?.metadata?.curated ?? [];
        for (const claim of claims) {
          if (claim.value?.role === "backup") entry.append(element("p", `Backup: ${claim.value.uri} · object version: ${claim.value.objectVersion ?? "unrecorded"} · backup edition: ${claim.value.edition ?? "unrecorded"}. Access and equivalence: ${claim.value.access ?? "unverified"}, ${claim.value.equivalence ?? "unknown"}. Size and rights: unknown.`));
          if (claim.value?.role === "source_edition") entry.append(element("p", `Source edition: ${claim.value.label}. Identity: ${claim.value.identity ?? "unverified"}. Snapshot: ${claim.value.snapshotAt ?? "unrecorded"}.`));
        }
        if (archives && matchesReviewedDisplay(archives, {datasetId: source.datasetId, sourceVersion: source.versionNumber}) && Array.isArray(archives.archives) && archives.archives.length <= 20) {
          for (const archive of archives.archives) entry.append(element("p", `Reviewed map copy: ${archive.title} · capture: ${archive.captured_at ?? "unrecorded"} · ${backupSize(archive.download_bytes)} · license: ${typeof archive.rights?.license === "string" ? archive.rights.license : "unknown"}. A map display is separate from an original backup.`));
        } else if (archives) entry.append(element("p", "Archive metadata does not match the current source revision; inspect the Layer before using a copy."));
        catalog.append(entry);
      }
      if (uri && typeof adapter.listSources === "function" && !matches.length) catalog.append(element("p", "No same-source Layer was found on the checked Catalog page. Other repositories have not been searched."));
      if (matches.length > 3) catalog.append(element("p", "Only the first 3 same-source Layers were inspected. Additional matching Layers remain unchecked."));
      profiles = connections.filter(profile => profile.provider === "s3" && profile.ownedByCaller).slice(0, 50);
      connection.replaceChildren(option("", "Choose a configured repository"));
      for (const profile of profiles) {
        const item = option(profile.id, `${profile.displayName} · s3://${profile.bucketName}/${profile.objectPrefix} · ${profile.status}`);
        item.disabled = profile.status !== "verified" || !profile.repositoryBrowseAvailable;
        connection.append(item);
      }
      repositories.hidden = false;
      status.textContent = typeof adapter.listMyDatasetConnections !== "function"
        ? "Configured repository lookup is unavailable. Review repository access in Connections; no file absence has been established."
        : profiles.length
        ? "Catalog metadata checked within the stated limits. Choose a verified repository and folder to check its existing files. Repository metadata requests may incur request charges."
        : "Catalog metadata checked within the stated limits. No caller-owned S3 repository is configured. Add or verify a repository in Connections; no bucket scan or file transfer has run.";
      if (connections.length > 50) status.textContent += " Only the first 50 configured repositories are shown.";
    } catch (error) {fail(ticket, error);}
    finally {if (!disposed && ticket === generation) check.disabled = false;}
  });
  const assertProfile = async (profile, ticket) => {
    await guard(ticket);
    if (typeof adapter.listMyDatasetConnections !== "function") throw Error("Current repository target review is unavailable. Use Connections to inspect this repository.");
    const profiles = await adapter.listMyDatasetConnections(requestOptions()); await guard(ticket);
    const matches = profiles.filter(item => item.id === profile.id), fresh = matches[0];
    if (matches.length !== 1 || !fresh.ownedByCaller || fresh.status !== "verified" || !fresh.repositoryBrowseAvailable
      || fresh.bucketName !== profile.bucketName || fresh.objectPrefix !== profile.objectPrefix
      || fresh.targetRevision !== profile.targetRevision || fresh.credentialRevision !== profile.credentialRevision) throw Error("The repository target or verification changed. Check existing backups again.");
  };
  browse.addEventListener("click", async () => {
    const ticket = generation, profile = profiles.find(item => item.id === connection.value);
    if (!profile || disposed || browse.disabled) return;
    const requested = prefix.value.trim();
    if ((!profile.objectPrefix && !requested) || (requested && (!requested.endsWith("/") || requested.startsWith("/") || requested.includes("\\") || /[\u0000-\u001f\u007f]/.test(requested) || requested.split("/").some(part => part === "." || part === "..")))) {
      status.textContent = "Enter a specific relative folder ending with /. Whole-bucket and traversal searches are unavailable."; return;
    }
    browse.disabled = true; results.replaceChildren();
    try {
      await assertProfile(profile, ticket);
      const page = await adapter.browseMyDatasetConnectionRepository(profile.id, {prefix: requested, limit: 50, ...requestOptions()});
      await assertProfile(profile, ticket);
      if (page.connectionId !== profile.id || page.prefix !== requested || !Array.isArray(page.entries) || page.entries.length > 50) throw Error("Repository metadata did not match the selected folder.");
      results.append(element("h4", `Existing files in ${profile.displayName}`));
      for (const item of page.entries) {
        if (item.kind !== "object") continue;
        if (typeof item.relativePath !== "string" || !item.relativePath.startsWith(requested)
          || item.relativePath.startsWith("/") || item.relativePath.endsWith("/") || item.relativePath.includes("\\")
          || /[\u0000-\u001f\u007f]/.test(item.relativePath) || item.relativePath.split("/").some(part => part === "." || part === "..")) throw Error("Repository object metadata escaped the checked folder.");
        const entry = element("article", ""), use = element("button", "Use backup reference in draft"); use.type = "button";
        entry.append(element("p", `${item.relativePath} · ${backupSize(item.sizeBytes)} · modified: ${item.lastModified ?? "unrecorded"} · object version: ${item.versionId ?? "unrecorded"}. Edition, equivalence and rights: unknown.`), use);
        use.addEventListener("click", async () => {
          use.disabled = true;
          try {
            await assertProfile(profile, ticket);
            const uri = `s3://${profile.bucketName}/${(profile.objectPrefix + item.relativePath).split("/").map(encodeURIComponent).join("/")}`;
            appendBackupReference({schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []}, {uri, objectVersion: item.versionId ?? ""});
            onReference({uri, version: item.versionId});
            status.textContent = "Backup pointer staged for review. The source edition is unchanged; equivalence, access and rights remain unverified. Nothing has been saved, downloaded or copied.";
          } catch (error) {fail(ticket, error);}
          finally {if (current(ticket)) use.disabled = false;}
        });
        results.append(entry);
      }
      status.textContent = `${page.entries.length} entries checked in this folder${page.truncated ? "; additional entries remain unchecked" : ""}. Subfolders were not searched. Unknown sizes must be established before capture; transfers over 1 GB require separate cost approval.`;
    } catch (error) {fail(ticket, error);}
    finally {if (!disposed && ticket === generation) browse.disabled = false;}
  });
  return root;
}

function backupSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString()} bytes${value > 1_000_000_000 ? "; over 1 GB: capture requires cost approval" : ""}` : "size unknown: establish transfer size before capture";
}

async function captureContext(adapter) {
  if (typeof adapter.tokenProvider !== "function" && typeof adapter.organizationProvider !== "function") return null;
  const {tokenProvider, organizationProvider, baseUrl} = adapter;
  if (typeof tokenProvider !== "function" || typeof organizationProvider !== "function") throw Error("Sign-in scope unavailable.");
  const token = await tokenProvider.call(adapter), organization = String(await organizationProvider.call(adapter)).toLowerCase();
  const context = Object.freeze({tokenProvider, organizationProvider, baseUrl, token, organization});
  await adapter.assertCollectionContext(context); return context;
}
function element(tag, value) {const node = document.createElement(tag); node.textContent = value; return node;}
function label(value, input) {const node = element("label", value); input.setAttribute("aria-label", value); node.append(input); return node;}
function option(value, title) {const node = element("option", title); node.value = value; return node;}
