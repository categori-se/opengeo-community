import {normalizePortalConfiguration} from "./portalConfiguration.js";

export const PORTAL_CATALOG_RUNTIME_LIMITS = Object.freeze({
  maximumReferencesPerLayer: 16,
  maximumDisplayedLayers: 256,
  maximumLegendCharacters: 2_048,
  maximumLegendSwatches: 16
});

const REFERENCE_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECT_SOURCE_TYPES = new Set(["xyz", "wms"]);

export function canAddPortalCatalogLayer(layerCount) {
  if (!Number.isInteger(layerCount) || layerCount < 0) {
    throw new TypeError("The current map layer count must be a non-negative integer.");
  }
  return layerCount < PORTAL_CATALOG_RUNTIME_LIMITS.maximumDisplayedLayers;
}

export function analyzePortalCatalog(value, {layers = [], sources = []} = {}) {
  const portal = normalizePortalConfiguration(value);
  const configuredSources = new Map(portal.sources.map((source) => [source.name, source]));
  const flat = [];
  const state = {order: 0};
  const tree = portal.catalog.map((node, index) => analyzeNode({
    node,
    path: [index],
    parents: [],
    configuredSources,
    layers,
    sources,
    flat,
    state
  }));
  const counts = flat.reduce((output, entry) => {
    output.layers += 1;
    output.references += entry.references.length;
    output[entry.compatibility] = (output[entry.compatibility] ?? 0) + 1;
    if (entry.binding.status === "governed") output.governed += 1;
    if (entry.binding.status === "fixture") output.fixture += 1;
    if (entry.binding.status === "invalid") output.invalid += 1;
    if (entry.binding.layer?.visible && entry.binding.status === "governed") output.displayed += 1;
    return output;
  }, {
    layers: 0,
    references: 0,
    direct: 0,
    ingest_required: 0,
    adapter_required: 0,
    unresolved: 0,
    governed: 0,
    fixture: 0,
    invalid: 0,
    displayed: 0
  });
  return {portal, tree, entries: flat, counts};
}

export function portalLayerFromGovernedSource(entry, source) {
  if (entry?.kind !== "layer" || entry.compatibility !== "direct" || !entry.sourceDraft) {
    throw new TypeError("A directly compatible portal catalog layer is required.");
  }
  if (!source || !UUID.test(source.datasetId ?? "") || !Number.isInteger(source.versionNumber)
    || source.versionNumber < 1 || !sourceMatchesDraft(source, entry.sourceDraft)) {
    throw new TypeError("The governed source does not match the portal catalog layer.");
  }
  const configuration = structuredClone(source.configuration);
  const sourceType = source.sourceType === "pmtiles"
    ? `pmtiles-${configuration.tileType}`
    : `${source.sourceType}-raster`;
  const tileUrl = source.sourceType === "wms"
    ? wmsTileUrl(source.sourceUrl, configuration)
    : source.sourceUrl;
  const fixtureSource = source.fixtureSource === true;
  return {
    layerId: portalLayerId(entry.reference, source.datasetId),
    datasetId: source.datasetId,
    title: entry.title,
    sourceType,
    sourceVersion: source.versionNumber,
    sourceUrl: source.sourceUrl,
    sourceConfiguration: configuration,
    sourceLayer: configuration.sourceLayer,
    tileUrl,
    tileSize: configuration.tileSize,
    scheme: configuration.scheme,
    attribution: configuration.attribution,
    minZoom: configuration.minZoom,
    maxZoom: configuration.maxZoom,
    geometryType: configuration.geometryType ?? "Raster",
    portalCatalogSource: entry.reference,
    governedSource: !fixtureSource,
    fixtureSource,
    visible: entry.configuredVisible,
    opacity: 1,
    order: entry.order,
    style: {},
    labels: {enabled: false, field: null}
  };
}

export function portalCatalogSourceRegistration(entry) {
  if (entry?.compatibility !== "direct" || !entry.sourceDraft) {
    throw new TypeError("This portal catalog layer needs a separate governed adapter or ingest workflow.");
  }
  return structuredClone(entry.sourceDraft);
}

function analyzeNode({node, path, parents, configuredSources, layers, sources, flat, state}) {
  if (node.kind === "group") {
    const group = {
      kind: "group",
      key: path.join("."),
      title: node.title,
      expanded: booleanAttribute(node.attributes.expand, false),
      exclusive: node.attributes.multiple === "false",
      children: []
    };
    group.children = node.children.map((child, index) => analyzeNode({
      node: child,
      path: [...path, index],
      parents: [...parents, group],
      configuredSources,
      layers,
      sources,
      flat,
      state
    }));
    return group;
  }

  const reference = node.source ?? "";
  const referenceParts = parseReferences(reference);
  const referenceDetails = referenceParts.map((part) => resolveReference(part, configuredSources));
  const compatibility = referenceCompatibility(referenceDetails);
  const sourceDraft = compatibility === "direct" && referenceDetails.length === 1
    ? registrationDraft(node, referenceDetails[0])
    : null;
  const candidates = sourceDraft
    ? sources.filter((source) => sourceMatchesDraft(source, sourceDraft))
      .sort((left, right) => String(left.datasetId).localeCompare(String(right.datasetId)))
    : [];
  const boundLayers = layers.filter((layer) => layer?.portalCatalogSource === reference);
  const binding = bindingState(boundLayers, sources);
  const configuredVisible = configuredLayerVisibility(node, referenceDetails);
  const entry = {
    kind: "layer",
    key: path.join("."),
    title: node.title,
    reference,
    references: referenceDetails,
    metadata: [...node.metadata],
    attributes: {...node.attributes},
    parents: parents.map(({key, title, exclusive}) => ({key, title, exclusive})),
    exclusiveGroupKey: [...parents].reverse().find(({exclusive}) => exclusive)?.key ?? null,
    order: state.order++,
    configuredVisible,
    legend: catalogLegend(node, referenceDetails),
    compatibility,
    sourceDraft,
    candidates,
    binding
  };
  flat.push(entry);
  return entry;
}

function parseReferences(value) {
  if (typeof value !== "string" || !value) return [];
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (parts.length > PORTAL_CATALOG_RUNTIME_LIMITS.maximumReferencesPerLayer) {
    return [{raw: value, valid: false, code: "reference_limit"}];
  }
  return parts.map((raw) => REFERENCE_PART.test(raw)
    ? {raw, valid: true, sourceName: raw.slice(0, raw.indexOf("/")), layerName: raw.slice(raw.indexOf("/") + 1)}
    : {raw, valid: false, code: "reference_invalid"});
}

function resolveReference(reference, sources) {
  if (!reference.valid) return reference;
  const source = sources.get(reference.sourceName) ?? null;
  if (!source) return {...reference, code: "source_missing", source: null, layer: null};
  const layer = source.element.children.find((child) => child.name === "layer"
    && child.attributes?.name === reference.layerName) ?? null;
  if (!layer) return {...reference, code: "layer_missing", source, layer: null};
  return {...reference, code: "resolved", source, layer};
}

function referenceCompatibility(references) {
  if (!references.length || references.some(({code}) => code !== "resolved")) return "unresolved";
  if (references.length === 1 && DIRECT_SOURCE_TYPES.has(references[0].source.type)) return "direct";
  if (references.every(({source}) => ["geojson", "vector"].includes(source.type))) return "ingest_required";
  return "adapter_required";
}

function registrationDraft(node, reference) {
  const source = reference.source;
  const urls = source.element.children
    .filter(({name, text}) => name === "url" && /^https:\/\//i.test(text))
    .map(({text}) => normalizeEndpoint(text));
  if (!urls.length) return null;
  const attribution = xmlChild(reference.layer, "attribution")?.text
    ? plainLegendText(xmlChild(reference.layer, "attribution").text)
    : null;
  if (source.type === "xyz") {
    return {
      name: node.title,
      description: `Imported from GeoMoose catalog source ${node.source}.`,
      classification: "internal",
      tags: ["xyz", "external-source", "geomoose"],
      source: {
        type: "xyz",
        url: urls[0],
        minZoom: 0,
        maxZoom: 22,
        tileSize: 256,
        scheme: "xyz",
        attribution
      }
    };
  }
  if (source.type === "wms") {
    const parameters = new Map(source.element.children
      .filter(({name}) => name === "param")
      .map(({attributes}) => [String(attributes.name ?? "").toUpperCase(), attributes.value ?? ""]));
    return {
      name: node.title,
      description: `Imported from GeoMoose catalog source ${node.source}.`,
      classification: "internal",
      tags: ["wms", "external-source", "geomoose"],
      source: {
        type: "wms",
        url: urls[0],
        version: "1.3.0",
        layers: [reference.layerName],
        styles: [],
        imageFormat: parameters.get("FORMAT") || "image/png",
        transparent: /^(?:true|1)$/i.test(parameters.get("TRANSPARENT") ?? ""),
        crs: "EPSG:3857",
        tileSize: 256,
        attribution
      }
    };
  }
  return null;
}

function sourceMatchesDraft(source, draft) {
  if (!source || source.sourceType !== draft.source.type) return false;
  if (normalizeEndpoint(source.sourceUrl) !== normalizeEndpoint(draft.source.url)) return false;
  if (source.sourceType === "wms") {
    const configured = source.configuration?.layers;
    return Array.isArray(configured) && configured.join(",") === draft.source.layers.join(",");
  }
  return true;
}

function bindingState(boundLayers, sources) {
  if (boundLayers.length !== 1) {
    return {status: boundLayers.length ? "invalid" : "none", layer: boundLayers[0] ?? null};
  }
  const layer = boundLayers[0];
  if (!UUID.test(layer.datasetId ?? "") || !Number.isInteger(layer.sourceVersion)
    || !["xyz-raster", "wms-raster", "pmtiles-vector", "pmtiles-raster"].includes(layer.sourceType)) {
    return {status: "invalid", layer};
  }
  if (layer.governedSource === true) return {status: "governed", layer};
  if (layer.fixtureSource === true) return {status: "fixture", layer};
  const source = sources.find((candidate) => candidate.datasetId === layer.datasetId);
  if (source && source.versionNumber >= layer.sourceVersion) return {status: "governed", layer};
  return {status: "invalid", layer};
}

function configuredLayerVisibility(node, references) {
  if (node.attributes.status) return booleanStatus(node.attributes.status, true);
  const states = references
    .filter(({code}) => code === "resolved")
    .map(({layer}) => layer.attributes?.status)
    .filter(Boolean);
  return states.length ? states.some((value) => booleanStatus(value, true)) : true;
}

function catalogLegend(node, references) {
  if ([node.attributes.legend, node.attributes["show-legend"]].some((value) => value === "false")) {
    return {kind: "suppressed", text: "Legend hidden by the mapbook configuration.", swatches: []};
  }
  for (const reference of references) {
    if (reference.code !== "resolved") continue;
    const legend = xmlChild(reference.layer, "legend");
    if (legend?.attributes?.type === "nolegend") {
      return {kind: "suppressed", text: "Legend disabled by the source layer.", swatches: []};
    }
    if (legend?.text) {
      return {kind: "configured", text: plainLegendText(legend.text), swatches: styleSwatches(reference.layer)};
    }
  }
  const swatches = references.flatMap(({layer, code}) => code === "resolved" ? styleSwatches(layer) : [])
    .slice(0, PORTAL_CATALOG_RUNTIME_LIMITS.maximumLegendSwatches);
  if (swatches.length) return {kind: "configured", text: node.title, swatches};
  return {
    kind: "deferred",
    text: "No portable legend is configured; a governed service legend can be attached after source resolution.",
    swatches: []
  };
}

function styleSwatches(layer) {
  const style = xmlChild(layer, "style")?.text;
  if (!style) return [];
  let parsed;
  try {
    parsed = JSON.parse(style);
  } catch {
    return [];
  }
  const swatches = [];
  for (const [name, value] of Object.entries(parsed)) {
    const color = firstColor(value);
    if (!color || !/(?:color|fill|stroke)/i.test(name)) continue;
    if (!swatches.some((entry) => entry.color === color)) swatches.push({label: name, color});
    if (swatches.length >= PORTAL_CATALOG_RUNTIME_LIMITS.maximumLegendSwatches) break;
  }
  return swatches;
}

function firstColor(value) {
  if (typeof value === "string" && /^(?:#[0-9a-f]{3,8}|rgba?\([^)]{1,80}\))$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const color = firstColor(child);
      if (color) return color;
    }
  }
  return null;
}

function plainLegendText(value) {
  return String(value)
    .replace(/<[^>]{0,500}>/g, " ")
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PORTAL_CATALOG_RUNTIME_LIMITS.maximumLegendCharacters);
}

function xmlChild(node, name) {
  return node?.children?.find((child) => child.name === name) ?? null;
}

function booleanStatus(value, fallback) {
  if (/^(?:on|true|1)$/i.test(value)) return true;
  if (/^(?:off|false|0)$/i.test(value)) return false;
  return fallback;
}

function booleanAttribute(value, fallback) {
  return value === undefined ? fallback : booleanStatus(value, fallback);
}

function normalizeEndpoint(value) {
  if (typeof value !== "string") return "";
  const decodedTemplate = value
    .replace(/%7bz%7d/gi, "{z}")
    .replace(/%7bx%7d/gi, "{x}")
    .replace(/%7by%7d/gi, "{y}");
  return decodedTemplate.endsWith("?") ? decodedTemplate.slice(0, -1) : decodedTemplate;
}

function portalLayerId(reference, datasetId) {
  const stem = reference.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "layer";
  return `portal:${stem}:${datasetId.slice(0, 8)}`;
}

function wmsTileUrl(endpoint, configuration) {
  const parameters = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: configuration.version,
    LAYERS: configuration.layers.join(","),
    STYLES: configuration.styles.join(","),
    FORMAT: configuration.imageFormat,
    TRANSPARENT: configuration.transparent ? "TRUE" : "FALSE",
    WIDTH: String(configuration.tileSize),
    HEIGHT: String(configuration.tileSize),
    BBOX: "{bbox-epsg-3857}",
    [configuration.version === "1.3.0" ? "CRS" : "SRS"]: configuration.crs
  });
  const separator = endpoint.includes("?") ? (endpoint.endsWith("&") ? "" : "&") : "?";
  return `${endpoint}${separator}${parameters}`.replaceAll("%7B", "{").replaceAll("%7D", "}");
}
