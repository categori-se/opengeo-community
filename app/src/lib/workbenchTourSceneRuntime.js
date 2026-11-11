import {captureMapView} from "./globeView.js";
import {historicalImageryForSave} from "./historicalImagery.js";
import {normalizePanoramaCatalog, normalizePanoramaState, panoramaImageBytes, PANORAMA_SCHEMA} from "./panorama.js";
import {placesToGeojson, updateKmlPlace} from "./kmlPlaces.js";
import {createTourScenePlayer, normalizeTourScene, tourMediaSha256} from "./tourMedia.js";

const documentHashes = new WeakMap(), assetHashes = new WeakMap();
const fail = code => Object.assign(new Error(code), {code});
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const hash = value => tourMediaSha256(new TextEncoder().encode(json(value)));
function documentHash(document) {
  const serialized = json(document), prior = documentHashes.get(document);
  if (prior?.serialized === serialized) return prior.sha256;
  const sha256 = tourMediaSha256(new TextEncoder().encode(serialized));documentHashes.set(document, {serialized, sha256});return sha256;
}
function scope(context) {
  if (!context?.state || context.disposed || context.queryLocationScopeInvalid || context.shell?.isConnected === false) throw fail("tour_project_scope_changed");
}
function findPlace(document, id) {
  if (document?.id === id) return document;
  for (const child of document?.children ?? []) {const found = findPlace(child, id);if (found) return found;}
  return null;
}
function placeMatches(context, id, layerId = null) {
  return context.layers.filter(layer => layer.sourceType === "kml-places" && (!layerId || layer.layerId === layerId)
    && layer.kmlDocument && findPlace(layer.kmlDocument, id));
}
function verifiedPanorama(context, binding, {movie = false} = {}) {
  if (binding == null) return null;
  const rawCatalog = context.state.panoramaCatalog ?? context.project?.extensions?.panoramas;
  const catalog = normalizePanoramaCatalog(rawCatalog), view = normalizePanoramaState(binding, catalog), scene = catalog.scenes.find(item => item.id === view.sceneId);
  const raw = rawCatalog?.scenes?.find(item => item.id === scene.id)?.asset ?? scene.asset;
  const identity = `${raw.sha256}:${raw.dataUrl}`;let actual = assetHashes.get(raw);
  if (actual?.identity !== identity) {actual = {identity, sha256: tourMediaSha256(panoramaImageBytes(scene.asset))};assetHashes.set(raw, actual);}
  if (actual.sha256 !== scene.asset.sha256 || binding.assetSha256 !== scene.asset.sha256) throw fail("tour_panorama_asset_changed");
  const {dataUrl, ...asset} = scene.asset, sceneSha256 = hash({...scene, asset});
  if (binding.schemaVersion !== PANORAMA_SCHEMA || binding.sceneSha256 !== sceneSha256) throw fail("tour_panorama_binding_changed");
  if (movie && scene.rights.exportAllowed !== true) throw fail("panorama_export_review_required");
  return {view, scene};
}
function panoramaBinding(context) {
  const view = context.state.panoramaView;if (!view) return null;
  const catalog = normalizePanoramaCatalog(context.state.panoramaCatalog), normalized = normalizePanoramaState(view, catalog), scene = catalog.scenes.find(item => item.id === normalized.sceneId);
  const {dataUrl, ...asset} = scene.asset;
  const binding = {schemaVersion: PANORAMA_SCHEMA, ...normalized, assetSha256: scene.asset.sha256, sceneSha256: hash({...scene, asset})};
  verifiedPanorama(context, binding);return binding;
}
function normalizedSunlight(context, value) {
  return historicalImageryForSave({...context.state.historicalImagery, sunlight: value}).sunlight;
}

export function captureWorkbenchTourScene(context) {
  scope(context);let place = null;
  if (context.state.selectedKmlPlaceId) {
    let matches = placeMatches(context, context.state.selectedKmlPlaceId, context.state.activeLayerId);
    if (!matches.length) matches = placeMatches(context, context.state.selectedKmlPlaceId);
    if (matches.length !== 1) throw fail("tour_place_binding_unavailable");
    const layer = matches[0];place = {layerId: layer.layerId, placeId: context.state.selectedKmlPlaceId, sourceSha256: documentHash(layer.kmlDocument)};
  }
  const historicalImagery = historicalImageryForSave(context.state.historicalImagery);
  return normalizeTourScene({place, historicalImagery, sunlight: historicalImagery.sunlight, panorama: panoramaBinding(context)});
}

/** Validate every scene binding before any renderer or source callback runs. */
export function validateWorkbenchTourScene(context, value, options = {}) {
  scope(context);const scene = value == null ? null : normalizeTourScene(value);if (!scene) return null;
  if (scene.place) {
    const binding = scene.place, matches = placeMatches(context, binding.placeId, binding.layerId);
    if (matches.length !== 1 || (binding.sourceSha256 ?? binding.documentSha256) !== documentHash(matches[0].kmlDocument)) throw fail("tour_place_binding_changed");
  }
  if (scene.historicalImagery && json(historicalImageryForSave(scene.historicalImagery)) !== json(scene.historicalImagery)) throw fail("tour_historical_source_changed");
  if (scene.sunlight && json(normalizedSunlight(context, scene.sunlight)) !== json(scene.sunlight)) throw fail("tour_sunlight_invalid");
  if (scene.panorama) verifiedPanorama(context, scene.panorama, options);
  for (const update of scene.updates ?? []) {
    const matches = placeMatches(context, update.targetId);
    if (matches.length !== 1) throw fail("tour_update_target_unavailable");
    const place = findPlace(matches[0].kmlDocument, update.targetId);
    const kind = {Placemark: "placemark", Folder: "folder", Document: "document", GroundOverlay: "ground-overlay", ScreenOverlay: "screen-overlay", PhotoOverlay: "photo-overlay", Model: "placemark", NetworkLink: "network-link"}[update.targetType];
    if (kind && place.kind !== kind) throw fail("tour_update_target_type_changed");
    if (place.model || !["placemark", "folder", "document"].includes(place.kind)) throw fail("tour_update_presentation_unsupported");
    // Exercise the canonical property's validation on a copy before any other
    // scene callback runs; empty/oversized names must not fail after mutation.
    const updated = updateKmlPlace(matches[0].kmlDocument, update.targetId, {[update.property]: update.value});
    if (findPlace(updated, update.targetId)[update.property] !== update.value) throw fail("tour_update_value_unrepresentable");
    const handle = context.state.layerHandles?.get(matches[0].layerId), source = context.state.map?.getSource(handle?.sourceId);
    if (!handle || !source?.setData || context.dataByLayerId?.get(matches[0].layerId)?.type !== "FeatureCollection") throw fail("tour_update_source_unavailable");
  }
  return scene;
}
function layerEntries(context, bindings) {
  return (bindings ?? []).map(binding => {
    const matches = context.layers.filter(layer => layer.layerId === binding.layerId), layer = matches[0], handle = context.state.layerHandles?.get(binding.layerId), map = context.state.map;
    if (matches.length !== 1 || layer.datasetId !== binding.datasetId || layer.datasetVersionId !== binding.datasetVersionId || layer.sourceVersion !== binding.sourceVersion
      || !handle?.layerIds?.length || !map?.setLayoutProperty || handle.layerIds.some(id => !map.getLayer(id))) throw fail("tour_layer_binding_changed");
    return {layer, handle, visible: binding.visible};
  });
}

export function createWorkbenchTourSceneRuntime(context, {applyHistory, applyPanorama, applySunlight, onStatus = () => {}} = {}) {
  let disposed = false, movie = null;
  const backups = new Map(), derived = new Map();
  const check = () => {scope(context);if (disposed) throw fail("tour_scene_runtime_disposed");};
  const restoreSources = () => {
    for (const [layerId, backup] of backups) {
      try {
        const layer = context.layers.find(layer => layer.layerId === layerId), currentHandle = context.state.layerHandles?.get(layerId);
        const changed = layer?.kmlDocument && documentHash(layer.kmlDocument) !== backup.documentSha256;
        const currentData = context.dataByLayerId.get(layerId);
        const data = changed ? placesToGeojson(layer.kmlDocument) : currentData === backup.data && backup.hadGeojson
          ? backup.kmlGeojson : currentData ?? backup.data;
        if (backup.handle.kmlGeojson === backup.derivedData) {
          if (changed) backup.handle.kmlGeojson = data;
          else if (backup.hadGeojson) backup.handle.kmlGeojson = backup.kmlGeojson;else delete backup.handle.kmlGeojson;
        }
        if (currentHandle === backup.handle && context.state.map === backup.map) backup.map.getSource(backup.sourceId)?.setData?.(data);
      } catch (error) {onStatus(`Tour source ${layerId} could not restore in the replaced renderer: ${error.message}`);}
    }
    backups.clear();derived.clear();
  };
  const selectPlace = binding => {
    if (!binding) {context.state.selectedKmlPlaceId = null;return;}
    const switching = context.state.activeLayerId !== binding.layerId;
    context.state.activeLayerId = binding.layerId;if (switching) context.render?.();
    context.state.selectedKmlPlaceId = binding.placeId;context.render?.();
  };
  const applyUpdate = update => {
    const layer = placeMatches(context, update.targetId)[0], handle = context.state.layerHandles.get(layer.layerId), map = context.state.map;
    if (!backups.has(layer.layerId)) backups.set(layer.layerId, {map, handle, sourceId: handle.sourceId, hadGeojson: Object.hasOwn(handle, "kmlGeojson"),
      kmlGeojson: handle.kmlGeojson, data: context.dataByLayerId.get(layer.layerId), documentSha256: documentHash(layer.kmlDocument)});
    const document = updateKmlPlace(derived.get(layer.layerId) ?? layer.kmlDocument, update.targetId, {[update.property]: update.value});
    derived.set(layer.layerId, document);const data = placesToGeojson(document), visible = new Map();
    const walk = (place, parent) => {const current = parent && place.visibility !== false;visible.set(place.id, current);for (const child of place.children ?? []) walk(child, current);};
    walk(document, true);for (const feature of data.features) feature.properties.visibility = visible.get(feature.id) !== false;
    backups.get(layer.layerId).derivedData = data;handle.kmlGeojson = data;map.getSource(handle.sourceId).setData(data);
  };
  const callback = (action, name) => async (value, options) => {if (!action) throw fail(`tour_${name}_callback_unavailable`);await action(value, options);check();};
  const validateCallbacks = scene => {
    for (const [field, action] of [["historicalImagery", applyHistory], ["sunlight", applySunlight], ["panorama", applyPanorama]])
      if (scene && Object.hasOwn(scene, field) && typeof action !== "function") throw fail(`tour_${field}_callback_unavailable`);
  };
  const player = createTourScenePlayer({assertScope: check, validateScene: scene => validateWorkbenchTourScene(context, scene),
    applyPlace: selectPlace, applyHistoricalImagery: callback(applyHistory, "history"), applySunlight: callback(applySunlight, "sunlight"),
    applyPanorama: async binding => {const verified = verifiedPanorama(context, binding);if (!applyPanorama) throw fail("tour_panorama_callback_unavailable");await applyPanorama(verified?.view ?? null, verified?.scene ?? null);check();}, applyUpdate});
  const snapshot = () => ({camera: captureMapView(context.state.map), scene: captureWorkbenchTourScene(context), activeLayerId: context.state.activeLayerId,
    selectedKmlPlaceId: context.state.selectedKmlPlaceId, layers: context.layers.map(layer => ({layer, visible: layer.visible,
      handle: context.state.layerHandles?.get(layer.layerId), layout: (context.state.layerHandles?.get(layer.layerId)?.layerIds ?? [])
        .map(id => [id, context.state.map.getLayoutProperty?.(id, "visibility") ?? "visible"])}))});
  return {
    async apply(frame, options) {check();const scene = validateWorkbenchTourScene(context, frame.scene);validateCallbacks(scene);layerEntries(context, frame.layerVisibility);await player.apply(frame, options);check();},
    pause() {player.pause();},
    stop() {player.stop();restoreSources();},
    dispose() {player.dispose();restoreSources();disposed = true;},
    async renderMovieFrame(frame, {canvas, signal} = {}) {
      check();signal?.throwIfAborted();const scene = validateWorkbenchTourScene(context, frame.scene, {movie: true});validateCallbacks(scene);
      if ((!scene || !Object.hasOwn(scene, "panorama")) && context.state.panoramaView) verifiedPanorama(context, panoramaBinding(context), {movie: true});
      layerEntries(context, frame.layerVisibility);
      if (!movie) movie = snapshot();
      await player.apply(frame, {playing: false, signal});check();signal?.throwIfAborted();
      // A history callback may replace a style and its renderer handles. Resolve
      // the same pinned bindings again before touching the newly installed map.
      const entries = layerEntries(context, frame.layerVisibility);
      for (const entry of entries) {entry.layer.visible = entry.visible;entry.handle.layerVisible = entry.visible;
        for (const id of entry.handle.layerIds) context.state.map.setLayoutProperty(id, "visibility", entry.visible ? "visible" : "none");}
      const map = context.state.map;map.jumpTo({...frame.camera, roll: frame.camera.roll ?? 0});
      await waitForTourPaint(map, signal);check();signal?.throwIfAborted();
      let source;
      if (context.state.panoramaView) {
        verifiedPanorama(context, panoramaBinding(context), {movie: true});
        if (!context.panoramaViewer) throw fail("tour_panorama_viewer_unavailable");
        if (await boundedViewer(context.panoramaViewer.opened, signal) === false) throw fail("tour_panorama_viewer_failed");
        check();signal?.throwIfAborted();source = context.panoramaViewer.capture();
      } else source = map.getCanvas();
      const output = canvas?.getContext?.("2d");if (!source || !output) throw fail("tour_movie_canvas_unavailable");
      const width = source.width, height = source.height;if (!(width > 0 && height > 0)) throw fail("tour_movie_canvas_unavailable");
      const ratio = Math.min(canvas.width / width, canvas.height / height);output.fillStyle = "#000";output.fillRect(0, 0, canvas.width, canvas.height);
      output.drawImage(source, (canvas.width - width * ratio) / 2, (canvas.height - height * ratio) / 2, width * ratio, height * ratio);
    },
    async restoreMovie() {
      const original = movie;movie = null;player.stop();restoreSources();if (!original || disposed || context.disposed || context.queryLocationScopeInvalid) return;
      check();
      if (applyHistory) await applyHistory(original.scene.historicalImagery);check();
      if (applySunlight) await applySunlight(original.scene.sunlight);check();
      if (applyPanorama) {const panorama = verifiedPanorama(context, original.scene.panorama);await applyPanorama(panorama?.view ?? null, panorama?.scene ?? null);check();}
      for (const entry of original.layers) if (context.layers.includes(entry.layer)) {
        entry.layer.visible = entry.visible;
        const handle = context.state.layerHandles?.get(entry.layer.layerId);if (handle) handle.layerVisible = entry.visible;
        for (const [id, visible] of entry.layout) if (context.state.map.getLayer(id)) context.state.map.setLayoutProperty(id, "visibility", visible);
      }
      context.state.map.jumpTo({...original.camera, roll: original.camera.roll ?? 0});
      context.state.activeLayerId = original.activeLayerId;context.render?.();context.state.selectedKmlPlaceId = original.selectedKmlPlaceId;context.render?.();
    }
  };
}

function boundedViewer(opened, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {if (done) return;done = true;clearTimeout(timer);signal?.removeEventListener("abort", abort);if (error) reject(error);else resolve(value);};
    const abort = () => finish(signal.reason ?? fail("tour_movie_cancelled"));
    const timer = setTimeout(() => finish(fail("tour_panorama_readiness_timeout")), 8000);
    signal?.addEventListener("abort", abort, {once: true});Promise.resolve(opened).then(value => finish(null, value), finish);
  });
}

/** Two actual renderer frames with installed tiles; no polling or network reads. */
export function waitForTourPaint(map, signal, maximumMilliseconds = 8000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let frames = 0, done = false;
    const finish = error => {if (done) return;done = true;clearTimeout(timer);map.off("render", rendered);signal?.removeEventListener("abort", aborted);if (error) reject(error);else resolve();};
    const aborted = () => finish(signal.reason ?? fail("tour_movie_cancelled"));
    const rendered = () => {
      frames++;
      if (frames >= 2 && map.isStyleLoaded?.() !== false && map.areTilesLoaded?.() !== false && !map.isMoving?.()) finish();
      else map.triggerRepaint();
    };
    const timer = setTimeout(() => finish(fail("tour_movie_frame_readiness_timeout")), maximumMilliseconds);
    map.on("render", rendered);signal?.addEventListener("abort", aborted, {once: true});map.triggerRepaint();
  });
}
