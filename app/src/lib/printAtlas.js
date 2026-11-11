import {geoStream} from "d3";
import {geojsonBounds} from "./mapLayers.js";
import {captureMapView} from "./globeView.js";
import {canonicalJson} from "./artifactCanonicalJson.js";

export const PRINT_ATLAS_LIMITS = Object.freeze({pages: 32, positions: 100000, bytes: 32 * 1024 * 1024, milliseconds: 120000});

function sourcePin(source) {
  return Object.fromEntries(["layerId", "datasetId", "datasetVersionId", "sourceVersion", "featureGeneration", "checksumSha256"]
    .map(key => [key, source.inputPin?.[key] ?? null]));
}

export function planPrintAtlas(context, {layerId, featureNumbers, labelField = ""}) {
  const source = context?.getPrintDataSource?.(layerId), layer = context?.layers?.find(item => item.layerId === layerId);
  const data = source?.geojson;
  if (!layer || source?.id !== layerId || layer.managedDisplayId || data?.type !== "FeatureCollection"
    || !Array.isArray(data.features) || data.opengeo?.mayBeTruncated || data.opengeo?.schemaVersion === "opengeo.live-feature-page.1.0.0") {
    throw Error("Choose a complete loaded GeoJSON Layer for atlas coverage.");
  }
  const numbers = String(featureNumbers).split(",").map(value => Number(value.trim()));
  if (!numbers.length || numbers.length > PRINT_ATLAS_LIMITS.pages || new Set(numbers).size !== numbers.length
    || numbers.some(value => !Number.isSafeInteger(value) || value < 1 || value > data.features.length)) {
    throw Error("Choose up to 32 distinct loaded feature numbers, separated by commas.");
  }
  let positions = 0;
  const pages = numbers.map(number => {
    const feature = data.features[number - 1];
    geoStream(feature, {point() {if (++positions > PRINT_ATLAS_LIMITS.positions) throw Error("Atlas coverage exceeds 100,000 coordinates. Select fewer features.");},
      lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {}, sphere() {throw Error("Sphere coverage cannot define an atlas page.");}});
    const bounds = geojsonBounds(feature);
    if (!bounds || bounds[0][0] < -180 || bounds[1][0] > 180 || bounds[0][1] <= -85 || bounds[1][1] >= 85
      || bounds[1][0] - bounds[0][0] > 180) throw Error(`Feature ${number} needs ordered Mercator coverage within 85° latitude and one side of the date line.`);
    const value = labelField && Object.hasOwn(feature.properties ?? {}, labelField) ? feature.properties[labelField] : null;
    const label = ["string", "number", "boolean"].includes(typeof value) ? String(value).slice(0, 200) : `Feature ${number}`;
    return {number, id: feature.id ?? null, label: label || `Feature ${number}`, bounds, signature: canonicalJson(feature)};
  });
  return {layerId, sourcePin: sourcePin(source), data, pages};
}

function assertAtlasSource(context, plan) {
  const source = context.getPrintDataSource?.(plan.layerId);
  if (!source || source.geojson !== plan.data || canonicalJson(sourcePin(source)) !== canonicalJson(plan.sourcePin)) {
    throw Error("The atlas coverage Layer changed. Review its current features before exporting.");
  }
  if (plan.pages.some(page => canonicalJson(source.geojson.features[page.number - 1]) !== page.signature)) {
    throw Error("The selected atlas features changed. Review their current geometry before exporting.");
  }
}

function atlasRender(map, signal, move, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); map.off("render", rendered); map.off("error", failed); map.off("remove", removed);
      signal?.removeEventListener("abort", aborted); error ? reject(error) : resolve();
    };
    const rendered = () => {
      if (!map.isMoving?.() && map.isStyleLoaded?.() && map.areTilesLoaded?.() !== false && map.loaded?.() !== false) finish();
    };
    const failed = () => finish(Error("An atlas page could not render. Check its visible Layers before exporting."));
    const removed = () => finish(Error("The atlas map was closed."));
    const aborted = () => finish(signal.reason ?? Error("Atlas export canceled."));
    const timer = setTimeout(() => finish(Error("The atlas map did not settle in time.")), timeout);
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, {once: true});
    map.on("render", rendered); map.on("error", failed); map.on("remove", removed);
    try {move(); map.triggerRepaint();} catch (error) {finish(error);}
  });
}

export async function capturePrintAtlas(context, plan, {signal, capturePage, onProgress = () => {}, isCurrent = () => true}) {
  const map = context?.map;
  if (context?.renderer !== "maplibre" || !context.ready || !map?.cameraForBounds
    || (map.getProjection?.()?.type ?? context.project?.projection ?? "mercator") !== "mercator"
    || (context.project?.spatialBody?.id ?? "earth") !== "earth") throw Error("Open an Earth Mercator MapLibre view for atlas capture.");
  const original = captureMapView(map), padding = map.getPadding?.();
  const started = performance.now(), pages = [];
  try {
    for (const [index, page] of plan.pages.entries()) {
      signal?.throwIfAborted();
      if (!await isCurrent() || performance.now() - started >= PRINT_ATLAS_LIMITS.milliseconds) throw Error("Atlas capture stopped before its time limit.");
      assertAtlasSource(context, plan);
      const bounds = page.bounds.map(point => [...point]);
      if (bounds[0][0] === bounds[1][0]) {bounds[0][0] -= 0.00001; bounds[1][0] += 0.00001;}
      if (bounds[0][1] === bounds[1][1]) {bounds[0][1] -= 0.00001; bounds[1][1] += 0.00001;}
      const camera = map.cameraForBounds(bounds, {padding: 24, maxZoom: 18, bearing: 0});
      if (!camera) throw Error(`Feature ${page.number} cannot fit in this map frame.`);
      onProgress(index + 1, plan.pages.length, page.label);
      await atlasRender(map, signal, () => map.jumpTo({...camera, pitch: 0, bearing: 0}));
      const output = await capturePage(page, index);
      signal?.throwIfAborted(); assertAtlasSource(context, plan);
      if (!await isCurrent()) throw Error("The atlas view changed while preparing output.");
      pages.push(output);
    }
    return pages;
  } finally {
    if (!map._removed) await atlasRender(map, null, () => {if (padding) map.setPadding(padding); map.jumpTo(original);}, 2000);
  }
}
