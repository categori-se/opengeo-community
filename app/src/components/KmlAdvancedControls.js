import {addKmlPlace, normalizePlacesDocument, updateKmlPlace} from "../lib/kmlPlaces.js";
import {addKmlModelToCesium, createBoxKmlModel, normalizeKmlModel} from "../lib/kmlModel.js";
import {createCesiumLoader} from "../lib/cesiumLoader.js";
import {CESIUM_RUNTIME} from "../lib/cesiumRuntime.js";

/** Optional model tools share the selected Layer's existing Places document. */
export function KmlAdvancedControls({getDocument, getSelectedId, replaceDocument,
  canEdit = () => false, assertScope = () => {}, onOpenPhoto, onStatus = () => {},
  document: doc = globalThis.document, loadEngine = null} = {}) {
  const element = doc.createElement("details");element.className = "gis-kml-advanced-controls";
  element.dataset.kmlAdvanced = "true";
  const text = (tag, value) => {const node = doc.createElement(tag);node.textContent = value;return node;};
  element.append(text("summary", "Models and photo overlays"));
  const note = text("p", "Create a portable box Model or edit a selected Model. Original COLLADA is retained. The map shows its anchor; 3D inspection opens only when requested.");
  const form = doc.createElement("form"), status = text("p", "");status.setAttribute("role", "status");
  const fields = new Map();
  const field = (name, value, {min, max, type = "number"} = {}) => {
    const wrapper = text("label", name), input = doc.createElement("input");input.type = type;
    input.setAttribute("aria-label", name);input.value = String(value);input.required = true;
    if (type === "number") {input.step = "any";if (min !== undefined) input.min = String(min);if (max !== undefined) input.max = String(max);}
    else input.maxLength = 256;
    wrapper.append(input);form.append(wrapper);fields.set(name, input);return input;
  };
  field("Model name", "New Model", {type: "text"});
  field("Model longitude", 0, {min: -180, max: 180});field("Model latitude", 0, {min: -90, max: 90});
  field("Model altitude metres", 0, {min: -10_000_000, max: 10_000_000});
  for (const key of ["heading", "tilt", "roll"]) field(`Model ${key} degrees`, 0, {min: key === "heading" ? -360 : -180, max: key === "heading" ? 360 : 180});
  for (const axis of ["x", "y", "z"]) field(`Model scale ${axis}`, 10, {min: 0.000001, max: 1_000_000});
  const altitudeLabel = text("label", "Model altitude mode"), altitude = doc.createElement("select");altitude.setAttribute("aria-label", "Model altitude mode");
  for (const name of ["absolute", "relativeToGround", "clampToGround"]) {const option = text("option", name);option.value = name;altitude.append(option);}
  altitudeLabel.append(altitude);form.append(altitudeLabel);
  const create = text("button", "Create box Model"), apply = text("button", "Apply Model changes");create.type = apply.type = "button";
  const preview = text("button", "Inspect selected Model in 3D"), photo = text("button", "Open selected PhotoOverlay");preview.type = photo.type = "button";
  form.append(create, apply);form.addEventListener("submit", event => event.preventDefault());
  element.append(note, form, preview, photo, status);
  let disposed = false, selectedSignature = null, previewState = null, busy = false;
  const loader = createCesiumLoader({document: doc, window: doc.defaultView});
  const selected = (document = getDocument()) => {
    const pending = [...(document?.children ?? [])], id = getSelectedId();
    while (pending.length) {const place = pending.shift();if (place.id === id) return place;if (place.children) pending.push(...place.children);}
    return null;
  };
  const announce = message => {if (disposed) return;status.textContent = message;onStatus(message);};
  const scope = async (document, id) => {
    await assertScope();
    if (disposed || getDocument() !== document || getSelectedId() !== id) throw Error("The selected Layer or Place changed. Review the current item before continuing.");
  };
  const number = name => {
    const value = fields.get(name).value.trim();
    if (!value || !Number.isFinite(Number(value))) throw Error(`Enter a finite ${name.toLowerCase()}.`);
    return Number(value);
  };
  const draftModel = (link = {href: "models/new-model.dae"}) => normalizeKmlModel({
    location: {longitude: number("Model longitude"), latitude: number("Model latitude"), altitude: number("Model altitude metres")},
    orientation: Object.fromEntries(["heading", "tilt", "roll"].map(key => [key, number(`Model ${key} degrees`)])),
    scale: Object.fromEntries(["x", "y", "z"].map(key => [key, number(`Model scale ${key}`)])), altitudeMode: altitude.value, link});
  const update = () => {
    if (disposed) return;
    let place, document;
    try {document = getDocument();place = selected(document);} catch {place = null;}
    if (previewState && (previewState.document !== document || previewState.id !== place?.id)) closePreview();
    const signature = JSON.stringify([place?.id, place?.name, place?.model]);
    if (signature !== selectedSignature) {
      selectedSignature = signature;
      const model = place?.model;
      if (model) {
        fields.get("Model name").value = place.name;
        for (const [name, value] of [["Model longitude", model.location.longitude], ["Model latitude", model.location.latitude], ["Model altitude metres", model.location.altitude]]) fields.get(name).value = value;
        for (const key of ["heading", "tilt", "roll"]) fields.get(`Model ${key} degrees`).value = model.orientation[key];
        for (const key of ["x", "y", "z"]) fields.get(`Model scale ${key}`).value = model.scale[key];
        altitude.value = model.altitudeMode;
      }
    }
    const editable = !busy && canEdit();
    for (const input of [...fields.values(), altitude]) input.disabled = !editable;
    create.disabled = !editable;apply.disabled = !editable || !place?.model;
    preview.disabled = busy || !place?.model;
    photo.disabled = busy || typeof onOpenPhoto !== "function" || place?.kind !== "photo-overlay" || !["sphere", "cylinder"].includes(place.shape);
  };
  const commit = async make => {
    if (disposed || busy || !canEdit()) return;
    const document = getDocument(), id = getSelectedId();busy = true;update();
    try {
      const proposal = make(document);await scope(document, id);
      if (!canEdit()) throw Error("Editing access changed. The Model is unchanged.");
      replaceDocument(proposal.document, {selectId: proposal.id, message: proposal.message});announce(proposal.message);
    } catch (error) {announce(`Model could not be changed: ${error.message}`);}
    finally {busy = false;update();}
  };
  create.addEventListener("click", () => commit(document => {
    const name = fields.get("Model name").value.trim();if (!name) throw Error("Enter a Model name.");
    const model = draftModel(), id = `model-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const created = createBoxKmlModel({id, name, ...model});
    const source = normalizePlacesDocument({...document, resources: [...document.resources, created.resource]});
    const target = selected(document), parentId = target?.kind === "folder" ? target.id : document.id;
    return {document: addKmlPlace(source, parentId, created.place), id,
      message: "Box Model created with original local COLLADA. Save the Project to retain it."};
  }));
  apply.addEventListener("click", () => commit(document => {
    const place = selected(document);if (!place?.model) throw Error("Select a Model first.");
    const model = draftModel(place.model.link), name = fields.get("Model name").value.trim();if (!name) throw Error("Enter a Model name.");
    return {document: updateKmlPlace(document, place.id, {name, model, altitudeMode: model.altitudeMode,
      geometry: {type: "Point", coordinates: [model.location.longitude, model.location.latitude, model.location.altitude]}}), id: place.id,
    message: "Model location, orientation, scale and altitude updated. Original mesh bytes are unchanged; Save the Project to retain edits."};
  }));
  const closePreview = () => {
    const current = previewState;if (!current) return;previewState = null;current.controller.abort();
    current.model?.dispose();if (current.viewer && !current.viewer.isDestroyed()) current.viewer.destroy();current.dialog.remove();
  };
  const engine = loadEngine ?? (async () => {
    await loader.load();
    const index = CESIUM_RUNTIME.assets.find(asset => asset.name === "index.js");
    return import(new URL(`${CESIUM_RUNTIME.basePath}index.js?sha256=${index.sha256}`, doc.baseURI).href);
  });
  preview.addEventListener("click", async () => {
    if (disposed || busy || !selected()?.model) return;
    closePreview();const document = getDocument(), id = getSelectedId(), place = structuredClone(selected(document));
    const dialog = doc.createElement("dialog");dialog.className = "gis-kml-model-preview";dialog.setAttribute("aria-label", "Model 3D inspection");
    const heading = text("h2", place.name), help = text("p", "Drag to orbit the actual model. The original COLLADA is retained; this preview uses neutral material and flat surface normals.");
    const surface = doc.createElement("div");surface.style.cssText = "width:min(70vw,720px);height:min(60vh,480px);min-height:240px";
    const message = text("p", "Loading local 3D runtime…");message.setAttribute("role", "status");
    const close = text("button", "Close Model inspection");close.type = "button";close.onclick = closePreview;
    dialog.append(heading, help, surface, message, close);dialog.addEventListener("cancel", event => {event.preventDefault();closePreview();});
    doc.body.append(dialog);dialog.showModal();
    const state = previewState = {dialog, controller: new AbortController(), viewer: null, model: null, document, id};
    try {
      await scope(document, id);const C = await engine();state.controller.signal.throwIfAborted();await scope(document, id);
      if (C.VERSION !== CESIUM_RUNTIME.version) throw Error("The reviewed 3D runtime version is unavailable.");
      state.viewer = new C.Viewer(surface, {baseLayer: false, baseLayerPicker: false, terrainProvider: new C.EllipsoidTerrainProvider(),
        animation: false, timeline: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
        fullscreenButton: false, infoBox: false, selectionIndicator: false, skyBox: false, skyAtmosphere: false,
        scene3DOnly: true, shouldAnimate: false, requestRenderMode: true, maximumRenderTimeChange: Infinity, targetFrameRate: 30,
        contextOptions: {webgl: {preserveDrawingBuffer: true}}});
      state.viewer.scene.globe.preloadAncestors = false;state.viewer.scene.globe.preloadSiblings = false;
      state.model = await addKmlModelToCesium(C, state.viewer, {document, place, signal: state.controller.signal, DOMParser: doc.defaultView.DOMParser});
      const primitive = state.model.primitive;
      if (!primitive.ready) await new Promise((resolve, reject) => {
        let remove;const done = error => {clearTimeout(timer);remove?.();state.controller.signal.removeEventListener("abort", abort);error ? reject(error) : resolve();};
        const abort = () => done(Error("Model inspection closed."));const timer = setTimeout(() => done(Error("The local Model did not become ready within fifteen seconds.")), 15000);
        remove = primitive.readyEvent.addEventListener(() => done());state.controller.signal.addEventListener("abort", abort, {once: true});
        state.viewer.scene.requestRender();
      });
      state.controller.signal.throwIfAborted();await scope(document, id);
      state.viewer.camera.viewBoundingSphere(primitive.boundingSphere, new C.HeadingPitchRange(0.5, -0.4, Math.max(2, primitive.boundingSphere.radius * 3)));
      state.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);state.viewer.scene.requestRender();
      const details = doc.createElement("details");details.append(text("summary", "Model conversion report"), text("pre", JSON.stringify(state.model.report, null, 2)));dialog.insertBefore(details, close);
      message.textContent = `Model ready · ${state.model.report.triangles} triangles · exact source ${state.model.report.originalSha256}.`;
    } catch (error) {
      if (!state.controller.signal.aborted && previewState === state) {message.textContent = `3D Model unavailable: ${error.message}`;
        state.model?.dispose();state.model = null;if (state.viewer && !state.viewer.isDestroyed()) state.viewer.destroy();state.viewer = null;}
    }
  });
  photo.addEventListener("click", async () => {
    if (disposed || photo.disabled) return;
    const document = getDocument(), id = getSelectedId(), place = selected(document);
    if (!place) return;
    try {await scope(document, id);await onOpenPhoto(place, document);} catch (error) {announce(`PhotoOverlay could not open: ${error.message}`);}
  });
  update();
  return {element, update, dispose() {if (disposed) return;disposed = true;closePreview();element.remove();}};
}
