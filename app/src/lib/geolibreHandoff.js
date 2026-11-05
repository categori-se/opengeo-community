import {canonicalJson} from "./legacyCanonicalJson.js";
import {exportGeoLibreProject, GEOLIBRE_IMPORT_LIMITS, importGeoLibreProject} from "./geolibreProject.js";

const HANDOFF_VERSION = "opengeo.geolibre-handoff.1.0.0";
const RETURN_VERSION = "opengeo.geolibre-return.1.0.0";
const REVIEW_VERSION = "opengeo.geolibre-return-review.1.0.0";
const CAMERA_FIELDS = ["center", "zoom", "bearing", "pitch", "bbox"];
const ROOT_MAPPINGS = {
  styles: "styles", preferences: "preferences", models: "models",
  processingHistory: "processingHistory", layerGroups: "layerGroups",
  legend: "legend", storymap: "storymap", widgets: "widgets",
  dashboardColumns: "dashboardColumns", mapLayout: "mapLayout",
  primaryMapLabel: "primaryMapLabel", styleLibrary: "styleLibrary", comments: "comments"
};

// A handoff is a file exchange for one saved revision. It carries no bearer
// authority: the return path must load that revision through the normal API.
export async function createGeoLibreHandoff({projectId, map, embeddedDataByLayerId}) {
  assertSavedMap(map);
  requireId(projectId, "Project");
  assertCompleteManagedData(map, embeddedDataByLayerId);
  const result = exportGeoLibreProject(map, {embeddedDataByLayerId});
  result.project.metadata.opengeo.handoff = {
    schemaVersion: HANDOFF_VERSION,
    projectId,
    mapId: map.id,
    mapVersion: map.version,
    definitionSha256: await definitionDigest(map.definition)
  };
  result.json = JSON.stringify(result.project, null, 2);
  assertProjectSize(result.json);
  return result;
}

// baseMap and currentMap are authorized server records, never records supplied
// by the GeoLibre file. Returned metadata cannot select governed identities.
export async function reviewGeoLibreReturn({conversion, projectId, baseMap, currentMap, embeddedDataByLayerId}) {
  assertSavedMap(baseMap);
  assertSavedMap(currentMap);
  requireId(projectId, "Project");
  const source = conversion?.map?.definition?.extensions?.geolibre?.project;
  if (!source) throw new TypeError("Choose a converted GeoLibre Project to review.");
  const converted = importGeoLibreProject(source);
  const returnedProject = converted.map.definition.extensions.geolibre.project;
  const handoff = returnedProject.metadata?.opengeo?.handoff;
  const definitionSha256 = await definitionDigest(baseMap.definition);
  if (handoff?.schemaVersion !== HANDOFF_VERSION
    || handoff.projectId !== projectId
    || handoff.mapId !== baseMap.id
    || handoff.mapVersion !== baseMap.version
    || handoff.definitionSha256 !== definitionSha256) {
    throw codedError("geolibre_handoff_mismatch", "This GeoLibre file does not match the saved OpenGeo Project revision. Choose the original Project and revision.");
  }
  if (currentMap.id !== baseMap.id) {
    throw codedError("geolibre_handoff_mismatch", "The current Project map does not match the GeoLibre handoff.");
  }
  assertCompleteManagedData(baseMap, embeddedDataByLayerId);
  const exportedBase = exportGeoLibreProject(baseMap, {embeddedDataByLayerId});
  const nativeBase = new Map(exportedBase.project.layers.map((layer) => [layer.id, layer]));
  const baseLayers = new Map(baseMap.definition.layers.map((layer) => [layer.layerId, layer]));
  const importedLayers = new Map(converted.map.definition.layers.map((layer) => [layer.layerId, layer]));
  const candidates = new Map([
    ...converted.records.embeddedDatasets.map((record) => [record.importRef, {kind: "embedded", record}]),
    ...converted.records.externalSources.map((record) => [record.importRef, {kind: "external", record}])
  ]);
  const base = {mapId: baseMap.id, mapVersion: baseMap.version, definitionSha256};
  const review = {
    schemaVersion: REVIEW_VERSION,
    base,
    current: {mapId: currentMap.id, mapVersion: currentMap.version},
    conflict: currentMap.version !== baseMap.version,
    added: [], changed: [], removed: [], unchanged: [], styles: [], limits: []
  };
  const layers = [];
  const embeddedDatasets = [];
  const externalSources = [];
  const outputs = [];
  const seen = new Set();
  const remappedIds = new Map();
  const reservedIds = new Set(baseLayers.keys());
  for (const native of returnedProject.layers) {
    const original = baseLayers.get(native.id);
    const baseline = nativeBase.get(native.id);
    const returned = importedLayers.get(native.id);
    if (original) seen.add(original.layerId);
    if (!returned) {
      if (original) layers.push(clone(original));
      review.limits.push(`Layer ${native.name ?? native.id} has no supported return mapping; its safe GeoLibre content is retained${original ? " and the original OpenGeo Layer is preserved" : " in the compatibility extension"}.`);
      continue;
    }
    const dataChanged = !original || !equal(sourceContent(native), sourceContent(baseline));
    const styleChanged = original && !equal(native.style ?? {}, baseline.style ?? {});
    const presentationChanged = original && !equal(presentation(native), presentation(baseline));
    if (!dataChanged) {
      const reused = clone(original);
      if (native.name !== baseline.name) reused.title = returned.title;
      if ((native.visible !== false) !== (baseline.visible !== false)) reused.visible = returned.visible;
      if ((native.opacity ?? 1) !== (baseline.opacity ?? 1)) reused.opacity = returned.opacity;
      if (styleChanged) {
        reused.style = clone(returned.style);
        reused.labels = clone(returned.labels);
        delete reused.styleReference;
      }
      layers.push(reused);
      remappedIds.set(native.id, original.layerId);
      if (styleChanged || presentationChanged) {
        review.changed.push({layerId: original.layerId, changes: [
          ...(styleChanged ? ["style"] : []), ...(presentationChanged ? ["presentation"] : [])
        ]});
      } else review.unchanged.push(original.layerId);
      if (styleChanged) review.styles.push(original.layerId);
      continue;
    }
    const candidate = candidates.get(returned.importRef);
    if (!candidate) {
      // Direct URL-only adapter records cannot be persisted by the governed
      // import path. Never pass their pending identities off as saved Layers.
      if (original) layers.push(clone(original));
      review.limits.push(`Layer ${native.name ?? native.id} changed its source, but that source has no governed return adapter. The source is retained for review${original ? " and the original OpenGeo Layer is preserved" : " in the compatibility extension"}.`);
      continue;
    }
    const digest = await sha256(canonicalJson({base, layer: native}));
    let layerId = `geolibre-result-${digest.slice(0, 24)}`;
    // Identical file content is repeatable; even an adversarial native ID can
    // never replace a retained Layer or collide with another returned output.
    while (reservedIds.has(layerId)) layerId += "-result";
    reservedIds.add(layerId);
    const importRef = `geolibre:return:${digest}`;
    const output = clone(returned);
    output.layerId = layerId;
    output.datasetId = `import:${layerId}`;
    output.importRef = importRef;
    if (candidate.kind === "embedded") output.objectId = `pending-import:${layerId}`;
    else delete output.objectId;
    const record = {...clone(candidate.record), layerId, importRef};
    (candidate.kind === "embedded" ? embeddedDatasets : externalSources).push(record);
    if (original) layers.push(clone(original));
    layers.push(output);
    remappedIds.set(native.id, layerId);
    outputs.push({
      layerId, importRef,
      inputLayerIds: original ? [original.layerId] : [],
      retention: "retained-output", reproducible: false
    });
    if (original) {
      review.changed.push({layerId: original.layerId, derivativeLayerId: layerId, changes: [
        "data", ...featureChanges(baseline.geojson, native.geojson),
        ...(styleChanged ? ["style"] : []), ...(presentationChanged ? ["presentation"] : [])
      ]});
      if (styleChanged) review.styles.push(layerId);
    } else review.added.push(layerId);
  }
  review.removed = [...baseLayers.keys()].filter((id) => !seen.has(id));
  layers.forEach((layer, order) => {layer.order = order;});
  const importedDefinition = converted.map.definition;
  const definition = clone(baseMap.definition);
  for (const [nativeKey, key] of Object.entries(ROOT_MAPPINGS)) {
    if (equal(exportedBase.project[nativeKey], returnedProject[nativeKey])) continue;
    if (Object.hasOwn(importedDefinition, key)) definition[key] = clone(importedDefinition[key]);
    else delete definition[key];
  }
  const {cameraChanges, cameraChoices} = reviewCameras(baseMap.definition.mapViews,
    exportedBase.project, returnedProject, importedDefinition.mapViews);
  if (!equal(basemapContent(exportedBase.project), basemapContent(returnedProject))) {
    definition.basemaps = clone(importedDefinition.basemaps);
  }
  if (!equal(exportedBase.project.preferences?.map?.projection, returnedProject.preferences?.map?.projection)) {
    definition.projection = importedDefinition.projection;
  }
  if (!equal(exportedBase.project.models, returnedProject.models)) definition.activeProcessingModelId = importedDefinition.activeProcessingModelId;
  definition.layers = layers;
  definition.activeLayerId = remappedIds.get(importedDefinition.activeLayerId) ?? null;
  // Only the imported compatibility envelope is accepted from the external
  // document. All other OpenGeo extensions start from the trusted base record.
  definition.extensions = {
    ...clone(baseMap.definition.extensions ?? {}),
    geolibre: importedDefinition.extensions.geolibre,
    opengeoGeoLibreReturn: {
      schemaVersion: RETURN_VERSION,
      base,
      inputs: [...baseLayers.values()].map((layer) => ({
        layerId: layer.layerId,
        datasetId: layer.datasetId,
        ...(layer.datasetVersionId != null ? {datasetVersionId: layer.datasetVersionId} : {})
      })),
      outputs
    }
  };
  if (exportedBase.project.primaryRenderer !== returnedProject.primaryRenderer) {
    definition.extensions.opengeoRenderer = importedDefinition.extensions.opengeoRenderer ?? {id: "maplibre"};
  }
  converted.map.definition = definition;
  converted.records.embeddedDatasets = embeddedDatasets;
  converted.records.externalSources = externalSources;
  const beforeStyles = exportedBase.project.styles ?? {};
  for (const id of new Set([...Object.keys(beforeStyles), ...Object.keys(returnedProject.styles ?? {})])) {
    if (!equal(beforeStyles[id], returnedProject.styles?.[id]) && !review.styles.includes(id)) review.styles.push(id);
  }
  review.limits.push(...exportedBase.report.losses, ...converted.report.losses);
  if (outputs.length) {
    review.limits.push("Returned outputs are retained results. Their execution environment and complete processing parameters are unverified; they are not declared reproducible analyses.");
    if (outputs.some((output) => output.inputLayerIds.length === 0)) {
      review.limits.push("New GeoLibre Layers have no verified input lineage. Declare their input Layers during review; their original GeoLibre project and processing history are retained.");
    }
  }
  cameraChoices.baseLimits = clone(review.limits);
  cameraChoices.baseLosses = clone(converted.report.losses);
  return applyGeoLibreReturnCameraChoice({conversion: converted, review, cameraChanges, cameraChoices}, false);
}

// This choice changes only cameras in an already authorized review. Neither a
// file's view identities nor its order can replace the canonical saved views.
export function applyGeoLibreReturnCameraChoice(result, useReturnedCameras = false) {
  if (typeof useReturnedCameras !== "boolean") throw new TypeError("Choose whether to use returned GeoLibre cameras.");
  const {conversion, review, cameraChanges, cameraChoices} = result ?? {};
  if (!conversion?.map?.definition || !review || !Array.isArray(cameraChanges)
    || !Array.isArray(cameraChoices?.canonicalViews) || !Array.isArray(cameraChoices.incomingPatches)) {
    throw new TypeError("A reviewed GeoLibre return with camera choices is required.");
  }
  const views = clone(cameraChoices.mappedViews ?? cameraChoices.canonicalViews);
  cameraChoices.baseLimits ??= clone(review.limits ?? []);
  cameraChoices.baseLosses ??= clone(conversion.report.losses ?? []);
  if (useReturnedCameras) {
    for (const {index, camera} of cameraChoices.incomingPatches) {
      for (const field of CAMERA_FIELDS) {
        if (!Object.hasOwn(camera, field)) continue;
        if (camera[field] === null) delete views[index][field];
        else views[index][field] = clone(camera[field]);
      }
    }
  }
  conversion.map.definition.mapViews = views;
  review.cameraChoice = useReturnedCameras ? "returned" : "canonical";
  const messages = cameraChanges.map(({viewId, field, before, returned}) =>
    `View ${JSON.stringify(viewId)} ${field} changed in GeoLibre from ${JSON.stringify(before)} to ${JSON.stringify(returned)}; ${useReturnedCameras ? "the returned camera change was explicitly selected" : "the canonical saved camera is retained"}.`);
  const limits = [...(cameraChoices.notices ?? []), ...messages];
  review.limits = [...cameraChoices.baseLimits, ...limits];
  conversion.report.losses = [...cameraChoices.baseLosses, ...limits];
  const summary = conversion.report.summary;
  summary.status = summary.rejected || conversion.report.losses.length ? "lossy"
    : summary.preserved || summary.unsupported ? "preserved_with_extensions" : "lossless";
  return result;
}

function reviewCameras(canonicalViews, exported, returned, importedViews) {
  const cameraChanges = [];
  const cameraChoices = {canonicalViews: clone(canonicalViews ?? []), mappedViews: clone(canonicalViews ?? []),
    incomingPatches: [], notices: []};
  const baseSecondary = exported.secondaryMapViews ?? [];
  const returnedSecondary = returned.secondaryMapViews ?? [];
  const expectedIds = baseSecondary.map(view => view.id);
  const returnedIds = returnedSecondary.map(view => view?.id);
  for (const [index, view] of cameraChoices.canonicalViews.entries()) {
    const id = index === 0 ? view.viewId ?? view.id ?? "primary" : baseSecondary[index - 1]?.id;
    const viewId = view.viewId ?? view.id ?? id;
    const matches = index === 0 ? [importedViews[0]] : returnedSecondary.filter(item => item?.id === id);
    const incoming = index === 0 ? importedViews[0]
      : importedViews.slice(1).find(item => item.viewId === id);
    if (matches.length !== 1 || !incoming) {
      cameraChoices.notices.push(`View ${JSON.stringify(viewId)} is missing or ambiguous in the GeoLibre return; its canonical identity, order and camera are retained.`);
      continue;
    }
    if (index > 0) {
      const baseline = baseSecondary[index - 1];
      const native = matches[0];
      const mapped = cameraChoices.mappedViews[index];
      for (const field of ["label", "viewKind", "layerVisibility"]) {
        if (equal(baseline[field], native[field])) continue;
        if (Object.hasOwn(native, field) && !Object.hasOwn(incoming, field)) {
          cameraChoices.notices.push(`View ${JSON.stringify(viewId)} returned an unsupported ${field} value; its canonical value is retained and the raw value remains in the GeoLibre compatibility envelope.`);
          continue;
        }
        if (Object.hasOwn(incoming, field)) mapped[field] = clone(incoming[field]);
        else delete mapped[field];
        // The exporter uses a saved title as the native label when present.
        // Keep that alias consistent so a subsequent handoff retains the edit.
        if (field === "label" && Object.hasOwn(view, "title")) {
          if (Object.hasOwn(incoming, field)) mapped.title = incoming[field];
          else delete mapped.title;
        }
      }
    }
    const camera = {};
    for (const field of CAMERA_FIELDS) {
      if (equal(view[field], incoming[field])) continue;
      camera[field] = incoming[field] === undefined ? null : clone(incoming[field]);
      cameraChanges.push({viewId, field, before: view[field] === undefined ? null : clone(view[field]), returned: clone(camera[field])});
    }
    if (Object.keys(camera).length) cameraChoices.incomingPatches.push({index, viewId, camera});
  }
  if (!equal(expectedIds, returnedIds)) {
    cameraChoices.notices.push("GeoLibre changed the saved view identities or order; canonical view identities and order are retained. Returned view records remain in the GeoLibre compatibility envelope.");
  }
  return {cameraChanges, cameraChoices};
}

function assertCompleteManagedData(map, entries) {
  const data = entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}));
  for (const layer of map.definition.layers) {
    if (!["governed-dataset", "geojson-object"].includes(layer.sourceType)) continue;
    const entry = data.get(layer.layerId);
    if (entry?.complete !== true || entry.data?.type !== "FeatureCollection" || !Array.isArray(entry.data.features)) {
      throw codedError("geolibre_complete_data_required", `Layer ${layer.title ?? layer.layerId} needs its complete saved GeoJSON data. A preview or partial feature page cannot be used for a GeoLibre handoff.`);
    }
  }
}

function assertSavedMap(map) {
  if (!map || typeof map.id !== "string" || !map.id || !Number.isSafeInteger(map.version) || map.version < 1
    || !map.definition || !Array.isArray(map.definition.layers)) {
    throw new TypeError("A saved OpenGeo Project map and revision are required.");
  }
}

function requireId(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} identity is required.`);
}

function sourceContent(layer) {
  return layer ? {type: layer.type, source: layer.source ?? null, geojson: layer.geojson ?? null} : null;
}

function presentation(layer) {
  return {name: layer.name, visible: layer.visible !== false, opacity: layer.opacity ?? 1, groupId: layer.groupId ?? null};
}

function basemapContent(project) {
  return {url: project.basemapStyleUrl, visible: project.basemapVisible, opacity: project.basemapOpacity};
}

function featureChanges(before, after) {
  if (before?.type !== "FeatureCollection" || after?.type !== "FeatureCollection") return [];
  return [
    ...(!equal(before.features.map((feature) => feature?.geometry), after.features.map((feature) => feature?.geometry)) ? ["geometries"] : []),
    ...(!equal(before.features.map((feature) => feature?.properties), after.features.map((feature) => feature?.properties)) ? ["attributes"] : []),
    ...(!equal(before.features.map((feature) => feature?.id ?? null), after.features.map((feature) => feature?.id ?? null)) ? ["features"] : [])
  ];
}

function equal(left, right) { return canonicalJson(left) === canonicalJson(right); }
function clone(value) { return structuredClone(value); }
async function definitionDigest(definition) { return sha256(canonicalJson(definition)); }
async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for GeoLibre exchange.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function assertProjectSize(json) {
  if (new TextEncoder().encode(json).byteLength > GEOLIBRE_IMPORT_LIMITS.maxProjectBytes) {
    throw new Error(`Exported GeoLibre project exceeds ${GEOLIBRE_IMPORT_LIMITS.maxProjectBytes} bytes.`);
  }
}
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
