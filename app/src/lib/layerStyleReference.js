import {opacityPaint} from "./layerOpacity.js";
import {savedPattern, rasterizePattern} from "./cartographicPatterns.js";
import {normalizePointSymbolStyle, pointSymbolImages, pointSymbolStyleParts, ensurePointSymbolAssets} from "./pointSymbols.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["projectId", "resourceId", "styleId", "versionNumber", "checksumSha256", "format"];
export function validateLayerStyleReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(value, key))
    || ![value.projectId, value.resourceId, value.styleId].every(id => typeof id === "string" && UUID.test(id))
    || !Number.isSafeInteger(value.versionNumber) || value.versionNumber < 1
    || typeof value.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.checksumSha256)
    || !["maplibre", "geostyler", "sld_1_0", "sld_1_1", "mapserver_mapfile"].includes(value.format)) {
    throw new Error("Invalid Style reference");
  }
  return value;
}

export async function resolveLayerStyle(adapter, layer) {
  const reference = validateLayerStyleReference(layer.styleReference);
  const resource = await adapter.getResource(reference.projectId, reference.resourceId);
  if (resource.id !== reference.resourceId || resource.projectId !== reference.projectId
    || resource.datasetId !== layer.datasetId) throw new Error("Style resource no longer refers to this Layer");
  const style = await adapter.getResourceStyleVersion(reference.projectId, reference.resourceId,
    reference.styleId, reference.versionNumber);
  if (style.id !== reference.styleId || style.resourceId !== reference.resourceId
    || style.versionNumber !== reference.versionNumber || style.format !== reference.format
    || style.checksumSha256 !== reference.checksumSha256 || typeof style.definition !== "string") {
    throw new Error("Requested Style version was not returned");
  }
  const bytes = new TextEncoder().encode(style.definition);
  if (bytes.length > 49_152) throw new Error("Style definition exceeds the supported size");
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  if (checksum !== reference.checksumSha256) throw new Error("Style checksum changed");
  if (style.format === "sld_1_1") {
    const pattern = savedPattern(style);
    if (!pattern || !["Polygon", "MultiPolygon"].includes(layer.geometryType)) {
      throw Error("Only generated polygon pattern Styles are supported");
    }
    const imageId = `${layer.layerId}-pattern-${checksum}`;
    const raster = await rasterizePattern(pattern);
    return {title: style.title, reference: structuredClone(reference), pattern,
      images: [{id: imageId, ...raster}],
      parts: [{id: "pattern", type: "fill", paint: {"fill-pattern": imageId, "fill-opacity": 1}}]};
  }
  if (style.format !== "maplibre") throw new Error("This browser renderer requires a MapLibre Style");
  const document = JSON.parse(style.definition);
  if (document?.version !== 8 || !document.sources || typeof document.sources !== "object" || Array.isArray(document.sources)
    || Object.keys(document.sources).length || Object.keys(document).some(key => !["version", "name", "metadata", "sources", "layers"].includes(key))
    || !Array.isArray(document.layers) || !document.layers.length || document.layers.length > 16) {
    throw new Error("Style must contain detached geometry passes without external dependencies");
  }
  const geometry = layer.geometryType;
  const pointStyle = document.metadata?.["opengeo:point-symbol"] === undefined ? null
    : pointStyleMetadata(document.metadata["opengeo:point-symbol"]);
  const pointParts = pointStyle ? pointSymbolStyleParts({geometryType: "Point", opacity: 1, style: pointStyle}) : [];
  const pointGeometry = ["Point", "MultiPoint"].includes(geometry);
  if (pointStyle && !pointGeometry) throw Error("Point symbols require a Point Layer");
  if (pointStyle) {
    const expected = JSON.parse(pointSymbolStyleDefinition(pointStyle, document.name ?? style.title)).layers;
    if (document.layers.length !== expected.length || document.layers.some((part, index) =>
      part?.type !== expected[index].type || JSON.stringify(part.paint) !== JSON.stringify(expected[index].paint)
      || JSON.stringify(part.layout ?? {}) !== JSON.stringify(expected[index].layout ?? {}))) {
      throw Error("Saved point symbol passes do not match their metadata");
    }
  }
  const kinds = pointGeometry ? ["circle", ...(pointStyle ? ["symbol"] : [])]
    : ["Polygon", "MultiPolygon"].includes(geometry) ? ["fill", "line"]
      : ["LineString", "MultiLineString"].includes(geometry) ? ["line"] : [];
  const fields = {
    circle: ["circle-color", "circle-radius", "circle-opacity", "circle-stroke-color", "circle-stroke-width", "circle-stroke-opacity"],
    fill: ["fill-color", "fill-opacity", "fill-outline-color"],
    line: ["line-color", "line-width", "line-opacity"]
  };
  const ids = new Set();
  for (const part of document.layers) {
    if (!part || typeof part !== "object" || typeof part.id !== "string" || !part.id.length || part.id.length > 100
      || ids.has(part.id) || !kinds.includes(part.type)
      || Object.keys(part).some(key => !["id", "type", "paint", "layout"].includes(key))
      || (part.type !== "symbol" && part.layout !== undefined && (!part.layout || typeof part.layout !== "object" || Array.isArray(part.layout) || Object.keys(part.layout).length))) {
      throw new Error("Style geometry or layout is incompatible with this Layer");
    }
    ids.add(part.id);
    if (part.type === "symbol") {
      const expected = pointParts.find(candidate => candidate.type === "symbol");
      if (!expected || JSON.stringify(part.layout) !== JSON.stringify(expected.layout)
        || !part.paint || Object.keys(part.paint).length !== 1
        || typeof part.paint["icon-opacity"] !== "number" || !Number.isFinite(part.paint["icon-opacity"])
        || part.paint["icon-opacity"] < 0 || part.paint["icon-opacity"] > 1) {
        throw Error("Unsupported point symbol layout or paint");
      }
      continue;
    }
    if (!part.paint || typeof part.paint !== "object" || Array.isArray(part.paint)
      || Object.keys(part.paint).some(key => !fields[part.type].includes(key))) throw new Error("Unsupported Style paint");
    for (const field of fields[part.type]) {
      const value = part.paint[field];
      if (field.endsWith("opacity") && value === undefined) continue;
      if (field.endsWith("color")) {
        if (!validColor(value)) throw new Error("Unsupported Style color");
      } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0
        || (field.endsWith("opacity") && value > 1)) throw new Error("Unsupported Style dimension or opacity");
    }
  }
  if (pointStyle) await ensurePointSymbolAssets(pointStyle);
  return {title: style.title, reference: structuredClone(reference), parts: document.layers,
    ...(pointStyle ? {pointSymbolStyle: pointStyle, images: pointSymbolImages(pointStyle)} : {})};
}

function pointStyleMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["pointSymbol", "circleColor", "circleRadius", "categoryField", "categorySymbols"].includes(key))
    || !["pointSymbol", "circleColor", "circleRadius"].every(key => Object.hasOwn(value, key))
    || typeof value.circleColor !== "string" || !/^#[a-f\d]{6}$/i.test(value.circleColor)
    || (Object.hasOwn(value, "categoryField") !== Object.hasOwn(value, "categorySymbols"))) {
    throw Error("Invalid saved point symbol metadata");
  }
  return normalizePointSymbolStyle({...value, ...(value.categoryField ? {renderer: "category"} : {})});
}

export function pointSymbolStyleDefinition(style, title = "Point symbols") {
  const normalized = normalizePointSymbolStyle(style);
  const metadata = {pointSymbol: normalized.pointSymbol, circleColor: normalized.circleColor ?? "#2563eb",
    circleRadius: normalized.circleRadius ?? 6,
    ...(normalized.categorySymbols ? {categoryField: normalized.categoryField, categorySymbols: normalized.categorySymbols} : {})};
  const selected = pointStyleMetadata(metadata);
  if (typeof title !== "string" || !title.trim() || title.length > 300) throw Error("Invalid point Style title");
  return JSON.stringify({version: 8, name: title.trim(), metadata: {"opengeo:point-symbol": metadata}, sources: {},
    layers: [{id: "point-fill", type: "circle", paint: {"circle-color": selected.circleColor,
      "circle-radius": selected.circleRadius, "circle-opacity": 1, "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5, "circle-stroke-opacity": 1}},
    ...pointSymbolStyleParts({geometryType: "Point", opacity: 1, style: selected})]}, null, 2);
}

// The visual editor recognizes only generated definitions; other saved text
// remains inspectable through the existing version editor.
export function savedPointSymbolStyle(style) {
  if (style?.format !== "maplibre" || typeof style.definition !== "string") return null;
  try {
    const document = JSON.parse(style.definition);
    const selected = pointStyleMetadata(document.metadata?.["opengeo:point-symbol"]);
    return JSON.stringify(document) === JSON.stringify(JSON.parse(pointSymbolStyleDefinition(selected, document.name)))
      ? selected : null;
  } catch {return null;}
}
function validColor(value) {
  if (typeof value === "string") return /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value);
  // Closed numeric classification used by the MassGIS/palette library. This
  // admits a bounded step over one field, without a general expression editor.
  if (Array.isArray(value) && value[0] === "step") {
    const input=value[1], nullable=input?.[1], get=nullable?.[1];
    if (value.length<5 || value.length>45 || value.length%2!==1
      || !Array.isArray(input) || input.length!==3 || input[0]!=="to-number" || input[2]!==-1
      || !Array.isArray(nullable) || nullable.length!==3 || nullable[0]!=="coalesce" || nullable[2]!==-1
      || !Array.isArray(get) || get.length!==2 || get[0]!=="get"
      || typeof get[1]!=="string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(get[1])
      || ["__proto__","constructor","prototype"].includes(get[1])
      || typeof value[2]!=="string" || !validColor(value[2])) return false;
    let previous=-Infinity;
    for (let i=3;i<value.length;i+=2) {
      if (typeof value[i]!=="number" || !Number.isFinite(value[i]) || value[i]<=previous
        || typeof value[i+1]!=="string" || !validColor(value[i+1])) return false;
      previous=value[i];
    }
    return true;
  }
  if (!Array.isArray(value) || value[0] !== "match" || value.length < 5 || value.length % 2 !== 1
    || !Array.isArray(value[1]) || value[1].length !== 2 || value[1][0] !== "get"
    || typeof value[1][1] !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(value[1][1])) return false;
  return value.slice(2).every((entry, index, rest) => index === rest.length - 1 || index % 2 === 1
    ? typeof entry === "string" && /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(entry)
    : typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry)));
}
export function referencedStylePaint(resolved, layer) {
  if (layer.opacityMode === "composite" && resolved.parts.some(part => !["fill", "line"].includes(part.type))) throw Error("Composite opacity requires fill or line Style parts");
  return resolved.parts.map((part, index) => ({...structuredClone(part), id: `${layer.layerId}-style-${index}`,
    paint: opacityPaint(part.type, part.paint, layer.opacity, layer.opacityMode)}));
}
