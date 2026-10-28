import {strFromU8, strToU8, unzipSync, zipSync} from "fflate";
import {normalizeKmlNetworkLink} from "./kmlNetworkLink.js";

export const KML_PLACES_LIMITS = Object.freeze({
  maximumKmlBytes: 256 * 1024,
  maximumKmzBytes: 4 * 1024 * 1024,
  maximumKmzEntries: 64,
  maximumKmzUncompressedBytes: 8 * 1024 * 1024,
  maximumProjectPlacesBytes: 192 * 1024,
  maximumPlaces: 1_000,
  maximumPositions: 10_000,
  maximumDepth: 16,
  maximumTextCharacters: 8_192,
  maximumExtendedDataFields: 64,
  maximumSharedStyles: 256,
  maximumStyleMapPairs: 8,
  maximumSchemas: 64,
  maximumSchemaFields: 64,
  maximumOverlayAxisPixels: 16_384,
  maximumLodPixels: 10_000_000,
  maximumKmzResources: 32,
  maximumKmzResourceBytes: 64 * 1024,
  maximumKmzResourceTotalBytes: 96 * 1024
});

const KML_NAMESPACE = "http://www.opengis.net/kml/2.2";
const GX_NAMESPACE = "http://www.google.com/kml/ext/2.2";
const STANDARD_ALTITUDE_MODES = new Set(["clampToGround", "relativeToGround", "absolute"]);
const GX_ALTITUDE_MODES = new Set(["clampToSeaFloor", "relativeToSeaFloor"]);
const KML_SCHEMA_TYPES = new Set(["string", "int", "uint", "short", "ushort", "float", "double", "bool"]);
const KML_RESOURCE_MEDIA = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"]
]);
const OMITTED_FEATURES = new Set(["Tour"]);
const OVERLAY_ELEMENTS = new Map([
  ["GroundOverlay", "ground-overlay"],
  ["ScreenOverlay", "screen-overlay"],
  ["PhotoOverlay", "photo-overlay"]
]);
const CONTAINER_PRESERVED_CHILDREN = new Set(["name", "description", "visibility", "open", "Camera", "LookAt", "TimeStamp", "TimeSpan", "Region"]);
const PLACEMARK_PRESERVED_CHILDREN = new Set([
  "name", "description", "visibility", "Camera", "LookAt", "TimeStamp", "TimeSpan", "styleUrl", "Style", "Region", "ExtendedData",
  "Point", "LineString", "Polygon", "MultiGeometry", "Model"
]);

export function parseKml(text, {DOMParser: Parser = globalThis.DOMParser} = {}) {
  if (typeof text !== "string") throw kmlError("kml_text_required");
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > KML_PLACES_LIMITS.maximumKmlBytes) throw kmlError("kml_too_large");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw kmlError("active_xml_rejected");
  if (typeof Parser !== "function") throw kmlError("dom_parser_unavailable");

  const xml = new Parser().parseFromString(text, "application/xml");
  if (xml.querySelector?.("parsererror") || xml.documentElement?.localName === "parsererror") {
    throw kmlError("malformed_kml");
  }
  const root = xml.documentElement;
  if (root?.localName !== "kml" || root.namespaceURI !== KML_NAMESPACE) {
    throw kmlError("kml_2_2_namespace_required");
  }

  const report = [];
  const counters = {places: 0, positions: 0, ids: new Set()};
  const source = directChildren(root).find((element) => element.namespaceURI === KML_NAMESPACE && ["Document", "Folder"].includes(element.localName));
  if (!source) throw kmlError("kml_document_or_folder_required");
  const definitions = source.localName === "Document"
    ? parseDocumentDefinitions(source, report)
    : {styles: [], schemas: []};
  const document = parseContainer(source, "$", 0, counters, report, definitions);
  document.kind = "document";
  document.styles = definitions.styles;
  document.schemas = definitions.schemas;
  document.resources = [];
  const normalizedDocument = normalizePlacesDocument(document);
  const geojson = placesToGeojson(normalizedDocument);
  return {
    schemaVersion: "1.0.0",
    document: normalizedDocument,
    geojson,
    report: finalizeReport(report),
    source: {format: "kml", byteLength}
  };
}

export async function parseKmlFile(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw kmlError("kml_file_required");
  const filename = String(file.name ?? "document.kml");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.kmz$/i.test(filename)) {
    const extracted = extractKmzKml(bytes);
    const parsed = parseKml(strFromU8(extracted.bytes), options);
    const attached = attachKmzResources(parsed.document, bytes, extracted.entry);
    parsed.document = normalizePlacesDocument(attached.document);
    parsed.geojson = placesToGeojson(parsed.document);
    parsed.report = finalizeReport([...parsed.report.entries, ...attached.report]);
    parsed.source = {
      format: "kmz",
      filename,
      entry: extracted.entry,
      compressedBytes: bytes.byteLength,
      kmlBytes: extracted.bytes.byteLength,
      archiveEntries: extracted.archiveEntries,
      archiveUncompressedBytes: extracted.archiveUncompressedBytes,
      preservedResources: parsed.document.resources.length,
      preservedResourceBytes: parsed.document.resources.reduce((sum, resource) => sum + resource.byteLength, 0)
    };
    return parsed;
  }
  if (!/\.kml$/i.test(filename)) throw kmlError("kml_or_kmz_extension_required");
  return parseKml(strFromU8(bytes), options);
}

export function exportKml(document) {
  const normalized = normalizePlacesDocument(document);
  const body = writeContainer(normalized, "Document", 1);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="${KML_NAMESPACE}" xmlns:gx="${GX_NAMESPACE}">\n${body}\n</kml>\n`;
}

export function exportKmz(document) {
  const normalized = normalizePlacesDocument(document);
  const kml = strToU8(exportKml(normalized));
  if (kml.byteLength > KML_PLACES_LIMITS.maximumKmlBytes) throw kmlError("kml_too_large");
  const files = {"doc.kml": [kml, {level: 6}]};
  for (const resource of normalized.resources) files[resource.path] = [bytesFromBase64(resource.dataBase64), {level: 0}];
  const archive = zipSync(files);
  if (archive.byteLength > KML_PLACES_LIMITS.maximumKmzBytes) throw kmlError("kmz_too_large");
  return archive;
}

export function normalizePlacesDocument(value) {
  const counters = {places: 0, positions: 0, ids: new Set()};
  const document = normalizeContainer(value, "document", 0, counters);
  enforceProjectPlacesSize(document);
  return document;
}

export function createPlacesDocument({name = "My Places", description = null} = {}) {
  return normalizePlacesDocument({
    kind: "document",
    id: "opengeo-places",
    name,
    description,
    visibility: true,
    open: true,
    view: null,
    time: null,
    region: null,
    styles: [],
    schemas: [],
    resources: [],
    children: []
  });
}

export function addKmlPlace(document, parentId, value) {
  const draft = structuredClone(normalizePlacesDocument(document));
  const parent = findKmlPlace(draft, parentId ?? draft.id);
  if (!parent || !["document", "folder"].includes(parent.kind)) throw kmlError("places_parent_invalid");
  const requestedId = safeId(value?.id, slugId(value?.name ?? value?.kind ?? "place"));
  const id = uniquePlaceId(requestedId, collectPlaceIds(draft));
  const child = value?.kind === "folder"
    ? {
        kind: "folder",
        id,
        name: value.name,
        description: value.description ?? null,
        visibility: value.visibility !== false,
        open: value.open !== false,
        view: value.view ?? null,
        time: value.time ?? null,
        region: value.region ?? null,
        children: []
      }
    : value?.kind === "placemark" ? {
        kind: "placemark",
        id,
        name: value?.name,
        description: value?.description ?? null,
        visibility: value?.visibility !== false,
        view: value?.view ?? null,
        geometry: value?.geometry ?? null,
        altitudeMode: value?.altitudeMode ?? null,
        extrude: value?.extrude === true,
        tessellate: value?.tessellate === true,
        style: value?.style ?? null,
        styleUrl: value?.styleUrl ?? null,
        extendedData: value?.extendedData ?? {},
        schemaData: value?.schemaData ?? [],
        time: value?.time ?? null,
        region: value?.region ?? null
      }
    : {
        ...structuredClone(value),
        kind: value?.kind,
        id,
        name: value?.name,
        description: value?.description ?? null,
        visibility: value?.visibility !== false,
        view: value?.view ?? null,
        time: value?.time ?? null,
        region: value?.region ?? null,
        extendedData: value?.extendedData ?? {}
      };
  parent.children.push(child);
  return normalizePlacesDocument(draft);
}

export function updateKmlPlace(document, placeId, patch) {
  const draft = structuredClone(normalizePlacesDocument(document));
  const place = findKmlPlace(draft, placeId);
  if (!place) throw kmlError("place_not_found");
  const allowed = place.kind === "placemark"
    ? ["name", "description", "visibility", "view", "geometry", "altitudeMode", "extrude", "tessellate", "style", "styleUrl", "extendedData", "schemaData", "time", "region"]
    : place.kind === "folder" || place.kind === "document"
      ? ["name", "description", "visibility", "open", "view", "time", "region"]
      : place.kind === "network-link"
        ? ["name", "description", "visibility", "open", "view", "time", "style", "styleUrl", "region", "extendedData", "refreshVisibility", "flyToView", "link"]
        : ["name", "description", "visibility", "view", "time", "region", "extendedData", "color", "drawOrder", "icon", "altitude", "altitudeMode", "box", "quad", "rotation", "overlayXY", "screenXY", "rotationXY", "size", "viewVolume", "imagePyramid", "point", "shape"];
  for (const key of allowed) if (Object.hasOwn(patch ?? {}, key)) place[key] = structuredClone(patch[key]);
  return normalizePlacesDocument(draft);
}

export function removeKmlPlace(document, placeId) {
  const draft = structuredClone(normalizePlacesDocument(document));
  if (draft.id === placeId) throw kmlError("places_document_remove_rejected");
  const located = findPlaceParent(draft, placeId);
  if (!located) throw kmlError("place_not_found");
  located.parent.children.splice(located.index, 1);
  return normalizePlacesDocument(draft);
}

export function moveKmlPlace(document, placeId, parentId, index = Number.POSITIVE_INFINITY) {
  const draft = structuredClone(normalizePlacesDocument(document));
  if (draft.id === placeId) throw kmlError("places_document_move_rejected");
  const located = findPlaceParent(draft, placeId);
  const target = findKmlPlace(draft, parentId ?? draft.id);
  if (!located) throw kmlError("place_not_found");
  if (!target || !["document", "folder"].includes(target.kind)) throw kmlError("places_parent_invalid");
  if (located.place.kind === "folder" && containsPlaceId(located.place, target.id)) {
    throw kmlError("places_parent_cycle");
  }
  located.parent.children.splice(located.index, 1);
  const insertion = Number.isInteger(index) ? Math.max(0, Math.min(index, target.children.length)) : target.children.length;
  target.children.splice(insertion, 0, located.place);
  return normalizePlacesDocument(draft);
}

export function sortKmlPlaceSiblings(document, parentId, direction = "ascending") {
  if (!["ascending", "descending"].includes(direction)) throw kmlError("places_sort_invalid");
  const draft = structuredClone(normalizePlacesDocument(document));
  const parent = findKmlPlace(draft, parentId ?? draft.id);
  if (!parent || !["document", "folder"].includes(parent.kind)) throw kmlError("places_parent_invalid");
  parent.children.sort((left, right) => {
    const a = left.name.normalize("NFKC").toLowerCase();
    const b = right.name.normalize("NFKC").toLowerCase();
    return (a < b ? -1 : a > b ? 1 : 0) * (direction === "ascending" ? 1 : -1);
  });
  return normalizePlacesDocument(draft);
}

export function parseAuthoringGeometry(type, text) {
  const counters = {positions: 0};
  const positions = parseCoordinates(text, counters);
  if (type === "Point") {
    if (positions.length !== 1) throw kmlError("kml_point_coordinate_required");
    return {type, coordinates: positions[0]};
  }
  if (type === "LineString") {
    if (positions.length < 2) throw kmlError("kml_line_requires_two_positions");
    return {type, coordinates: positions};
  }
  if (type === "Polygon") {
    if (positions.length < 3) throw kmlError("kml_polygon_requires_three_positions");
    const ring = samePosition(positions[0], positions.at(-1)) ? positions : [...positions, [...positions[0]]];
    return {type, coordinates: [ring]};
  }
  throw kmlError("places_geometry_unsupported");
}

export function placesForProject(project) {
  try {
    return project?.kmlPlaces ? normalizePlacesDocument(project.kmlPlaces) : null;
  } catch {
    return null;
  }
}

export function placesForSave(document) {
  return document ? normalizePlacesDocument(document) : null;
}

export function kmlReportForProject(project) {
  try {
    return project?.kmlInterchangeReport
      ? normalizeKmlInterchangeReport(project.kmlInterchangeReport)
      : null;
  } catch {
    return null;
  }
}

export function kmlReportForSave(report) {
  return report ? normalizeKmlInterchangeReport(report) : null;
}

export function placesToGeojson(document) {
  const features = [];
  const documentRegions = document?.region ? [document.region] : [];
  walkPlaces(document?.children ?? [], [], (place, folderPath, inheritedRegions) => {
    const geometry = place.kind === "placemark"
      ? place.geometry
      : place.kind === "ground-overlay"
        ? groundOverlayGeometry(place)
        : place.kind === "photo-overlay" && place.point
          ? {type: "Point", coordinates: place.point}
          : null;
    if (!geometry) return;
    const effectiveStyle = mergeKmlStyles(resolveSharedStyle(document?.styles, place.styleUrl), place.style);
    const presentation = kmlStylePresentation(place, effectiveStyle);
    features.push({
      type: "Feature",
      id: place.id,
      properties: {
        name: place.name,
        description: place.description,
        visibility: place.visibility,
        folderPath,
        altitudeMode: place.altitudeMode,
        extendedData: {...place.extendedData},
        time: place.time ? {...place.time} : null,
        style: place.style ? structuredClone(place.style) : null,
        effectiveStyle: effectiveStyle ? structuredClone(effectiveStyle) : null,
        schemaData: structuredClone(place.schemaData ?? []),
        kmlOverlayKind: place.kind.endsWith?.("-overlay") ? place.kind : null,
        kmlOverlayHref: place.icon?.href ?? null,
        kmlRegions: structuredClone(inheritedRegions),
        kmlRegionActive: true,
        kmlRegionOpacity: 1,
        ...presentation
      },
      geometry: structuredClone(geometry)
    });
  }, documentRegions);
  return {type: "FeatureCollection", features};
}

export function kmlRegionLodPresentation(region, extentPixels) {
  const normalized = normalizeRegion(region);
  if (!normalized) return {active: true, opacity: 1};
  const pixels = Number(extentPixels);
  if (!Number.isFinite(pixels) || pixels < 0) return {active: false, opacity: 0};
  const {minPixels, maxPixels, minFadeExtent, maxFadeExtent} = normalized.lod;
  if (pixels < minPixels || (maxPixels !== -1 && pixels > maxPixels)) return {active: false, opacity: 0};
  let opacity = 1;
  if (minFadeExtent > 0 && pixels < minPixels + minFadeExtent) {
    opacity = Math.min(opacity, (pixels - minPixels) / minFadeExtent);
  }
  if (maxPixels !== -1 && maxFadeExtent > 0 && pixels > maxPixels - maxFadeExtent) {
    opacity = Math.min(opacity, (maxPixels - pixels) / maxFadeExtent);
  }
  return {active: opacity > 0, opacity: Math.max(0, Math.min(1, Math.round(opacity * 1_000_000) / 1_000_000))};
}

function extractKmzKml(bytes) {
  if (bytes.byteLength > KML_PLACES_LIMITS.maximumKmzBytes) throw kmlError("kmz_too_large");
  let archiveEntries = 0;
  let archiveUncompressedBytes = 0;
  let files;
  try {
    files = unzipSync(bytes, {
      filter(info) {
        archiveEntries += 1;
        archiveUncompressedBytes += info.originalSize;
        if (archiveEntries > KML_PLACES_LIMITS.maximumKmzEntries) throw kmlError("kmz_too_many_entries");
        if (archiveUncompressedBytes > KML_PLACES_LIMITS.maximumKmzUncompressedBytes) {
          throw kmlError("kmz_uncompressed_too_large");
        }
        if (unsafeArchivePath(info.name)) throw kmlError("kmz_unsafe_path");
        return /\.kml$/i.test(info.name);
      }
    });
  } catch (error) {
    if (error?.code) throw error;
    throw kmlError("malformed_kmz");
  }
  const candidates = Object.entries(files).filter(([name]) => /\.kml$/i.test(name));
  const selected = candidates.find(([name]) => name.toLowerCase() === "doc.kml")
    ?? (candidates.length === 1 ? candidates[0] : null);
  if (!selected) throw kmlError(candidates.length ? "kmz_ambiguous_kml" : "kmz_kml_missing");
  if (selected[1].byteLength > KML_PLACES_LIMITS.maximumKmlBytes) throw kmlError("kml_too_large");
  return {
    entry: selected[0],
    bytes: selected[1],
    archiveEntries,
    archiveUncompressedBytes
  };
}

function attachKmzResources(document, archiveBytes, kmlEntry) {
  const draft = structuredClone(document);
  const report = [];
  const requested = new Map();
  for (const reference of resourceReferences(draft)) {
    const href = reference.href;
    if (!href || !safeResourceReference(href)) continue;
    const path = resolveKmzResourcePath(kmlEntry, href);
    if (!path || !KML_RESOURCE_MEDIA.has(extension(path))) {
      report.push({path: `$.resources.${href}`, status: "omitted", detail: "Referenced KMZ resource type or path is not in the bounded opaque-image allowlist."});
      continue;
    }
    if (!requested.has(path)) requested.set(path, []);
    requested.get(path).push(reference);
  }
  const allowedPaths = [...requested.keys()].sort().slice(0, KML_PLACES_LIMITS.maximumKmzResources);
  for (const path of [...requested.keys()].sort().slice(KML_PLACES_LIMITS.maximumKmzResources)) {
    report.push({path: `$.resources.${path}`, status: "omitted", detail: "Referenced KMZ resource omitted by the resource-count limit."});
  }
  const allowed = new Set(allowedPaths);
  let archiveEntries = 0;
  let archiveUncompressedBytes = 0;
  let selectedResourceBytes = 0;
  const sizeRejected = new Set();
  let files;
  try {
    files = unzipSync(archiveBytes, {
      filter(info) {
        archiveEntries += 1;
        archiveUncompressedBytes += info.originalSize;
        if (archiveEntries > KML_PLACES_LIMITS.maximumKmzEntries) throw kmlError("kmz_too_many_entries");
        if (archiveUncompressedBytes > KML_PLACES_LIMITS.maximumKmzUncompressedBytes) throw kmlError("kmz_uncompressed_too_large");
        if (unsafeArchivePath(info.name)) throw kmlError("kmz_unsafe_path");
        if (!allowed.has(info.name)) return false;
        if (info.originalSize > KML_PLACES_LIMITS.maximumKmzResourceBytes
          || selectedResourceBytes + info.originalSize > KML_PLACES_LIMITS.maximumKmzResourceTotalBytes) {
          sizeRejected.add(info.name);
          return false;
        }
        selectedResourceBytes += info.originalSize;
        return true;
      }
    });
  } catch (error) {
    if (error?.code) throw error;
    throw kmlError("malformed_kmz");
  }
  const resources = [];
  for (const path of allowedPaths) {
    if (sizeRejected.has(path)) {
      report.push({path: `$.resources.${path}`, status: "omitted", detail: "Referenced KMZ resource omitted by the per-resource or total byte limit."});
      continue;
    }
    const bytes = files[path];
    if (!bytes) {
      report.push({path: `$.resources.${path}`, status: "omitted", detail: "Referenced KMZ resource is missing from the archive."});
      continue;
    }
    const mediaType = KML_RESOURCE_MEDIA.get(extension(path));
    resources.push({path, mediaType, byteLength: bytes.byteLength, dataBase64: base64FromBytes(bytes)});
    for (const reference of requested.get(path)) reference.href = path;
    report.push({path: `$.resources.${path}`, status: "preserved", detail: `Preserved ${bytes.byteLength} bounded local ${mediaType} bytes without network fetching.`});
  }
  draft.resources = resources;
  return {document: draft, report};
}

function resourceReferences(document) {
  const output = [];
  for (const definition of document.styles ?? []) {
    if (definition.kind === "Style" && definition.style?.icon) output.push(definition.style.icon);
    if (definition.kind === "StyleMap") for (const pair of definition.pairs) if (pair.style?.icon) output.push(pair.style.icon);
  }
  walkPlaces(document.children ?? [], [], (place) => {
    if (place.kind === "placemark" && place.style?.icon) output.push(place.style.icon);
    if (place.kind.endsWith?.("-overlay") && place.icon) output.push(place.icon);
  });
  return output;
}

function resolveKmzResourcePath(kmlEntry, href) {
  if (!safeResourceReference(href)) return null;
  const base = kmlEntry.split("/").slice(0, -1);
  const parts = [...base, ...href.split("/")].filter((part) => part && part !== ".");
  const path = parts.join("/");
  return unsafeArchivePath(path) ? null : path;
}

function parseDocumentDefinitions(element, report) {
  const styles = [];
  const schemas = [];
  const styleElements = directChildren(element).filter((child) => (
    child.namespaceURI === KML_NAMESPACE && ["Style", "StyleMap"].includes(child.localName)
  ));
  if (styleElements.length > KML_PLACES_LIMITS.maximumSharedStyles) throw kmlError("kml_too_many_shared_styles");
  for (const [index, styleElement] of styleElements.entries()) {
    const id = definitionId(styleElement, `$.styles[${index}]`, report);
    if (!id) continue;
    if (styleElement.localName === "Style") {
      styles.push({kind: "Style", id, style: parseStyle(styleElement, `$.styles[${index}].style`, report)});
      continue;
    }
    reportUnsupportedChildren(styleElement, new Set(["Pair"]), `$.styles[${index}]`, report);
    const pairElements = directChildren(styleElement, "Pair");
    if (pairElements.length > KML_PLACES_LIMITS.maximumStyleMapPairs) throw kmlError("kml_style_map_too_wide");
    const pairs = [];
    for (const [pairIndex, pair] of pairElements.entries()) {
      reportUnsupportedChildren(pair, new Set(["key", "styleUrl", "Style"]), `$.styles[${index}].pairs[${pairIndex}]`, report);
      const key = boundedOptionalText(directText(pair, "key"));
      if (!key || !["normal", "highlight"].includes(key) || pairs.some((item) => item.key === key)) {
        report.push({path: `$.styles[${index}].pairs[${pairIndex}]`, status: "omitted", detail: "StyleMap Pair requires a unique normal or highlight key."});
        continue;
      }
      const styleUrl = boundedOptionalText(directText(pair, "styleUrl"));
      const inline = parseStyle(directChild(pair, "Style"), `$.styles[${index}].pairs[${pairIndex}].style`, report);
      if (!styleUrl && !inline) {
        report.push({path: `$.styles[${index}].pairs[${pairIndex}]`, status: "omitted", detail: "StyleMap Pair without styleUrl or inline Style omitted."});
        continue;
      }
      if (styleUrl && inline) {
        report.push({path: `$.styles[${index}].pairs[${pairIndex}]`, status: "normalized", detail: "StyleMap Pair contained both styleUrl and Style; inline Style retained."});
      }
      pairs.push({key, styleUrl: inline ? null : styleUrl, style: inline});
    }
    if (pairs.length) styles.push({kind: "StyleMap", id, pairs});
  }

  const schemaElements = directChildren(element, "Schema");
  if (schemaElements.length > KML_PLACES_LIMITS.maximumSchemas) throw kmlError("kml_too_many_schemas");
  for (const [index, schemaElement] of schemaElements.entries()) {
    const id = definitionId(schemaElement, `$.schemas[${index}]`, report);
    if (!id) continue;
    const fieldElements = directChildren(schemaElement, "SimpleField");
    reportUnsupportedChildren(schemaElement, new Set(["SimpleField"]), `$.schemas[${index}]`, report);
    if (fieldElements.length > KML_PLACES_LIMITS.maximumSchemaFields) throw kmlError("kml_schema_too_wide");
    const fields = [];
    for (const [fieldIndex, field] of fieldElements.entries()) {
      reportUnsupportedChildren(field, new Set(["displayName"]), `$.schemas[${index}].fields[${fieldIndex}]`, report);
      const name = boundedOptionalText(field.getAttribute("name"));
      const type = boundedOptionalText(field.getAttribute("type"));
      if (!name || name.length > 160 || !KML_SCHEMA_TYPES.has(type) || fields.some((item) => item.name === name)) {
        report.push({path: `$.schemas[${index}].fields[${fieldIndex}]`, status: "omitted", detail: "Schema field requires a unique bounded name and supported KML scalar type."});
        continue;
      }
      fields.push({name, type, displayName: boundedOptionalText(directText(field, "displayName"))});
    }
    schemas.push({id, name: boundedOptionalText(schemaElement.getAttribute("name")), fields});
  }
  return {styles, schemas};
}

function definitionId(element, path, report) {
  const id = element.getAttribute("id");
  if (typeof id !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(id)) {
    report.push({path, status: "omitted", detail: `${element.localName} without a valid XML id omitted.`});
    return null;
  }
  return id;
}

function parseContainer(element, path, depth, counters, report, definitions) {
  if (depth > KML_PLACES_LIMITS.maximumDepth) throw kmlError("kml_nesting_too_deep");
  const container = {
    kind: element.localName === "Folder" ? "folder" : "document",
    id: uniqueParsedId(element.getAttribute("id"), `${element.localName.toLowerCase()}-${path.replace(/\D+/g, "-")}`, counters),
    name: boundedText(directText(element, "name"), "Untitled places"),
    description: boundedOptionalText(directText(element, "description")),
    visibility: directBoolean(element, "visibility", true),
    open: directBoolean(element, "open", false),
    view: parseView(element, `${path}.view`, report),
    time: parseTime(element, `${path}.time`, report),
    region: parseRegion(element, `${path}.region`, report),
    children: []
  };
  let childIndex = 0;
  for (const child of directChildren(element)) {
    if (child.namespaceURI === KML_NAMESPACE && child.localName === "Folder") {
      counters.places += 1;
      enforcePlaceCount(counters);
      container.children.push(parseContainer(child, `${path}.children[${childIndex}]`, depth + 1, counters, report, definitions));
      childIndex += 1;
    } else if (child.namespaceURI === KML_NAMESPACE && child.localName === "Document") {
      counters.places += 1;
      enforcePlaceCount(counters);
      const nested = parseContainer(child, `${path}.children[${childIndex}]`, depth + 1, counters, report, definitions);
      nested.kind = "folder";
      container.children.push(nested);
      report.push({path: `${path}.children[${childIndex}]`, status: "normalized", detail: "Nested Document normalized to a Places folder."});
      childIndex += 1;
    } else if (child.namespaceURI === KML_NAMESPACE && child.localName === "Placemark") {
      counters.places += 1;
      enforcePlaceCount(counters);
      container.children.push(parsePlacemark(child, `${path}.children[${childIndex}]`, counters, report, definitions));
      childIndex += 1;
    } else if (child.namespaceURI === KML_NAMESPACE && child.localName === "NetworkLink") {
      counters.places += 1;
      enforcePlaceCount(counters);
      const networkLink = parseNetworkLink(child, `${path}.children[${childIndex}]`, counters, report, definitions);
      if (networkLink) container.children.push(networkLink);
      childIndex += 1;
    } else if (child.namespaceURI === KML_NAMESPACE && OVERLAY_ELEMENTS.has(child.localName)) {
      counters.places += 1;
      enforcePlaceCount(counters);
      const overlay = parseOverlay(child, `${path}.children[${childIndex}]`, counters, report, definitions);
      if (overlay) container.children.push(overlay);
      childIndex += 1;
    } else if ((child.namespaceURI === KML_NAMESPACE && OMITTED_FEATURES.has(child.localName)) || child.namespaceURI === GX_NAMESPACE) {
      report.push({path: `${path}.${child.localName}`, status: "omitted", detail: `${child.localName} is not implemented in this bounded increment.`});
    } else if (depth === 0 && child.namespaceURI === KML_NAMESPACE && ["Style", "StyleMap", "Schema"].includes(child.localName)) {
      continue;
    } else if (child.namespaceURI !== KML_NAMESPACE || !CONTAINER_PRESERVED_CHILDREN.has(child.localName)) {
      report.push({path: `${path}.${child.localName}`, status: "omitted", detail: `${child.localName} container semantics are not implemented in this bounded increment.`});
    }
  }
  return container;
}

function parseNetworkLink(element, path, counters, report, definitions) {
  const linkElements = directChildren(element).filter((child) => child.namespaceURI === KML_NAMESPACE && ["Link", "Url"].includes(child.localName));
  if (!linkElements.length) {
    report.push({path: `${path}.NetworkLink`, status: "omitted", detail: "NetworkLink without Link or legacy Url omitted."});
    return null;
  }
  if (linkElements.length > 1) report.push({path: `${path}.link`, status: "normalized", detail: "Multiple Link/Url elements normalized to the first standard Link."});
  const source = linkElements.find(({localName}) => localName === "Link") ?? linkElements[0];
  if (source.localName === "Url") report.push({path: `${path}.link`, status: "normalized", detail: "Legacy Url normalized to KML 2.2 Link."});
  reportUnsupportedChildren(source, new Set(["href", "refreshMode", "refreshInterval", "viewRefreshMode", "viewRefreshTime", "viewBoundScale", "viewFormat", "httpQuery"]), `${path}.link`, report);
  let link;
  try {
    link = normalizeKmlNetworkLink({
      href: directText(source, "href"),
      refreshMode: boundedOptionalText(directText(source, "refreshMode")) ?? "onChange",
      refreshInterval: finiteOptionalNumber(directText(source, "refreshInterval"), 4, `${path}.link.refreshInterval`),
      viewRefreshMode: boundedOptionalText(directText(source, "viewRefreshMode")) ?? "never",
      viewRefreshTime: finiteOptionalNumber(directText(source, "viewRefreshTime"), 1, `${path}.link.viewRefreshTime`),
      viewBoundScale: finiteOptionalNumber(directText(source, "viewBoundScale"), 1, `${path}.link.viewBoundScale`),
      viewFormat: boundedOptionalText(directText(source, "viewFormat")),
      httpQuery: boundedOptionalText(directText(source, "httpQuery"))
    });
  } catch (error) {
    report.push({path: `${path}.link`, status: "omitted", detail: `Unsafe or invalid NetworkLink omitted (${error?.code ?? "invalid_link"}).`});
    return null;
  }
  const styleUrl = boundedOptionalText(directText(element, "styleUrl"));
  if (styleUrl && !resolveSharedStyle(definitions.styles, styleUrl)) {
    report.push({path: `${path}.styleUrl`, status: "omitted", detail: "External, missing, or cyclic shared style reference retained as text but not resolved."});
  }
  const extended = parseExtendedData(element, `${path}.extendedData`, report, definitions.schemas);
  reportUnsupportedChildren(element, new Set([
    "name", "description", "visibility", "open", "Camera", "LookAt", "TimeStamp", "TimeSpan", "styleUrl", "Style", "Region", "ExtendedData",
    "refreshVisibility", "flyToView", "Link", "Url"
  ]), path, report);
  return {
    kind: "network-link",
    id: uniqueParsedId(element.getAttribute("id"), `network-link-${counters.places}`, counters),
    name: boundedText(directText(element, "name"), `NetworkLink ${counters.places}`),
    description: boundedOptionalText(directText(element, "description")),
    visibility: directBoolean(element, "visibility", true),
    open: directBoolean(element, "open", false),
    view: parseView(element, `${path}.view`, report),
    time: parseTime(element, `${path}.time`, report),
    style: parseStyle(directChild(element, "Style"), `${path}.style`, report),
    styleUrl,
    region: parseRegion(element, `${path}.region`, report),
    extendedData: extended.data,
    refreshVisibility: directBoolean(element, "refreshVisibility", false),
    flyToView: directBoolean(element, "flyToView", false),
    link
  };
}

function parsePlacemark(element, path, counters, report, definitions) {
  const geometryElements = directChildren(element).filter((child) => (
    child.namespaceURI === KML_NAMESPACE && ["Point", "LineString", "Polygon", "MultiGeometry", "Model"].includes(child.localName)
  ));
  let geometry = null;
  let altitudeMode = null;
  if (geometryElements.length) {
    if (geometryElements.length > 1) {
      report.push({path: `${path}.geometry`, status: "normalized", detail: "Multiple direct geometries normalized to a GeometryCollection."});
      geometry = {
        type: "GeometryCollection",
        geometries: geometryElements.map((item, index) => parseGeometry(item, `${path}.geometry[${index}]`, counters, report)).filter(Boolean)
      };
    } else {
      geometry = parseGeometry(geometryElements[0], `${path}.geometry`, counters, report);
    }
    altitudeMode = geometryAltitudeMode(geometryElements[0], `${path}.altitudeMode`, report);
  } else {
    report.push({path: `${path}.geometry`, status: "omitted", detail: "Placemark without a supported geometry retained in the Places tree without a map feature."});
  }
  const styleUrl = boundedOptionalText(directText(element, "styleUrl"));
  if (styleUrl) {
    const resolved = resolveSharedStyle(definitions.styles, styleUrl);
    report.push(resolved
      ? {path: `${path}.styleUrl`, status: "preserved", detail: `Resolved local shared style ${styleUrl}.`}
      : {path: `${path}.styleUrl`, status: "omitted", detail: "External, missing, or cyclic shared style reference retained as text but not resolved."});
  }
  const extended = parseExtendedData(element, `${path}.extendedData`, report, definitions.schemas);
  for (const child of directChildren(element)) {
    if ((child.namespaceURI === KML_NAMESPACE && !PLACEMARK_PRESERVED_CHILDREN.has(child.localName))
      || (child.namespaceURI === GX_NAMESPACE && !/Track$/.test(child.localName))
      || (child.namespaceURI !== KML_NAMESPACE && child.namespaceURI !== GX_NAMESPACE)) {
      report.push({path: `${path}.${child.localName}`, status: "omitted", detail: `${child.localName} Placemark semantics are not implemented in this bounded increment.`});
    }
  }
  return {
    kind: "placemark",
    id: uniqueParsedId(element.getAttribute("id"), `placemark-${counters.places}`, counters),
    name: boundedText(directText(element, "name"), `Placemark ${counters.places}`),
    description: boundedOptionalText(directText(element, "description")),
    visibility: directBoolean(element, "visibility", true),
    view: parseView(element, `${path}.view`, report),
    geometry,
    altitudeMode,
    extrude: directBoolean(geometryElements[0], "extrude", false),
    tessellate: directBoolean(geometryElements[0], "tessellate", false),
    style: parseStyle(directChild(element, "Style"), `${path}.style`, report),
    styleUrl,
    extendedData: extended.data,
    schemaData: extended.schemaData,
    time: parseTime(element, `${path}.time`, report),
    region: parseRegion(element, `${path}.region`, report)
  };
}

function parseOverlay(element, path, counters, report, definitions) {
  const kind = OVERLAY_ELEMENTS.get(element.localName);
  const iconElement = directChild(element, "Icon");
  reportUnsupportedChildren(iconElement, new Set(["href"]), `${path}.icon`, report);
  const href = boundedOptionalText(directText(iconElement, "href"));
  if (href && !safeResourceReference(href)) {
    report.push({path: `${path}.icon.href`, status: "omitted", detail: "Unsafe or remote overlay reference is retained as inert text and never fetched."});
  }
  const extended = parseExtendedData(element, `${path}.extendedData`, report, definitions.schemas);
  const common = {
    kind,
    id: uniqueParsedId(element.getAttribute("id"), `${kind}-${counters.places}`, counters),
    name: boundedText(directText(element, "name"), `${element.localName} ${counters.places}`),
    description: boundedOptionalText(directText(element, "description")),
    visibility: directBoolean(element, "visibility", true),
    view: parseView(element, `${path}.view`, report),
    time: parseTime(element, `${path}.time`, report),
    region: parseRegion(element, `${path}.region`, report),
    extendedData: extended.data,
    color: boundedOptionalText(directText(element, "color")) ?? "ffffffff",
    drawOrder: finiteOptionalNumber(directText(element, "drawOrder"), 0, `${path}.drawOrder`),
    icon: href ? {href} : null
  };
  const featureChildren = new Set(["name", "description", "visibility", "open", "Camera", "LookAt", "TimeStamp", "TimeSpan", "Region", "ExtendedData", "color", "drawOrder", "Icon"]);
  if (kind === "ground-overlay") {
    reportUnsupportedOverlayChildren(element, new Set([...featureChildren, "altitude", "altitudeMode", "LatLonBox"]), new Set(["LatLonQuad"]), path, report);
    const box = parseLatLonBox(directChild(element, "LatLonBox"), `${path}.box`);
    const quadElement = directChildren(element).find((child) => child.namespaceURI === GX_NAMESPACE && child.localName === "LatLonQuad");
    const quad = parseLatLonQuad(quadElement, `${path}.quad`, counters);
    if (box && quad) report.push({path, status: "normalized", detail: "GroundOverlay contained both LatLonBox and gx:LatLonQuad; gx:LatLonQuad retained."});
    if (!box && !quad) {
      report.push({path: `${path}.GroundOverlay`, status: "omitted", detail: "GroundOverlay without LatLonBox or gx:LatLonQuad omitted."});
      return null;
    }
    return {
      ...common,
      altitude: finiteOptionalNumber(directText(element, "altitude"), 0, `${path}.altitude`),
      altitudeMode: geometryAltitudeMode(element, `${path}.altitudeMode`, report),
      box: quad ? null : box,
      quad
    };
  }
  if (kind === "screen-overlay") {
    reportUnsupportedChildren(element, new Set([...featureChildren, "rotation", "overlayXY", "screenXY", "rotationXY", "size"]), path, report);
    return {
      ...common,
      rotation: finiteOptionalNumber(directText(element, "rotation"), 0, `${path}.rotation`),
      overlayXY: parseVec2(directChild(element, "overlayXY"), {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
      screenXY: parseVec2(directChild(element, "screenXY"), {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
      rotationXY: parseVec2(directChild(element, "rotationXY"), {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
      size: parseVec2(directChild(element, "size"), {x: -1, y: -1, xunits: "pixels", yunits: "pixels"}, {size: true})
    };
  }
  reportUnsupportedChildren(element, new Set([...featureChildren, "rotation", "ViewVolume", "ImagePyramid", "Point", "shape"]), path, report);
  const pointElement = directChild(element, "Point");
  const point = pointElement ? parseCoordinates(directText(pointElement, "coordinates"), counters) : [];
  if (point.length !== 1) {
    report.push({path: `${path}.PhotoOverlay`, status: "omitted", detail: "PhotoOverlay without exactly one Point coordinate omitted."});
    return null;
  }
  report.push({path, status: "normalized", detail: "PhotoOverlay is preserved with a bounded static preview anchor; immersive projection is not claimed."});
  return {
    ...common,
    rotation: finiteOptionalNumber(directText(element, "rotation"), 0, `${path}.rotation`),
    viewVolume: parseViewVolume(directChild(element, "ViewVolume"), `${path}.viewVolume`),
    imagePyramid: parseImagePyramid(directChild(element, "ImagePyramid"), `${path}.imagePyramid`),
    point: point[0],
    shape: boundedOptionalText(directText(element, "shape")) ?? "rectangle"
  };
}

function parseRegion(element, path, report) {
  const region = directChild(element, "Region");
  if (!region) return null;
  reportUnsupportedChildren(region, new Set(["LatLonAltBox", "Lod"]), path, report);
  const boxElement = directChild(region, "LatLonAltBox");
  if (!boxElement) throw kmlError("kml_region_box_required");
  reportUnsupportedChildren(boxElement, new Set(["north", "south", "east", "west", "minAltitude", "maxAltitude", "altitudeMode"]), `${path}.box`, report);
  const lodElement = directChild(region, "Lod");
  if (lodElement) reportUnsupportedChildren(lodElement, new Set(["minLodPixels", "maxLodPixels", "minFadeExtent", "maxFadeExtent"]), `${path}.lod`, report);
  return normalizeRegion({
    box: {
      north: requiredFiniteNumber(directText(boxElement, "north"), `${path}.box.north`),
      south: requiredFiniteNumber(directText(boxElement, "south"), `${path}.box.south`),
      east: requiredFiniteNumber(directText(boxElement, "east"), `${path}.box.east`),
      west: requiredFiniteNumber(directText(boxElement, "west"), `${path}.box.west`),
      minAltitude: finiteOptionalNumber(directText(boxElement, "minAltitude"), 0, `${path}.box.minAltitude`),
      maxAltitude: finiteOptionalNumber(directText(boxElement, "maxAltitude"), 0, `${path}.box.maxAltitude`),
      altitudeMode: geometryAltitudeMode(boxElement, `${path}.box.altitudeMode`, report)
    },
    lod: {
      minPixels: finiteOptionalNumber(directText(lodElement, "minLodPixels"), 0, `${path}.lod.minPixels`),
      maxPixels: finiteOptionalNumber(directText(lodElement, "maxLodPixels"), -1, `${path}.lod.maxPixels`),
      minFadeExtent: finiteOptionalNumber(directText(lodElement, "minFadeExtent"), 0, `${path}.lod.minFadeExtent`),
      maxFadeExtent: finiteOptionalNumber(directText(lodElement, "maxFadeExtent"), 0, `${path}.lod.maxFadeExtent`)
    }
  });
}

function parseLatLonBox(element, path) {
  if (!element) return null;
  return normalizeLatLonBox({
    north: requiredFiniteNumber(directText(element, "north"), `${path}.north`),
    south: requiredFiniteNumber(directText(element, "south"), `${path}.south`),
    east: requiredFiniteNumber(directText(element, "east"), `${path}.east`),
    west: requiredFiniteNumber(directText(element, "west"), `${path}.west`),
    rotation: finiteOptionalNumber(directText(element, "rotation"), 0, `${path}.rotation`)
  });
}

function parseLatLonQuad(element, path, counters) {
  if (!element) return null;
  const coordinatesElement = directChildren(element).find((child) => child.localName === "coordinates");
  const positions = parseCoordinates(coordinatesElement?.textContent, counters);
  if (positions.length !== 4 || positions.some((position) => position.length !== 2)) throw kmlError("kml_ground_overlay_quad_invalid");
  return positions;
}

function parseVec2(element, fallback, {size = false} = {}) {
  if (!element) return {...fallback};
  const units = new Set(["fraction", "pixels", "insetPixels"]);
  const output = {
    x: requiredFiniteNumber(element.getAttribute("x"), "kml_vec2_x_invalid"),
    y: requiredFiniteNumber(element.getAttribute("y"), "kml_vec2_y_invalid"),
    xunits: element.getAttribute("xunits") || fallback.xunits,
    yunits: element.getAttribute("yunits") || fallback.yunits
  };
  if (!units.has(output.xunits) || !units.has(output.yunits)) throw kmlError("kml_vec2_units_invalid");
  if (!size && ((output.xunits === "fraction" && (output.x < 0 || output.x > 1)) || (output.yunits === "fraction" && (output.y < 0 || output.y > 1)))) {
    throw kmlError("kml_vec2_fraction_invalid");
  }
  if (size && (output.x < -1 || output.y < -1)) throw kmlError("kml_screen_overlay_size_invalid");
  return output;
}

function parseViewVolume(element, path) {
  const source = element;
  return normalizeViewVolume({
    leftFov: finiteOptionalNumber(directText(source, "leftFov"), -20, `${path}.leftFov`),
    rightFov: finiteOptionalNumber(directText(source, "rightFov"), 20, `${path}.rightFov`),
    bottomFov: finiteOptionalNumber(directText(source, "bottomFov"), -20, `${path}.bottomFov`),
    topFov: finiteOptionalNumber(directText(source, "topFov"), 20, `${path}.topFov`),
    near: finiteOptionalNumber(directText(source, "near"), 1, `${path}.near`)
  });
}

function parseImagePyramid(element, path) {
  const source = element;
  return normalizeImagePyramid({
    tileSize: finiteOptionalNumber(directText(source, "tileSize"), 256, `${path}.tileSize`),
    maxWidth: finiteOptionalNumber(directText(source, "maxWidth"), 1, `${path}.maxWidth`),
    maxHeight: finiteOptionalNumber(directText(source, "maxHeight"), 1, `${path}.maxHeight`),
    gridOrigin: boundedOptionalText(directText(source, "gridOrigin")) ?? "lowerLeft"
  });
}

function requiredFiniteNumber(value, path) {
  const text = boundedOptionalText(value);
  if (text === null || !Number.isFinite(Number(text))) throw kmlError(String(path).startsWith("kml_") ? path : "kml_number_required");
  return Number(text);
}

function finiteOptionalNumber(value, fallback, path) {
  const text = boundedOptionalText(value);
  if (text === null) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) throw kmlError(String(path).startsWith("kml_") ? path : "kml_number_invalid");
  return number;
}

function parseGeometry(element, path, counters, report) {
  if (element.localName === "Model") {
    report.push({path, status: "omitted", detail: "Model geometry is retained only as an explicit loss in this increment."});
    return null;
  }
  if (element.localName === "Point") {
    const coordinates = parseCoordinates(directText(element, "coordinates"), counters);
    if (coordinates.length !== 1) throw kmlError("kml_point_coordinate_required");
    return {type: "Point", coordinates: coordinates[0]};
  }
  if (element.localName === "LineString") {
    const coordinates = parseCoordinates(directText(element, "coordinates"), counters);
    if (coordinates.length < 2) throw kmlError("kml_line_requires_two_positions");
    return {type: "LineString", coordinates};
  }
  if (element.localName === "Polygon") {
    const outer = directChild(directChild(element, "outerBoundaryIs"), "LinearRing");
    const shell = parseRing(outer, counters);
    const holes = directChildren(element, "innerBoundaryIs").map((boundary) => (
      parseRing(directChild(boundary, "LinearRing"), counters)
    ));
    return {type: "Polygon", coordinates: [shell, ...holes]};
  }
  if (element.localName === "MultiGeometry") {
    const geometries = directChildren(element)
      .filter((child) => ["Point", "LineString", "Polygon", "MultiGeometry", "Model"].includes(child.localName))
      .map((child, index) => parseGeometry(child, `${path}.geometries[${index}]`, counters, report))
      .filter(Boolean);
    if (!geometries.length) throw kmlError("kml_multigeometry_empty");
    return {type: "GeometryCollection", geometries};
  }
  throw kmlError("kml_geometry_unsupported");
}

function parseRing(element, counters) {
  if (!element) throw kmlError("kml_polygon_ring_required");
  const positions = parseCoordinates(directText(element, "coordinates"), counters);
  if (positions.length < 4 || !samePosition(positions[0], positions.at(-1))) {
    throw kmlError("kml_polygon_ring_invalid");
  }
  return positions;
}

function parseCoordinates(value, counters) {
  const tuples = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const positions = tuples.map((tuple) => {
    const values = tuple.split(",");
    if (values.length < 2 || values.length > 3) throw kmlError("kml_coordinate_invalid");
    const position = values.map(Number);
    if (!position.every(Number.isFinite)
      || position[0] < -180 || position[0] > 180
      || position[1] < -90 || position[1] > 90
      || (position.length === 3 && Math.abs(position[2]) > 10_000_000)) {
      throw kmlError("kml_coordinate_out_of_bounds");
    }
    counters.positions += 1;
    if (counters.positions > KML_PLACES_LIMITS.maximumPositions) throw kmlError("kml_too_many_positions");
    return position;
  });
  return positions;
}

function parseView(element, path, report) {
  const view = directChild(element, "Camera") ?? directChild(element, "LookAt");
  if (!view) return null;
  const fields = view.localName === "Camera"
    ? ["longitude", "latitude", "altitude", "heading", "tilt", "roll"]
    : ["longitude", "latitude", "altitude", "heading", "tilt", "range"];
  const result = {type: view.localName};
  for (const field of fields) {
    const raw = directText(view, field);
    if (raw === null) continue;
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      report.push({path: `${path}.${field}`, status: "omitted", detail: "Non-finite view field omitted."});
      continue;
    }
    result[field] = number;
  }
  result.altitudeMode = geometryAltitudeMode(view, `${path}.altitudeMode`, report);
  return result;
}

function parseStyle(element, path, report) {
  if (!element) return null;
  const style = {};
  const components = [
    ["IconStyle", "icon", ["color", "scale", "heading"], ["Icon"]],
    ["LabelStyle", "label", ["color", "scale"], []],
    ["LineStyle", "line", ["color", "width"], []],
    ["PolyStyle", "polygon", ["color", "fill", "outline"], []],
    ["BalloonStyle", "balloon", ["bgColor", "textColor", "text", "displayMode"], []]
  ];
  reportUnsupportedChildren(element, new Set(components.map(([elementName]) => elementName)), path, report);
  for (const [elementName, key, fields, children] of components) {
    const source = directChild(element, elementName);
    if (!source) continue;
    reportUnsupportedChildren(source, new Set([...fields, ...children]), `${path}.${key}`, report);
    style[key] = {};
    for (const field of fields) {
      const value = boundedOptionalText(directText(source, field));
      if (value !== null) style[key][field] = value;
    }
    if (key === "icon") {
      const icon = directChild(source, "Icon");
      reportUnsupportedChildren(icon, new Set(["href"]), `${path}.icon.Icon`, report);
      const href = boundedOptionalText(directText(icon, "href"));
      if (href) {
        style.icon.href = href;
        if (!safeResourceReference(href)) {
          report.push({path: `${path}.icon.href`, status: "omitted", detail: "Unsafe or remote icon reference is preserved as text but never fetched."});
        }
      }
    }
  }
  return Object.keys(style).length ? normalizeStyle(style) : null;
}

function parseExtendedData(element, path, report, schemas) {
  const extended = directChild(element, "ExtendedData");
  if (!extended) return {data: {}, schemaData: []};
  reportUnsupportedChildren(extended, new Set(["Data", "SchemaData"]), path, report);
  const output = {};
  const data = directChildren(extended, "Data");
  if (data.length > KML_PLACES_LIMITS.maximumExtendedDataFields) throw kmlError("kml_extended_data_too_wide");
  for (const item of data) {
    reportUnsupportedChildren(item, new Set(["value"]), `${path}.Data`, report);
    const name = item.getAttribute("name");
    if (!name || name.length > 160 || Object.hasOwn(output, name)) {
      report.push({path, status: "omitted", detail: "Unnamed, duplicate, or overlong ExtendedData field omitted."});
      continue;
    }
    output[name] = boundedOptionalText(directText(item, "value")) ?? "";
  }
  const typed = [];
  for (const [schemaIndex, schemaData] of directChildren(extended, "SchemaData").entries()) {
    reportUnsupportedChildren(schemaData, new Set(["SimpleData"]), `${path}.SchemaData[${schemaIndex}]`, report);
    const schemaUrl = boundedOptionalText(schemaData.getAttribute("schemaUrl"));
    const schema = schemaUrl?.startsWith("#") ? schemas.find(({id}) => `#${id}` === schemaUrl) : null;
    if (!schema) {
      report.push({path: `${path}.SchemaData[${schemaIndex}]`, status: "omitted", detail: `External or unresolved SchemaData ${schemaUrl ?? ""} omitted.`.trim()});
      continue;
    }
    const simpleData = directChildren(schemaData, "SimpleData");
    if (simpleData.length > KML_PLACES_LIMITS.maximumSchemaFields) throw kmlError("kml_schema_data_too_wide");
    const values = {};
    for (const [fieldIndex, item] of simpleData.entries()) {
      const name = boundedOptionalText(item.getAttribute("name"));
      const field = schema.fields.find((candidate) => candidate.name === name);
      if (!field || Object.hasOwn(values, name)) {
        report.push({path: `${path}.SchemaData[${schemaIndex}].fields[${fieldIndex}]`, status: "omitted", detail: "Unknown, unnamed, or duplicate SimpleData field omitted."});
        continue;
      }
      try {
        values[name] = typedSchemaValue(item.textContent, field.type);
      } catch {
        report.push({path: `${path}.SchemaData[${schemaIndex}].${name}`, status: "omitted", detail: `Invalid ${field.type} SimpleData value omitted.`});
      }
    }
    typed.push({schemaUrl, values});
    report.push({path: `${path}.SchemaData[${schemaIndex}]`, status: "preserved", detail: `Resolved ${Object.keys(values).length} typed fields from ${schemaUrl}.`});
  }
  return {data: output, schemaData: typed};
}

function typedSchemaValue(value, type) {
  const text = boundedOptionalText(value);
  if (text === null) {
    if (type === "string") return "";
    throw kmlError("kml_schema_value_required");
  }
  if (type === "string") return text;
  if (type === "bool") {
    if (["1", "true"].includes(text.toLowerCase())) return true;
    if (["0", "false"].includes(text.toLowerCase())) return false;
    throw kmlError("kml_schema_boolean_invalid");
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw kmlError("kml_schema_number_invalid");
  if (type === "float" && Math.abs(number) > 3.4028235e38) throw kmlError("kml_schema_float_invalid");
  const integerBounds = {
    int: [-2_147_483_648, 2_147_483_647],
    uint: [0, 4_294_967_295],
    short: [-32_768, 32_767],
    ushort: [0, 65_535]
  };
  if (integerBounds[type]) {
    if (!Number.isInteger(number) || number < integerBounds[type][0] || number > integerBounds[type][1]) {
      throw kmlError("kml_schema_integer_invalid");
    }
  }
  return number;
}

function parseTime(element, path, report) {
  const stamp = directChild(element, "TimeStamp");
  if (stamp) return {type: "TimeStamp", when: boundedOptionalText(directText(stamp, "when"))};
  const span = directChild(element, "TimeSpan");
  if (span) return {
    type: "TimeSpan",
    begin: boundedOptionalText(directText(span, "begin")),
    end: boundedOptionalText(directText(span, "end"))
  };
  const gxTime = directChildren(element).find((child) => child.namespaceURI === GX_NAMESPACE && /Track$/.test(child.localName));
  if (gxTime) report.push({path, status: "omitted", detail: `${gxTime.localName} time/track semantics are not implemented in this increment.`});
  return null;
}

function geometryAltitudeMode(element, path, report) {
  if (!element) return null;
  const standardElement = directChildren(element).find((child) => (
    child.localName === "altitudeMode" && child.namespaceURI === KML_NAMESPACE
  ));
  const standard = boundedOptionalText(standardElement?.textContent);
  if (standard) {
    if (STANDARD_ALTITUDE_MODES.has(standard)) return standard;
    report.push({path, status: "omitted", detail: `Unsupported altitudeMode ${standard}.`});
    return null;
  }
  const gx = directChildren(element).find((child) => child.localName === "altitudeMode" && child.namespaceURI === GX_NAMESPACE);
  const value = boundedOptionalText(gx?.textContent);
  if (GX_ALTITUDE_MODES.has(value)) return `gx:${value}`;
  return null;
}

function normalizeContainer(value, kind, depth, counters, definitions = null) {
  if (!value || typeof value !== "object") throw kmlError("places_document_invalid");
  if (depth > KML_PLACES_LIMITS.maximumDepth) throw kmlError("kml_nesting_too_deep");
  const children = Array.isArray(value.children) ? value.children : [];
  const container = {
    kind,
    id: uniqueNormalizedId(value.id, kind, counters),
    name: boundedText(value.name, "Untitled places"),
    description: boundedOptionalText(value.description),
    visibility: value.visibility !== false,
    open: value.open === true,
    view: normalizeView(value.view),
    time: normalizeTime(value.time),
    region: normalizeRegion(value.region),
    children: []
  };
  let activeDefinitions = definitions;
  if (kind === "document" && depth === 0) {
    container.styles = normalizeSharedStyles(value.styles, counters);
    container.schemas = normalizeSchemas(value.schemas, counters);
    container.resources = normalizeKmzResources(value.resources);
    activeDefinitions = {styles: container.styles, schemas: container.schemas};
  }
  container.children = children.map((child) => {
      counters.places += 1;
      enforcePlaceCount(counters);
      return child?.kind === "folder"
        ? normalizeContainer(child, "folder", depth + 1, counters, activeDefinitions)
        : child?.kind === "placemark"
          ? normalizePlacemark(child, counters, activeDefinitions)
          : child?.kind === "network-link"
            ? normalizeNetworkLinkFeature(child, counters, activeDefinitions)
            : normalizeOverlay(child, counters);
    });
  return container;
}

function normalizeNetworkLinkFeature(value, counters, definitions) {
  if (!value || value.kind !== "network-link") throw kmlError("place_kind_invalid");
  return {
    kind: "network-link",
    id: uniqueNormalizedId(value.id, `network-link-${counters.places}`, counters),
    name: boundedText(value.name, `NetworkLink ${counters.places}`),
    description: boundedOptionalText(value.description),
    visibility: value.visibility !== false,
    open: value.open === true,
    view: normalizeView(value.view),
    time: normalizeTime(value.time),
    style: normalizeStyle(value.style),
    styleUrl: boundedOptionalText(value.styleUrl),
    region: normalizeRegion(value.region),
    extendedData: normalizeExtendedData(value.extendedData),
    refreshVisibility: value.refreshVisibility === true,
    flyToView: value.flyToView === true,
    link: normalizeKmlNetworkLink(value.link),
    effectiveStyle: resolveSharedStyle(definitions?.styles ?? [], value.styleUrl)
  };
}

function normalizePlacemark(value, counters, definitions) {
  if (!value || value.kind !== "placemark") throw kmlError("place_kind_invalid");
  const geometry = normalizeGeometry(value.geometry, counters);
  return {
    kind: "placemark",
    id: uniqueNormalizedId(value.id, `placemark-${counters.places}`, counters),
    name: boundedText(value.name, `Placemark ${counters.places}`),
    description: boundedOptionalText(value.description),
    visibility: value.visibility !== false,
    view: normalizeView(value.view),
    geometry,
    altitudeMode: normalizeAltitudeMode(value.altitudeMode),
    extrude: value.extrude === true,
    tessellate: value.tessellate === true,
    style: normalizeStyle(value.style),
    styleUrl: boundedOptionalText(value.styleUrl),
    extendedData: normalizeExtendedData(value.extendedData),
    schemaData: normalizeSchemaData(value.schemaData, definitions?.schemas ?? []),
    time: normalizeTime(value.time),
    region: normalizeRegion(value.region)
  };
}

function normalizeOverlay(value, counters) {
  if (!value || !["ground-overlay", "screen-overlay", "photo-overlay"].includes(value.kind)) throw kmlError("place_kind_invalid");
  const common = {
    kind: value.kind,
    id: uniqueNormalizedId(value.id, `${value.kind}-${counters.places}`, counters),
    name: boundedText(value.name, `Overlay ${counters.places}`),
    description: boundedOptionalText(value.description),
    visibility: value.visibility !== false,
    view: normalizeView(value.view),
    time: normalizeTime(value.time),
    region: normalizeRegion(value.region),
    extendedData: normalizeExtendedData(value.extendedData),
    color: normalizeKmlColor(value.color ?? "ffffffff"),
    drawOrder: boundedInteger(value.drawOrder ?? 0, -10_000, 10_000, "kml_overlay_draw_order_invalid"),
    icon: normalizeOverlayIcon(value.icon)
  };
  if (value.kind === "ground-overlay") {
    const box = value.quad ? null : normalizeLatLonBox(value.box);
    const quad = value.quad === null || value.quad === undefined ? null : normalizeLatLonQuad(value.quad, counters);
    if (!box && !quad) throw kmlError("kml_ground_overlay_extent_required");
    return {
      ...common,
      altitude: boundedNumber(value.altitude ?? 0, -10_000_000, 10_000_000, "kml_overlay_altitude_invalid"),
      altitudeMode: normalizeAltitudeMode(value.altitudeMode),
      box,
      quad
    };
  }
  if (value.kind === "screen-overlay") return {
    ...common,
    rotation: boundedNumber(value.rotation ?? 0, -360, 360, "kml_overlay_rotation_invalid"),
    overlayXY: normalizeVec2(value.overlayXY, {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
    screenXY: normalizeVec2(value.screenXY, {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
    rotationXY: normalizeVec2(value.rotationXY, {x: 0.5, y: 0.5, xunits: "fraction", yunits: "fraction"}),
    size: normalizeVec2(value.size, {x: -1, y: -1, xunits: "pixels", yunits: "pixels"}, {size: true})
  };
  const point = normalizePosition(value.point, counters);
  const shape = boundedOptionalText(value.shape) ?? "rectangle";
  if (!["rectangle", "cylinder", "sphere"].includes(shape)) throw kmlError("kml_photo_overlay_shape_invalid");
  return {
    ...common,
    rotation: boundedNumber(value.rotation ?? 0, -360, 360, "kml_overlay_rotation_invalid"),
    viewVolume: normalizeViewVolume(value.viewVolume),
    imagePyramid: normalizeImagePyramid(value.imagePyramid),
    point,
    shape
  };
}

function normalizeGeometry(geometry, counters) {
  if (geometry === null || geometry === undefined) return null;
  if (!geometry || typeof geometry !== "object") throw kmlError("places_geometry_invalid");
  if (geometry.type === "Point") return {type: "Point", coordinates: normalizePosition(geometry.coordinates, counters)};
  if (geometry.type === "LineString") {
    const coordinates = geometry.coordinates.map((position) => normalizePosition(position, counters));
    if (coordinates.length < 2) throw kmlError("kml_line_requires_two_positions");
    return {type: "LineString", coordinates};
  }
  if (geometry.type === "Polygon") {
    const coordinates = geometry.coordinates.map((ring) => {
      const positions = ring.map((position) => normalizePosition(position, counters));
      if (positions.length < 4 || !samePosition(positions[0], positions.at(-1))) throw kmlError("kml_polygon_ring_invalid");
      return positions;
    });
    if (!coordinates.length) throw kmlError("kml_polygon_ring_required");
    return {type: "Polygon", coordinates};
  }
  if (geometry.type === "GeometryCollection") {
    const geometries = geometry.geometries.map((item) => normalizeGeometry(item, counters)).filter(Boolean);
    if (!geometries.length) throw kmlError("kml_multigeometry_empty");
    return {type: "GeometryCollection", geometries};
  }
  throw kmlError("places_geometry_unsupported");
}

function normalizePosition(position, counters) {
  if (!Array.isArray(position) || position.length < 2 || position.length > 3 || !position.every(Number.isFinite)) {
    throw kmlError("kml_coordinate_invalid");
  }
  if (position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90
    || (position.length === 3 && Math.abs(position[2]) > 10_000_000)) {
    throw kmlError("kml_coordinate_out_of_bounds");
  }
  counters.positions += 1;
  if (counters.positions > KML_PLACES_LIMITS.maximumPositions) throw kmlError("kml_too_many_positions");
  return [...position];
}

function normalizeRegion(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw kmlError("kml_region_invalid");
  const box = value.box;
  if (!box || typeof box !== "object") throw kmlError("kml_region_box_required");
  const north = boundedNumber(box.north, -90, 90, "kml_region_latitude_invalid");
  const south = boundedNumber(box.south, -90, 90, "kml_region_latitude_invalid");
  if (north <= south) throw kmlError("kml_region_latitude_order_invalid");
  const minAltitude = boundedNumber(box.minAltitude ?? 0, -10_000_000, 10_000_000, "kml_region_altitude_invalid");
  const maxAltitude = boundedNumber(box.maxAltitude ?? 0, -10_000_000, 10_000_000, "kml_region_altitude_invalid");
  if (maxAltitude < minAltitude) throw kmlError("kml_region_altitude_order_invalid");
  const lod = value.lod ?? {};
  const minPixels = boundedNumber(lod.minPixels ?? 0, 0, KML_PLACES_LIMITS.maximumLodPixels, "kml_region_lod_invalid");
  const maxPixels = Number(lod.maxPixels ?? -1) === -1
    ? -1
    : boundedNumber(lod.maxPixels, 0, KML_PLACES_LIMITS.maximumLodPixels, "kml_region_lod_invalid");
  if (maxPixels !== -1 && maxPixels < minPixels) throw kmlError("kml_region_lod_order_invalid");
  return {
    box: {
      north,
      south,
      east: boundedNumber(box.east, -180, 180, "kml_region_longitude_invalid"),
      west: boundedNumber(box.west, -180, 180, "kml_region_longitude_invalid"),
      minAltitude,
      maxAltitude,
      altitudeMode: normalizeAltitudeMode(box.altitudeMode)
    },
    lod: {
      minPixels,
      maxPixels,
      minFadeExtent: boundedNumber(lod.minFadeExtent ?? 0, 0, KML_PLACES_LIMITS.maximumLodPixels, "kml_region_fade_invalid"),
      maxFadeExtent: boundedNumber(lod.maxFadeExtent ?? 0, 0, KML_PLACES_LIMITS.maximumLodPixels, "kml_region_fade_invalid")
    }
  };
}

function normalizeLatLonBox(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw kmlError("kml_ground_overlay_box_invalid");
  const north = boundedNumber(value.north, -90, 90, "kml_overlay_latitude_invalid");
  const south = boundedNumber(value.south, -90, 90, "kml_overlay_latitude_invalid");
  if (north <= south) throw kmlError("kml_overlay_latitude_order_invalid");
  return {
    north,
    south,
    east: boundedNumber(value.east, -180, 180, "kml_overlay_longitude_invalid"),
    west: boundedNumber(value.west, -180, 180, "kml_overlay_longitude_invalid"),
    rotation: boundedNumber(value.rotation ?? 0, -180, 180, "kml_overlay_rotation_invalid")
  };
}

function normalizeLatLonQuad(value, counters) {
  if (!Array.isArray(value) || value.length !== 4) throw kmlError("kml_ground_overlay_quad_invalid");
  return value.map((position) => {
    const normalized = normalizePosition(position, counters);
    if (normalized.length !== 2) throw kmlError("kml_ground_overlay_quad_invalid");
    return normalized;
  });
}

function normalizeVec2(value, fallback, {size = false} = {}) {
  const source = value ?? fallback;
  if (!source || typeof source !== "object") throw kmlError("kml_vec2_invalid");
  const units = new Set(["fraction", "pixels", "insetPixels"]);
  const output = {
    x: boundedNumber(source.x, size ? -1 : 0, KML_PLACES_LIMITS.maximumOverlayAxisPixels, "kml_vec2_x_invalid"),
    y: boundedNumber(source.y, size ? -1 : 0, KML_PLACES_LIMITS.maximumOverlayAxisPixels, "kml_vec2_y_invalid"),
    xunits: boundedOptionalText(source.xunits),
    yunits: boundedOptionalText(source.yunits)
  };
  if (!units.has(output.xunits) || !units.has(output.yunits)) throw kmlError("kml_vec2_units_invalid");
  if (!size && ((output.xunits === "fraction" && output.x > 1) || (output.yunits === "fraction" && output.y > 1))) {
    throw kmlError("kml_vec2_fraction_invalid");
  }
  return output;
}

function normalizeViewVolume(value) {
  const source = value ?? {leftFov: -20, rightFov: 20, bottomFov: -20, topFov: 20, near: 1};
  if (!source || typeof source !== "object") throw kmlError("kml_photo_view_volume_invalid");
  const output = {
    leftFov: boundedNumber(source.leftFov ?? -20, -180, 180, "kml_photo_fov_invalid"),
    rightFov: boundedNumber(source.rightFov ?? 20, -180, 180, "kml_photo_fov_invalid"),
    bottomFov: boundedNumber(source.bottomFov ?? -20, -180, 180, "kml_photo_fov_invalid"),
    topFov: boundedNumber(source.topFov ?? 20, -180, 180, "kml_photo_fov_invalid"),
    near: boundedNumber(source.near ?? 1, Number.MIN_VALUE, 10_000_000, "kml_photo_near_invalid")
  };
  if (output.leftFov >= output.rightFov || output.bottomFov >= output.topFov) throw kmlError("kml_photo_fov_order_invalid");
  return output;
}

function normalizeImagePyramid(value) {
  const source = value ?? {tileSize: 256, maxWidth: 1, maxHeight: 1, gridOrigin: "lowerLeft"};
  if (!source || typeof source !== "object") throw kmlError("kml_photo_image_pyramid_invalid");
  const tileSize = boundedInteger(source.tileSize ?? 256, 1, 1024, "kml_photo_tile_size_invalid");
  if ((tileSize & (tileSize - 1)) !== 0) throw kmlError("kml_photo_tile_size_invalid");
  const gridOrigin = boundedOptionalText(source.gridOrigin) ?? "lowerLeft";
  if (!['lowerLeft', 'upperLeft'].includes(gridOrigin)) throw kmlError("kml_photo_grid_origin_invalid");
  return {
    tileSize,
    maxWidth: boundedInteger(source.maxWidth ?? 1, 1, KML_PLACES_LIMITS.maximumOverlayAxisPixels, "kml_photo_axis_invalid"),
    maxHeight: boundedInteger(source.maxHeight ?? 1, 1, KML_PLACES_LIMITS.maximumOverlayAxisPixels, "kml_photo_axis_invalid"),
    gridOrigin
  };
}

function normalizeOverlayIcon(value) {
  if (value === null || value === undefined) return null;
  const href = boundedOptionalText(value?.href);
  if (!href) throw kmlError("kml_overlay_href_invalid");
  return {href};
}

function normalizeKmlColor(value) {
  const color = boundedOptionalText(value) ?? "ffffffff";
  if (!/^[0-9a-fA-F]{8}$/.test(color)) throw kmlError("places_style_color_invalid");
  return color.toLowerCase();
}

function boundedNumber(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw kmlError(code);
  return number;
}

function boundedInteger(value, minimum, maximum, code) {
  const number = boundedNumber(value, minimum, maximum, code);
  if (!Number.isInteger(number)) throw kmlError(code);
  return number;
}

function groundOverlayGeometry(overlay) {
  if (overlay.quad) {
    const [lowerLeft, lowerRight, upperRight, upperLeft] = overlay.quad;
    return {type: "Polygon", coordinates: [[upperLeft, upperRight, lowerRight, lowerLeft, upperLeft]]};
  }
  if (!overlay.box) return null;
  const {north, south, east, west, rotation} = overlay.box;
  const centerLongitude = west <= east ? (west + east) / 2 : ((((west + (east + 360)) / 2) + 540) % 360) - 180;
  const centerLatitude = (north + south) / 2;
  const corners = [[west, north], [east, north], [east, south], [west, south]];
  const rotated = rotation === 0 ? corners : corners.map(([longitude, latitude]) => {
    const radians = rotation * Math.PI / 180;
    let dx = longitude - centerLongitude;
    if (dx > 180) dx -= 360;
    if (dx < -180) dx += 360;
    const dy = latitude - centerLatitude;
    const x = dx * Math.cos(radians) - dy * Math.sin(radians);
    const y = dx * Math.sin(radians) + dy * Math.cos(radians);
    return [((((centerLongitude + x) + 540) % 360) - 180), Math.max(-90, Math.min(90, centerLatitude + y))];
  });
  return {type: "Polygon", coordinates: [[...rotated, rotated[0]]]};
}

function writeContainer(container, tag, depth) {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<${tag}${idAttribute(container.id)}>`];
  lines.push(...writeCommon(container, depth + 1));
  if (container.kind === "document") {
    for (const style of container.styles ?? []) lines.push(writeSharedStyle(style, depth + 1));
  }
  if (container.region) lines.push(writeRegion(container.region, depth + 1));
  if (container.kind === "document") for (const schema of container.schemas ?? []) lines.push(writeSchema(schema, depth + 1));
  for (const child of container.children) {
    lines.push(child.kind === "folder"
      ? writeContainer(child, "Folder", depth + 1)
      : child.kind === "placemark"
        ? writePlacemark(child, depth + 1)
        : child.kind === "network-link"
          ? writeNetworkLink(child, depth + 1)
          : writeOverlay(child, depth + 1));
  }
  lines.push(`${indent}</${tag}>`);
  return lines.join("\n");
}

function writeNetworkLink(networkLink, depth) {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<NetworkLink${idAttribute(networkLink.id)}>`];
  lines.push(...writeCommon(networkLink, depth + 1));
  if (networkLink.styleUrl) lines.push(`${indent}  <styleUrl>${escapeXml(networkLink.styleUrl)}</styleUrl>`);
  if (networkLink.style) lines.push(writeStyle(networkLink.style, depth + 1));
  if (networkLink.region) lines.push(writeRegion(networkLink.region, depth + 1));
  if (Object.keys(networkLink.extendedData).length) lines.push(writeExtendedData(networkLink.extendedData, [], depth + 1));
  lines.push(`${indent}  <refreshVisibility>${networkLink.refreshVisibility ? 1 : 0}</refreshVisibility>`);
  lines.push(`${indent}  <flyToView>${networkLink.flyToView ? 1 : 0}</flyToView>`);
  lines.push(writeNetworkLinkTarget(networkLink.link, depth + 1));
  lines.push(`${indent}</NetworkLink>`);
  return lines.join("\n");
}

function writeNetworkLinkTarget(value, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<Link>`,
    `${indent}  <href>${escapeXml(value.href)}</href>`,
    `${indent}  <refreshMode>${value.refreshMode}</refreshMode>`,
    `${indent}  <refreshInterval>${value.refreshInterval}</refreshInterval>`,
    `${indent}  <viewRefreshMode>${value.viewRefreshMode}</viewRefreshMode>`,
    `${indent}  <viewRefreshTime>${value.viewRefreshTime}</viewRefreshTime>`,
    `${indent}  <viewBoundScale>${value.viewBoundScale}</viewBoundScale>`,
    value.viewFormat ? `${indent}  <viewFormat>${escapeXml(value.viewFormat)}</viewFormat>` : null,
    value.httpQuery ? `${indent}  <httpQuery>${escapeXml(value.httpQuery)}</httpQuery>` : null,
    `${indent}</Link>`
  ].filter(Boolean).join("\n");
}

function writePlacemark(place, depth) {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<Placemark${idAttribute(place.id)}>`];
  lines.push(...writeCommon(place, depth + 1));
  if (place.styleUrl) lines.push(`${"  ".repeat(depth + 1)}<styleUrl>${escapeXml(place.styleUrl)}</styleUrl>`);
  if (place.style) lines.push(writeStyle(place.style, depth + 1));
  if (place.region) lines.push(writeRegion(place.region, depth + 1));
  if (Object.keys(place.extendedData).length || place.schemaData?.length) {
    lines.push(writeExtendedData(place.extendedData, place.schemaData, depth + 1));
  }
  if (place.geometry) lines.push(writeGeometry(place.geometry, place, depth + 1));
  lines.push(`${indent}</Placemark>`);
  return lines.join("\n");
}

function writeCommon(value, depth) {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<name>${escapeXml(value.name)}</name>`];
  lines.push(`${indent}<visibility>${value.visibility ? 1 : 0}</visibility>`);
  if (value.open === true) lines.push(`${indent}<open>1</open>`);
  if (value.description !== null) lines.push(`${indent}<description>${escapeXml(value.description)}</description>`);
  if (value.view) lines.push(writeView(value.view, depth));
  if (value.time) lines.push(writeTime(value.time, depth));
  return lines;
}

function writeOverlay(overlay, depth) {
  const tag = overlay.kind === "ground-overlay" ? "GroundOverlay" : overlay.kind === "screen-overlay" ? "ScreenOverlay" : "PhotoOverlay";
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<${tag}${idAttribute(overlay.id)}>`];
  lines.push(...writeCommon(overlay, depth + 1));
  if (overlay.region) lines.push(writeRegion(overlay.region, depth + 1));
  if (Object.keys(overlay.extendedData).length) lines.push(writeExtendedData(overlay.extendedData, [], depth + 1));
  lines.push(`${indent}  <color>${overlay.color}</color>`);
  lines.push(`${indent}  <drawOrder>${overlay.drawOrder}</drawOrder>`);
  if (overlay.icon) lines.push(`${indent}  <Icon><href>${escapeXml(overlay.icon.href)}</href></Icon>`);
  if (overlay.kind === "ground-overlay") {
    lines.push(`${indent}  <altitude>${overlay.altitude}</altitude>`);
    const altitude = altitudeModeXml(overlay.altitudeMode, depth + 1);
    if (altitude) lines.push(altitude);
    lines.push(overlay.quad ? writeLatLonQuad(overlay.quad, depth + 1) : writeLatLonBox(overlay.box, depth + 1));
  } else if (overlay.kind === "screen-overlay") {
    for (const key of ["overlayXY", "screenXY", "rotationXY", "size"]) lines.push(writeVec2(key, overlay[key], depth + 1));
    lines.push(`${indent}  <rotation>${overlay.rotation}</rotation>`);
  } else {
    lines.push(`${indent}  <rotation>${overlay.rotation}</rotation>`);
    lines.push(writeViewVolume(overlay.viewVolume, depth + 1));
    lines.push(writeImagePyramid(overlay.imagePyramid, depth + 1));
    lines.push(`${indent}  <Point><coordinates>${coordinateText([overlay.point])}</coordinates></Point>`);
    lines.push(`${indent}  <shape>${overlay.shape}</shape>`);
  }
  lines.push(`${indent}</${tag}>`);
  return lines.join("\n");
}

function writeRegion(region, depth) {
  const indent = "  ".repeat(depth);
  const {box, lod} = region;
  return [
    `${indent}<Region>`,
    `${indent}  <LatLonAltBox>`,
    ...["north", "south", "east", "west", "minAltitude", "maxAltitude"].map((field) => `${indent}    <${field}>${box[field]}</${field}>`),
    altitudeModeXml(box.altitudeMode, depth + 2),
    `${indent}  </LatLonAltBox>`,
    `${indent}  <Lod>`,
    `${indent}    <minLodPixels>${lod.minPixels}</minLodPixels>`,
    `${indent}    <maxLodPixels>${lod.maxPixels}</maxLodPixels>`,
    `${indent}    <minFadeExtent>${lod.minFadeExtent}</minFadeExtent>`,
    `${indent}    <maxFadeExtent>${lod.maxFadeExtent}</maxFadeExtent>`,
    `${indent}  </Lod>`,
    `${indent}</Region>`
  ].filter(Boolean).join("\n");
}

function writeLatLonBox(box, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<LatLonBox>`,
    ...["north", "south", "east", "west", "rotation"].map((field) => `${indent}  <${field}>${box[field]}</${field}>`),
    `${indent}</LatLonBox>`
  ].join("\n");
}

function writeLatLonQuad(quad, depth) {
  const indent = "  ".repeat(depth);
  return `${indent}<gx:LatLonQuad><coordinates>${coordinateText(quad)}</coordinates></gx:LatLonQuad>`;
}

function writeVec2(tag, value, depth) {
  const indent = "  ".repeat(depth);
  return `${indent}<${tag} x="${value.x}" y="${value.y}" xunits="${value.xunits}" yunits="${value.yunits}"/>`;
}

function writeViewVolume(value, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<ViewVolume>`,
    ...["leftFov", "rightFov", "bottomFov", "topFov", "near"].map((field) => `${indent}  <${field}>${value[field]}</${field}>`),
    `${indent}</ViewVolume>`
  ].join("\n");
}

function writeImagePyramid(value, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<ImagePyramid>`,
    ...["tileSize", "maxWidth", "maxHeight", "gridOrigin"].map((field) => `${indent}  <${field}>${value[field]}</${field}>`),
    `${indent}</ImagePyramid>`
  ].join("\n");
}

function writeGeometry(geometry, place, depth) {
  const indent = "  ".repeat(depth);
  const controls = [
    place.extrude ? `${indent}  <extrude>1</extrude>` : null,
    place.tessellate ? `${indent}  <tessellate>1</tessellate>` : null,
    altitudeModeXml(place.altitudeMode, depth + 1)
  ].filter(Boolean);
  if (geometry.type === "Point") return [
    `${indent}<Point>`, ...controls,
    `${indent}  <coordinates>${coordinateText([geometry.coordinates])}</coordinates>`,
    `${indent}</Point>`
  ].join("\n");
  if (geometry.type === "LineString") return [
    `${indent}<LineString>`, ...controls,
    `${indent}  <coordinates>${coordinateText(geometry.coordinates)}</coordinates>`,
    `${indent}</LineString>`
  ].join("\n");
  if (geometry.type === "Polygon") {
    const [outer, ...inners] = geometry.coordinates;
    return [
      `${indent}<Polygon>`, ...controls,
      `${indent}  <outerBoundaryIs><LinearRing><coordinates>${coordinateText(outer)}</coordinates></LinearRing></outerBoundaryIs>`,
      ...inners.map((ring) => `${indent}  <innerBoundaryIs><LinearRing><coordinates>${coordinateText(ring)}</coordinates></LinearRing></innerBoundaryIs>`),
      `${indent}</Polygon>`
    ].join("\n");
  }
  return [
    `${indent}<MultiGeometry>`,
    ...geometry.geometries.map((item) => writeGeometry(item, place, depth + 1)),
    `${indent}</MultiGeometry>`
  ].join("\n");
}

function writeView(view, depth) {
  const indent = "  ".repeat(depth);
  const fields = view.type === "Camera"
    ? ["longitude", "latitude", "altitude", "heading", "tilt", "roll"]
    : ["longitude", "latitude", "altitude", "heading", "tilt", "range"];
  return [
    `${indent}<${view.type}>`,
    ...fields.filter((field) => Number.isFinite(view[field])).map((field) => `${indent}  <${field}>${view[field]}</${field}>`),
    altitudeModeXml(view.altitudeMode, depth + 1),
    `${indent}</${view.type}>`
  ].filter(Boolean).join("\n");
}

function writeTime(time, depth) {
  const indent = "  ".repeat(depth);
  if (time.type === "TimeStamp") return `${indent}<TimeStamp><when>${escapeXml(time.when ?? "")}</when></TimeStamp>`;
  return [
    `${indent}<TimeSpan>`,
    time.begin ? `${indent}  <begin>${escapeXml(time.begin)}</begin>` : null,
    time.end ? `${indent}  <end>${escapeXml(time.end)}</end>` : null,
    `${indent}</TimeSpan>`
  ].filter(Boolean).join("\n");
}

function writeStyle(style, depth, id = null) {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}<Style${idAttribute(id)}>`];
  const value = style ?? {};
  for (const [key, tag, fields] of [
    ["icon", "IconStyle", ["color", "scale", "heading"]],
    ["label", "LabelStyle", ["color", "scale"]],
    ["line", "LineStyle", ["color", "width"]],
    ["polygon", "PolyStyle", ["color", "fill", "outline"]],
    ["balloon", "BalloonStyle", ["bgColor", "textColor", "text", "displayMode"]]
  ]) {
    if (!value[key]) continue;
    lines.push(`${indent}  <${tag}>`);
    for (const field of fields) if (value[key][field] !== undefined) {
      lines.push(`${indent}    <${field}>${escapeXml(value[key][field])}</${field}>`);
    }
    if (key === "icon" && value.icon.href) lines.push(`${indent}    <Icon><href>${escapeXml(value.icon.href)}</href></Icon>`);
    lines.push(`${indent}  </${tag}>`);
  }
  lines.push(`${indent}</Style>`);
  return lines.join("\n");
}

function writeSharedStyle(definition, depth) {
  if (definition.kind === "Style") return writeStyle(definition.style, depth, definition.id);
  const indent = "  ".repeat(depth);
  return [
    `${indent}<StyleMap${idAttribute(definition.id)}>` ,
    ...definition.pairs.map((pair) => [
      `${indent}  <Pair>`,
      `${indent}    <key>${pair.key}</key>`,
      pair.styleUrl ? `${indent}    <styleUrl>${escapeXml(pair.styleUrl)}</styleUrl>` : null,
      pair.style ? writeStyle(pair.style, depth + 2) : null,
      `${indent}  </Pair>`
    ].filter(Boolean).join("\n")),
    `${indent}</StyleMap>`
  ].join("\n");
}

function writeSchema(schema, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<Schema${schema.name ? ` name="${escapeXml(schema.name)}"` : ""}${idAttribute(schema.id)}>`,
    ...schema.fields.map((field) => [
      `${indent}  <SimpleField name="${escapeXml(field.name)}" type="${field.type}">`,
      field.displayName ? `${indent}    <displayName>${escapeXml(field.displayName)}</displayName>` : null,
      `${indent}  </SimpleField>`
    ].filter(Boolean).join("\n")),
    `${indent}</Schema>`
  ].join("\n");
}

function writeExtendedData(values, schemaData, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<ExtendedData>`,
    ...Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => (
      `${indent}  <Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`
    )),
    ...(schemaData ?? []).map((item) => [
      `${indent}  <SchemaData schemaUrl="${escapeXml(item.schemaUrl)}">`,
      ...Object.entries(item.values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => (
        `${indent}    <SimpleData name="${escapeXml(name)}">${escapeXml(schemaValueText(value))}</SimpleData>`
      )),
      `${indent}  </SchemaData>`
    ].join("\n")),
    `${indent}</ExtendedData>`
  ].join("\n");
}

function schemaValueText(value) {
  if (value === true) return "1";
  if (value === false) return "0";
  return String(value);
}

function altitudeModeXml(value, depth) {
  if (!value) return null;
  const indent = "  ".repeat(depth);
  if (value.startsWith("gx:")) return `${indent}<gx:altitudeMode>${escapeXml(value.slice(3))}</gx:altitudeMode>`;
  return `${indent}<altitudeMode>${escapeXml(value)}</altitudeMode>`;
}

function normalizeView(value) {
  if (!value) return null;
  if (!value || !["Camera", "LookAt"].includes(value.type)) throw kmlError("places_view_invalid");
  const output = {type: value.type};
  const fields = value.type === "Camera"
    ? ["longitude", "latitude", "altitude", "heading", "tilt", "roll"]
    : ["longitude", "latitude", "altitude", "heading", "tilt", "range"];
  for (const field of fields) if (value[field] !== undefined) {
    const number = Number(value[field]);
    if (!Number.isFinite(number)) throw kmlError("places_view_number_invalid");
    output[field] = number;
  }
  if (output.longitude !== undefined && (output.longitude < -180 || output.longitude > 180)) throw kmlError("places_view_longitude_invalid");
  if (output.latitude !== undefined && (output.latitude < -90 || output.latitude > 90)) throw kmlError("places_view_latitude_invalid");
  if (output.heading !== undefined && Math.abs(output.heading) > 360) throw kmlError("places_view_heading_invalid");
  if (output.roll !== undefined && Math.abs(output.roll) > 180) throw kmlError("places_view_roll_invalid");
  const maximumTilt = value.type === "LookAt" ? 90 : 180;
  if (output.tilt !== undefined && (output.tilt < 0 || output.tilt > maximumTilt)) throw kmlError("places_view_tilt_invalid");
  if (output.range !== undefined && output.range < 0) throw kmlError("places_view_range_invalid");
  output.altitudeMode = normalizeAltitudeMode(value.altitudeMode);
  return output;
}

function normalizeAltitudeMode(value) {
  if (value === null || value === undefined) return null;
  if (STANDARD_ALTITUDE_MODES.has(value) || (String(value).startsWith("gx:") && GX_ALTITUDE_MODES.has(String(value).slice(3)))) return value;
  throw kmlError("places_altitude_mode_invalid");
}

function normalizeExtendedData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > KML_PLACES_LIMITS.maximumExtendedDataFields) throw kmlError("kml_extended_data_too_wide");
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!key || key.length > 160) throw kmlError("kml_extended_data_name_invalid");
    return [key, boundedText(String(item ?? ""), "")];
  }));
}

function normalizeSharedStyles(value, counters) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > KML_PLACES_LIMITS.maximumSharedStyles) throw kmlError("kml_shared_styles_invalid");
  return value.map((item, index) => {
    if (!item || !["Style", "StyleMap"].includes(item.kind)) throw kmlError("kml_shared_style_invalid");
    const id = uniqueNormalizedId(item.id, `style-${index + 1}`, counters);
    if (item.kind === "Style") return {kind: "Style", id, style: normalizeStyle(item.style)};
    if (!Array.isArray(item.pairs) || !item.pairs.length || item.pairs.length > KML_PLACES_LIMITS.maximumStyleMapPairs) {
      throw kmlError("kml_style_map_invalid");
    }
    const keys = new Set();
    const pairs = item.pairs.map((pair) => {
      if (!pair || !["normal", "highlight"].includes(pair.key) || keys.has(pair.key)) throw kmlError("kml_style_map_pair_invalid");
      keys.add(pair.key);
      const styleUrl = boundedOptionalText(pair.styleUrl);
      const style = normalizeStyle(pair.style);
      if ((!styleUrl && !style) || (styleUrl && style)) throw kmlError("kml_style_map_pair_invalid");
      return {key: pair.key, styleUrl, style};
    });
    return {kind: "StyleMap", id, pairs};
  });
}

function normalizeSchemas(value, counters) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > KML_PLACES_LIMITS.maximumSchemas) throw kmlError("kml_schemas_invalid");
  return value.map((schema, index) => {
    if (!schema || typeof schema !== "object" || !Array.isArray(schema.fields)
      || schema.fields.length > KML_PLACES_LIMITS.maximumSchemaFields) throw kmlError("kml_schema_invalid");
    const id = uniqueNormalizedId(schema.id, `schema-${index + 1}`, counters);
    const names = new Set();
    const fields = schema.fields.map((field) => {
      const name = boundedOptionalText(field?.name);
      const type = boundedOptionalText(field?.type);
      if (!name || name.length > 160 || names.has(name) || !KML_SCHEMA_TYPES.has(type)) throw kmlError("kml_schema_field_invalid");
      names.add(name);
      return {name, type, displayName: boundedOptionalText(field.displayName)};
    });
    return {id, name: boundedOptionalText(schema.name), fields};
  });
}

function normalizeSchemaData(value, schemas) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > KML_PLACES_LIMITS.maximumSchemas) throw kmlError("kml_schema_data_invalid");
  const references = new Set();
  return value.map((item) => {
    const schemaUrl = boundedOptionalText(item?.schemaUrl);
    const schema = schemaUrl?.startsWith("#") ? schemas.find(({id}) => `#${id}` === schemaUrl) : null;
    if (!schema || references.has(schemaUrl) || !item.values || typeof item.values !== "object" || Array.isArray(item.values)) {
      throw kmlError("kml_schema_data_invalid");
    }
    references.add(schemaUrl);
    const entries = Object.entries(item.values);
    if (entries.length > KML_PLACES_LIMITS.maximumSchemaFields) throw kmlError("kml_schema_data_too_wide");
    const values = {};
    for (const [name, raw] of entries) {
      const field = schema.fields.find((candidate) => candidate.name === name);
      if (!field) throw kmlError("kml_schema_data_field_invalid");
      values[name] = normalizeTypedSchemaValue(raw, field.type);
    }
    return {schemaUrl, values};
  });
}

function normalizeTypedSchemaValue(value, type) {
  if (type === "string") return boundedText(String(value ?? ""), "");
  if (type === "bool") {
    if (value === true || value === false) return value;
    if (["1", "true"].includes(String(value).toLowerCase())) return true;
    if (["0", "false"].includes(String(value).toLowerCase())) return false;
    throw kmlError("kml_schema_boolean_invalid");
  }
  return typedSchemaValue(String(value), type);
}

function normalizeKmzResources(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > KML_PLACES_LIMITS.maximumKmzResources) throw kmlError("kmz_resources_invalid");
  let total = 0;
  const paths = new Set();
  return value.map((resource) => {
    const path = boundedOptionalText(resource?.path);
    const mediaType = boundedOptionalText(resource?.mediaType);
    const dataBase64 = boundedOptionalText(resource?.dataBase64);
    if (!path || unsafeArchivePath(path) || paths.has(path) || !KML_RESOURCE_MEDIA.has(extension(path))
      || KML_RESOURCE_MEDIA.get(extension(path)) !== mediaType || !dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
      throw kmlError("kmz_resource_invalid");
    }
    const bytes = bytesFromBase64(dataBase64);
    if (bytes.byteLength > KML_PLACES_LIMITS.maximumKmzResourceBytes) throw kmlError("kmz_resource_too_large");
    total += bytes.byteLength;
    if (total > KML_PLACES_LIMITS.maximumKmzResourceTotalBytes) throw kmlError("kmz_resources_too_large");
    if (resource.byteLength !== undefined && Number(resource.byteLength) !== bytes.byteLength) throw kmlError("kmz_resource_size_mismatch");
    paths.add(path);
    return {path, mediaType, byteLength: bytes.byteLength, dataBase64: base64FromBytes(bytes)};
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeStyle(value) {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw kmlError("places_style_invalid");
  const output = {};
  const definitions = {
    icon: {text: ["color"], numbers: ["scale", "heading"]},
    label: {text: ["color"], numbers: ["scale"]},
    line: {text: ["color"], numbers: ["width"]},
    polygon: {text: ["color"], booleans: ["fill", "outline"]},
    balloon: {text: ["bgColor", "textColor", "text", "displayMode"]}
  };
  for (const [key, definition] of Object.entries(definitions)) {
    const source = value[key];
    if (source === undefined || source === null) continue;
    if (typeof source !== "object" || Array.isArray(source)) throw kmlError("places_style_invalid");
    const target = {};
    for (const field of definition.text ?? []) {
      if (source[field] === undefined) continue;
      const text = boundedOptionalText(source[field]);
      if (text !== null) target[field] = text;
    }
    for (const field of definition.numbers ?? []) {
      if (source[field] === undefined) continue;
      const number = Number(source[field]);
      if (!Number.isFinite(number) || Math.abs(number) > 10_000) throw kmlError("places_style_number_invalid");
      target[field] = number;
    }
    for (const field of definition.booleans ?? []) {
      if (source[field] === undefined) continue;
      target[field] = source[field] === true || source[field] === 1 || source[field] === "1" || source[field] === "true";
    }
    if (key === "icon" && source.href !== undefined) target.href = boundedOptionalText(source.href);
    if (Object.keys(target).length) output[key] = target;
  }
  for (const [key, style] of Object.entries(output)) {
    for (const field of ["color", "bgColor", "textColor"]) {
      if (style[field] !== undefined && !/^[0-9a-fA-F]{8}$/.test(style[field])) throw kmlError("places_style_color_invalid");
    }
    if (key === "balloon" && style.displayMode !== undefined && !["default", "hide"].includes(style.displayMode)) {
      throw kmlError("places_balloon_display_mode_invalid");
    }
  }
  return Object.keys(output).length ? output : null;
}

function normalizeTime(value) {
  if (!value) return null;
  if (value.type === "TimeStamp") return {type: "TimeStamp", when: normalizeKmlDate(value.when, true)};
  if (value.type === "TimeSpan") return {
    type: "TimeSpan",
    begin: normalizeKmlDate(value.begin, false),
    end: normalizeKmlDate(value.end, false)
  };
  throw kmlError("places_time_invalid");
}

function normalizeKmlDate(value, required) {
  const text = boundedOptionalText(value);
  if (text === null) {
    if (required) throw kmlError("places_time_value_required");
    return null;
  }
  const zone = "(?:Z|[+-]\\d{2}:\\d{2})?";
  const valid = new RegExp(`^-?\\d{4,}${zone}$`).test(text)
    || new RegExp(`^-?\\d{4,}-\\d{2}${zone}$`).test(text)
    || new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}${zone}$`).test(text)
    || new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?${zone}$`).test(text);
  if (!valid) throw kmlError("places_time_value_invalid");
  return text;
}

function finalizeReport(entries) {
  const counts = {preserved: 0, normalized: 0, omitted: 0};
  for (const entry of entries) counts[entry.status] += 1;
  return {
    result: counts.omitted ? "pass_with_declared_losses" : "pass",
    counts,
    entries
  };
}

function normalizeKmlInterchangeReport(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.entries) || report.entries.length > KML_PLACES_LIMITS.maximumPlaces) {
    throw kmlError("kml_report_invalid");
  }
  const entries = report.entries.map((entry) => {
    if (!entry || !["preserved", "normalized", "omitted"].includes(entry.status)) throw kmlError("kml_report_invalid");
    return {
      path: boundedText(entry.path, "$"),
      status: entry.status,
      detail: boundedText(entry.detail, "No detail")
    };
  });
  return finalizeReport(entries);
}

function walkPlaces(children, folders, callback, regions = []) {
  for (const child of children) {
    const activeRegions = child.region ? [...regions, child.region] : regions;
    callback(child, folders, activeRegions);
    if (child.kind === "folder") walkPlaces(child.children, [...folders, child.name], callback, activeRegions);
  }
}

function resolveSharedStyle(styles, styleUrl, seen = new Set()) {
  if (!Array.isArray(styles) || typeof styleUrl !== "string" || !/^#[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(styleUrl)) return null;
  const id = styleUrl.slice(1);
  if (seen.has(id)) return null;
  const definition = styles.find((item) => item.id === id);
  if (!definition) return null;
  if (definition.kind === "Style") return definition.style ? structuredClone(definition.style) : null;
  const pair = definition.pairs.find(({key}) => key === "normal") ?? definition.pairs[0];
  if (!pair) return null;
  if (pair.style) return structuredClone(pair.style);
  return resolveSharedStyle(styles, pair.styleUrl, new Set([...seen, id]));
}

function mergeKmlStyles(base, override) {
  if (!base && !override) return null;
  const output = {};
  for (const key of ["icon", "label", "line", "polygon", "balloon"]) {
    if (base?.[key] || override?.[key]) output[key] = {...(base?.[key] ?? {}), ...(override?.[key] ?? {})};
  }
  return Object.keys(output).length ? output : null;
}

function kmlStylePresentation(place, effectiveStyle = place.style) {
  if (String(place.kind).endsWith("-overlay") && /^[0-9a-fA-F]{8}$/.test(place.color ?? "")) {
    const color = place.color;
    return {
      kmlColor: `#${color.slice(6, 8)}${color.slice(4, 6)}${color.slice(2, 4)}`,
      kmlOpacity: Math.round((Number.parseInt(color.slice(0, 2), 16) / 255) * 1_000_000) / 1_000_000
    };
  }
  const geometryType = place.geometry?.type;
  const source = geometryType === "Point"
    ? effectiveStyle?.icon
    : geometryType === "Polygon"
      ? effectiveStyle?.polygon
      : effectiveStyle?.line;
  const color = source?.color;
  if (!/^[0-9a-fA-F]{8}$/.test(color ?? "")) return {};
  const alpha = Number.parseInt(color.slice(0, 2), 16) / 255;
  return {
    kmlColor: `#${color.slice(6, 8)}${color.slice(4, 6)}${color.slice(2, 4)}`,
    kmlOpacity: Math.round(alpha * 1_000_000) / 1_000_000,
    ...(Number.isFinite(source?.width) ? {kmlWidth: source.width} : {}),
    ...(Number.isFinite(source?.scale) ? {kmlScale: source.scale} : {})
  };
}

function enforcePlaceCount(counters) {
  if (counters.places > KML_PLACES_LIMITS.maximumPlaces) throw kmlError("kml_too_many_places");
}

function enforceProjectPlacesSize(document) {
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (bytes > KML_PLACES_LIMITS.maximumProjectPlacesBytes) throw kmlError("kml_project_places_too_large");
}

function directChildren(element, localName = null) {
  if (!element) return [];
  return [...element.children].filter((child) => !localName || (child.localName === localName && child.namespaceURI === KML_NAMESPACE));
}

function directChild(element, localName) {
  return directChildren(element, localName)[0] ?? null;
}

function directText(element, localName) {
  const child = directChild(element, localName);
  return child ? child.textContent : null;
}

function reportUnsupportedChildren(element, allowed, path, report) {
  if (!element) return;
  for (const child of directChildren(element)) {
    if (child.namespaceURI !== KML_NAMESPACE || !allowed.has(child.localName)) {
      report.push({
        path: `${path}.${child.localName}`,
        status: "omitted",
        detail: `${child.localName} semantics are outside the bounded KML subset.`
      });
    }
  }
}

function reportUnsupportedOverlayChildren(element, kmlAllowed, gxAllowed, path, report) {
  if (!element) return;
  for (const child of directChildren(element)) {
    const supported = child.namespaceURI === KML_NAMESPACE
      ? kmlAllowed.has(child.localName)
      : child.namespaceURI === GX_NAMESPACE && gxAllowed.has(child.localName);
    if (!supported) report.push({
      path: `${path}.${child.localName}`,
      status: "omitted",
      detail: `${child.localName} semantics are outside the bounded KML subset.`
    });
  }
}

function directBoolean(element, localName, fallback) {
  const value = boundedOptionalText(directText(element, localName));
  if (value === null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function boundedText(value, fallback) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  if (normalized.length > KML_PLACES_LIMITS.maximumTextCharacters) throw kmlError("kml_text_too_long");
  return normalized;
}

function boundedOptionalText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > KML_PLACES_LIMITS.maximumTextCharacters) throw kmlError("kml_text_too_long");
  return normalized;
}

function safeId(value, fallback) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(value)
    ? value
    : String(fallback).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z_]+/, "id-").slice(0, 160);
}

function safeResourceReference(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[A-Za-z0-9._/-]+$/.test(value)
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !value.startsWith("/")
    && !value.split(/[\\/]/).includes("..");
}

function extension(value) {
  return String(value).split(".").at(-1)?.toLowerCase() ?? "";
}

function base64FromBytes(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
}

function bytesFromBase64(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw kmlError("kmz_resource_base64_invalid");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uniqueParsedId(value, fallback, counters) {
  const valid = typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(value);
  const id = safeId(value, fallback);
  if (valid && counters.ids.has(id)) throw kmlError("kml_duplicate_id");
  const unique = valid ? id : uniquePlaceId(id, counters.ids);
  counters.ids.add(unique);
  return unique;
}

function uniqueNormalizedId(value, fallback, counters) {
  const id = safeId(value, fallback);
  if (counters.ids.has(id)) throw kmlError("kml_duplicate_id");
  counters.ids.add(id);
  return id;
}

function slugId(value) {
  return safeId(String(value ?? "place").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-"), "place");
}

function uniquePlaceId(requested, used) {
  if (!used.has(requested)) return requested;
  for (let index = 2; index <= KML_PLACES_LIMITS.maximumPlaces + 1; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${requested.slice(0, 160 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw kmlError("kml_unique_id_unavailable");
}

function collectPlaceIds(document) {
  const ids = new Set([document.id]);
  walkPlaces(document.children, [], (place) => ids.add(place.id));
  return ids;
}

function findKmlPlace(document, id) {
  if (document.id === id) return document;
  for (const child of document.children ?? []) {
    if (child.id === id) return child;
    if (child.kind === "folder") {
      const nested = findKmlPlace(child, id);
      if (nested) return nested;
    }
  }
  return null;
}

function findPlaceParent(container, id) {
  for (const [index, child] of (container.children ?? []).entries()) {
    if (child.id === id) return {parent: container, index, place: child};
    if (child.kind === "folder") {
      const nested = findPlaceParent(child, id);
      if (nested) return nested;
    }
  }
  return null;
}

function containsPlaceId(container, id) {
  return container.id === id || (container.children ?? []).some((child) => (
    child.id === id || (child.kind === "folder" && containsPlaceId(child, id))
  ));
}

function unsafeArchivePath(value) {
  return !value || value.includes("\0") || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..");
}

function samePosition(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function coordinateText(positions) {
  return positions.map((position) => position.join(",")).join(" ");
}

function idAttribute(value) {
  return value ? ` id="${escapeXml(value)}"` : "";
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[character]);
}

function kmlError(code) {
  return Object.assign(new Error(code), {code});
}
