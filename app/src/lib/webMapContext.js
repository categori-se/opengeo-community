import {emptyMapDefinition} from "./mapDefinition.js";

const WMC_NAMESPACE = "http://www.opengis.net/context";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const WMC_VERSION = "1.1.0";
const MAX_WMC_BYTES = 256 * 1024;
const MAX_LAYERS = 64;
const MAX_XML_NODES = 4_096;
const MAX_XML_ATTRIBUTES = 16_384;
const MAX_XML_DEPTH = 24;
const MAX_TEXT_CHARACTERS = 128 * 1024;
const MAX_LIST_VALUES = 32;
const MAX_URL_CHARACTERS = 2_048;
const SENSITIVE_QUERY = /(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|signature|authorization|credential|client[-_]?secret|private[-_]?key)/i;
const WEB_MERCATOR_NAMES = new Set(["EPSG:3857", "EPSG:900913", "EPSG:102100", "EPSG:102113"]);
const GEOGRAPHIC_NAMES = new Set(["EPSG:4326", "CRS:84", "OGC:CRS84"]);
const SUPPORTED_IMAGE_FORMATS = new Set(["image/png", "image/jpeg", "image/webp"]);
const GOVERNED_IMAGE_FORMATS = new Set(["image/png", "image/jpeg"]);
const GOVERNED_WMS_VERSIONS = new Set(["1.1.1", "1.3.0"]);
const OGC_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
const OPENGEO_RELEASE = Object.freeze({product: "opengeo", version: "0.1.0", commit: null});
const WMC_RELEASE = Object.freeze({
  product: "ogc-web-map-context",
  version: WMC_VERSION,
  documents: ["OGC 05-005", "OGC 08-050"],
  schema: "https://schemas.opengis.net/context/1.1.0/context.xsd"
});

export const WEB_MAP_CONTEXT_LIMITS = Object.freeze({
  maximumBytes: MAX_WMC_BYTES,
  maximumLayers: MAX_LAYERS,
  maximumXmlNodes: MAX_XML_NODES,
  maximumXmlAttributes: MAX_XML_ATTRIBUTES,
  maximumXmlDepth: MAX_XML_DEPTH,
  maximumTextCharacters: MAX_TEXT_CHARACTERS,
  maximumListValues: MAX_LIST_VALUES,
  networkAccessDuringConversion: "disabled",
  activeXml: "rejected"
});

export function importWebMapContext(text, {DOMParser: Parser = globalThis.DOMParser} = {}) {
  if (typeof text !== "string") throw wmcError("wmc_text_required");
  const sourceBytes = byteLength(text);
  if (sourceBytes > MAX_WMC_BYTES) throw wmcError("wmc_too_large");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw wmcError("active_xml_rejected");
  if (typeof Parser !== "function") throw wmcError("dom_parser_unavailable");
  const xml = new Parser().parseFromString(text, "application/xml");
  if (xml.querySelector?.("parsererror") || xml.documentElement?.localName === "parsererror") {
    throw wmcError("malformed_wmc");
  }
  const root = xml.documentElement;
  if (root?.localName !== "ViewContext" || root.namespaceURI !== WMC_NAMESPACE) {
    throw wmcError("wmc_1_1_view_context_required");
  }
  if (root.getAttribute("version") !== WMC_VERSION) throw wmcError("wmc_1_1_required");
  scanXml(root);

  const report = createReport("import", WMC_RELEASE, OPENGEO_RELEASE);
  const general = requiredSingleChild(root, "General", "wmc_general_required");
  const layerList = requiredSingleChild(root, "LayerList", "wmc_layer_list_required");
  const id = boundedIdentifier(root.getAttribute("id"), "wmc_id_invalid");
  const title = requiredText(requiredSingleChild(general, "Title", "wmc_title_required"), 240, "wmc_title_invalid");
  const description = optionalText(directChild(general, "Abstract"), 4_096);
  const window = parseWindow(directChild(general, "Window"));
  const bounds = parseBounds(requiredSingleChild(general, "BoundingBox", "wmc_bounding_box_required"));
  const keywords = directChild(general, "KeywordList")
    ? directChildren(directChild(general, "KeywordList"), "Keyword")
      .slice(0, MAX_LIST_VALUES)
      .map((element) => requiredText(element, 160, "wmc_keyword_invalid"))
    : [];
  const generalExtension = directChild(general, "Extension");

  addField(report, "$.ViewContext.@id", "mapped", "Context identity mapped to the portable WMC extension.", "$.definition.extensions.wmc.contextId");
  addField(report, "$.ViewContext.General.Title", "mapped", "Context title mapped to the OpenGeo Studio project name.", "$.map.name");
  addField(report, "$.ViewContext.General.BoundingBox", "mapped", "Context extent and CRS mapped to the primary map view and retained exactly in the WMC extension.", "$.definition.mapViews[0]");
  if (window) addField(report, "$.ViewContext.General.Window", "preserved_extension", "Suggested client dimensions remain in the WMC extension.", "$.definition.extensions.wmc.window");
  if (keywords.length) addField(report, "$.ViewContext.General.KeywordList", "mapped", "Context keywords mapped to structured project metadata.", "$.definition.metadata.keywords");
  if (generalExtension) addField(report, "$.ViewContext.General.Extension", "preserved_extension", "General WMC extension XML remains inert and is never executed.", "$.definition.extensions.wmc.generalExtension");

  const sourceLayers = directChildren(layerList, "Layer");
  if (!sourceLayers.length) throw wmcError("wmc_layer_required");
  if (sourceLayers.length > MAX_LAYERS) throw wmcError("wmc_layer_limit");
  const converted = sourceLayers.map((element, index) => parseLayer(element, index, report));
  const layers = converted
    .filter(({layer}) => layer)
    .map(({layer}) => layer)
    .reverse()
    .map((layer, order) => ({...layer, order}));
  const externalSources = converted
    .filter(({registration}) => registration)
    .map(({registration}) => registration);
  const layerExtensions = converted.map(({extension}) => extension);
  const view = mapViewFromBounds(bounds, window);
  const metadata = {
    standard: "OGC Web Map Context 1.1.0",
    keywords,
    sourceCrs: bounds.crs
  };
  const definition = emptyMapDefinition({
    mapViews: [view],
    activeLayerId: layers.find(({visible}) => visible)?.layerId ?? layers[0]?.layerId ?? null,
    layers,
    metadata,
    extensions: {
      wmc: {
        schemaVersion: "1.0.0",
        upstream: structuredClone(WMC_RELEASE),
        contextId: id,
        bounds,
        window,
        generalExtension: generalExtension ? serializeInertElement(generalExtension) : null,
        layers: layerExtensions
      }
    }
  });
  addField(report, "$.ViewContext.LayerList", "mapped", `${layers.length} directly usable or inspectable WMS layer records mapped in bottom-to-top order without network access.`, "$.definition.layers");
  if (layers.length !== sourceLayers.length) {
    addField(report, "$.ViewContext.LayerList", "unsupported", `${sourceLayers.length - layers.length} layer records remain only in the WMC extension because they are not bounded WMS references.`);
  }
  finishReport(report);
  return {
    schemaVersion: "1.0.0",
    map: {name: title, description, definition},
    records: {externalSources},
    report,
    source: {format: "ogc-wmc", version: WMC_VERSION, byteLength: sourceBytes}
  };
}

export function exportWebMapContext(openGeo, {width = 1_280, height = 720, bounds = null} = {}) {
  if (!openGeo || typeof openGeo !== "object" || Array.isArray(openGeo)) throw wmcError("opengeo_project_required");
  const definition = openGeo.definition && typeof openGeo.definition === "object" ? openGeo.definition : openGeo;
  const report = createReport("export", OPENGEO_RELEASE, WMC_RELEASE);
  const title = boundedText(openGeo.name ?? definition.name ?? "OpenGeo Studio map", 240, "opengeo_project_name_invalid");
  const description = optionalString(openGeo.description ?? definition.description, 4_096);
  const contextId = safeId(definition.extensions?.wmc?.contextId ?? title);
  const outputBounds = exportBounds(bounds, definition);
  const viewport = {
    width: boundedInteger(width, 1, 8_192, "wmc_window_width_invalid"),
    height: boundedInteger(height, 1, 8_192, "wmc_window_height_invalid")
  };
  const keywords = Array.isArray(definition.metadata?.keywords)
    ? definition.metadata.keywords.slice(0, MAX_LIST_VALUES).map((value) => boundedText(value, 160, "wmc_keyword_invalid"))
    : [];
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ViewContext xmlns="${WMC_NAMESPACE}" xmlns:xlink="${XLINK_NAMESPACE}" xmlns:sld="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${WMC_NAMESPACE} https://schemas.opengis.net/context/1.1.0/context.xsd" version="${WMC_VERSION}" id="${escapeXml(contextId)}">`,
    "  <General>",
    `    <Window width="${viewport.width}" height="${viewport.height}"/>`,
    `    <BoundingBox SRS="${escapeXml(outputBounds.crs)}" minx="${numberText(outputBounds.minx)}" miny="${numberText(outputBounds.miny)}" maxx="${numberText(outputBounds.maxx)}" maxy="${numberText(outputBounds.maxy)}"/>`,
    `    <Title>${escapeXml(title)}</Title>`
  ];
  if (keywords.length) {
    lines.push("    <KeywordList>", ...keywords.map((keyword) => `      <Keyword>${escapeXml(keyword)}</Keyword>`), "    </KeywordList>");
  }
  if (description) lines.push(`    <Abstract>${escapeXml(description)}</Abstract>`);
  lines.push("  </General>", "  <LayerList>");
  addField(report, "$.definition.mapViews[0]", "mapped", "The supplied or derived map extent exported as the WMC shared BoundingBox.", "$.ViewContext.General.BoundingBox");
  addField(report, "$.definition.metadata.keywords", "mapped", "Bounded project keywords exported to WMC.", "$.ViewContext.General.KeywordList");

  const sourceLayers = Array.isArray(definition.layers) ? definition.layers : [];
  const exportable = [];
  for (const [index, layer] of sourceLayers.entries()) {
    const candidate = exportLayer(layer, index, report);
    if (candidate) exportable.push(candidate);
  }
  if (!exportable.length) throw wmcError("wmc_export_requires_wms_layer");
  for (const candidate of [...exportable].reverse()) lines.push(...writeLayer(candidate, 2));
  lines.push("  </LayerList>", "</ViewContext>", "");
  const xml = lines.join("\n");
  if (byteLength(xml) > MAX_WMC_BYTES) throw wmcError("exported_wmc_too_large");
  addField(report, "$.definition.layers", "mapped", `${exportable.length} WMS layers exported in WMC bottom-to-top draw order.`, "$.ViewContext.LayerList");
  if (sourceLayers.length !== exportable.length) {
    addField(report, "$.definition.layers", "unsupported", `${sourceLayers.length - exportable.length} non-WMS layers remain in OpenGeo Studio and are not represented as WMC layers.`);
  }
  finishReport(report);
  return {schemaVersion: "1.0.0", xml, report, context: {id: contextId, bounds: outputBounds, window: viewport}};
}

function parseLayer(element, index, report) {
  const path = `$.ViewContext.LayerList.Layer[${index}]`;
  const queryable = booleanAttribute(element, "queryable", "wmc_layer_queryable_required");
  const hidden = booleanAttribute(element, "hidden", "wmc_layer_hidden_required");
  const server = requiredSingleChild(element, "Server", "wmc_layer_server_required");
  const service = boundedText(server.getAttribute("service"), 80, "wmc_server_service_invalid");
  const version = boundedText(server.getAttribute("version"), 40, "wmc_server_version_invalid");
  const serverTitle = optionalString(server.getAttribute("title"), 240);
  const onlineResource = requiredSingleChild(server, "OnlineResource", "wmc_server_resource_required");
  const sourceUrl = sanitizeUrl(onlineResource.getAttributeNS(XLINK_NAMESPACE, "href") || onlineResource.getAttribute("xlink:href"), `${path}.Server.OnlineResource`, report);
  const name = requiredText(requiredSingleChild(element, "Name", "wmc_layer_name_required"), 240, "wmc_layer_name_invalid");
  const title = requiredText(requiredSingleChild(element, "Title", "wmc_layer_title_required"), 240, "wmc_layer_title_invalid");
  const abstract = optionalText(directChild(element, "Abstract"), 4_096);
  const srs = directChildren(element, "SRS").slice(0, MAX_LIST_VALUES)
    .map((entry) => requiredText(entry, 80, "wmc_layer_srs_invalid").toUpperCase());
  const formats = parseFormats(directChild(element, "FormatList"));
  const styles = parseStyles(directChild(element, "StyleList"), path, report);
  const dimensions = parseDimensions(directChild(element, "DimensionList"));
  const metadataUrl = parseOptionalUrl(directChild(element, "MetadataURL"), `${path}.MetadataURL`, report);
  const dataUrl = parseOptionalUrl(directChild(element, "DataURL"), `${path}.DataURL`, report);
  const extensionElement = directChild(element, "Extension");
  const extension = {
    documentIndex: index,
    service,
    version,
    serverTitle,
    sourceUrl,
    name,
    title,
    abstract,
    queryable,
    hidden,
    srs,
    formats,
    styles,
    dimensions,
    metadataUrl,
    dataUrl,
    extension: extensionElement ? serializeInertElement(extensionElement) : null
  };

  if (service !== "OGC:WMS") {
    addField(report, `${path}.Server.@service`, "unsupported", `${service} remains in the WMC extension; this WMC project path maps WMS layers only.`);
    return {layer: null, registration: null, extension};
  }
  const direct = /^https:\/\//i.test(sourceUrl) && srs.some((entry) => WEB_MERCATOR_NAMES.has(entry));
  const imageFormat = currentValue(formats, "image/png");
  const styleName = currentStyle(styles)?.name ?? "";
  const governedFormat = GOVERNED_IMAGE_FORMATS.has(imageFormat) ? imageFormat : "image/png";
  const configuration = {
    version,
    layers: [name],
    styles: [styleName],
    imageFormat: SUPPORTED_IMAGE_FORMATS.has(imageFormat) ? imageFormat : "image/png",
    transparent: imageFormat !== "image/jpeg",
    crs: "EPSG:3857",
    tileSize: 256,
    queryable,
    advertisedCrs: srs,
    advertisedFormats: formats.map(({value}) => value),
    ...(metadataUrl ? {metadataUrl} : {}),
    ...(dataUrl ? {dataUrl} : {})
  };
  const layerId = `wmc_${safeId(`${index + 1}-${name}`)}`;
  const layer = {
    layerId,
    datasetId: layerId,
    title,
    sourceType: direct ? "wms-raster" : "wms-context-reference",
    sourceUrl,
    sourceConfiguration: configuration,
    ...(direct ? {tileUrl: wmsTileUrl(sourceUrl, configuration)} : {}),
    governedSource: false,
    wmcDocumentIndex: index,
    geometryType: "Raster",
    visible: direct && !hidden,
    opacity: 1,
    style: {},
    labels: {enabled: false, field: null}
  };
  const endpoint = new URL(sourceUrl);
  const governable = direct
    && endpoint.search === ""
    && GOVERNED_WMS_VERSIONS.has(version)
    && OGC_NAME.test(name)
    && (!styleName || OGC_NAME.test(styleName));
  const registration = governable ? {
    importRef: layerId,
    name: title,
    description: abstract ?? `Imported from OGC WMC layer ${name}.`,
    classification: "internal",
    tags: ["wms", "external-source", "ogc-wmc"],
    source: {
      type: "wms",
      url: sourceUrl,
      ...configuration,
      imageFormat: governedFormat,
      transparent: governedFormat !== "image/jpeg"
    }
  } : null;
  addField(report, path, direct ? "mapped" : "preserved_extension", direct
    ? "HTTPS WMS layer with advertised Web Mercator support mapped without capabilities discovery or network access."
    : /^https:\/\//i.test(sourceUrl)
      ? "WMS layer remains inspectable but hidden because it does not advertise a MapLibre-compatible Web Mercator CRS."
      : "WMS layer remains inspectable but hidden because active browser requests require HTTPS.", `$.definition.layers[${layerId}]`);
  if (styles.some(({kind}) => kind === "sld")) {
    addField(report, `${path}.StyleList`, "preserved_extension", "SLD content remains inert in the WMC extension; no imported XML style is executed.", `$.definition.extensions.wmc.layers[${index}].styles`);
  }
  if (direct && !governable) {
    addField(report, `${path}.Server`, "preserved_extension", "The layer can be previewed directly, but its endpoint, version, layer name, or style is outside the governed WMS source contract and must be reviewed before persistence.");
  }
  if (dimensions.length) {
    addField(report, `${path}.DimensionList`, "preserved_extension", "WMC dimensions remain structured metadata and are not added to browser requests implicitly.", `$.definition.extensions.wmc.layers[${index}].dimensions`);
  }
  if (extensionElement) {
    addField(report, `${path}.Extension`, "preserved_extension", "Layer extension XML remains inert and is never executed.", `$.definition.extensions.wmc.layers[${index}].extension`);
  }
  return {layer, registration, extension};
}

function exportLayer(layer, index, report) {
  if (!layer || typeof layer !== "object") return null;
  if (!["wms-raster", "wms-url", "wms-context-reference"].includes(layer.sourceType)) return null;
  const path = `$.definition.layers[${index}]`;
  const config = layer.sourceConfiguration && typeof layer.sourceConfiguration === "object"
    ? layer.sourceConfiguration
    : {};
  let endpoint;
  try {
    endpoint = sanitizedExportUrl(layer.sourceUrl ?? endpointFromTileUrl(layer.tileUrl), `${path}.sourceUrl`, report);
  } catch {
    addField(report, `${path}.sourceUrl`, "unsupported", "WMS layer has no valid HTTP(S) service endpoint and cannot be exported to WMC.");
    return null;
  }
  const names = arrayOrCsv(config.layers);
  const name = boundedText(names[0] ?? layer.sourceLayer ?? layer.layerId, 240, "wmc_layer_name_invalid");
  const styles = arrayOrCsv(config.styles);
  const styleName = styles[0] ?? "";
  const version = optionalString(config.version, 40) ?? "1.3.0";
  const crs = Array.isArray(config.advertisedCrs) && config.advertisedCrs.length
    ? config.advertisedCrs.slice(0, MAX_LIST_VALUES).map((value) => boundedText(value, 80, "wmc_layer_srs_invalid"))
    : [optionalString(config.crs, 80) ?? "EPSG:3857"];
  const format = SUPPORTED_IMAGE_FORMATS.has(config.imageFormat) ? config.imageFormat : "image/png";
  const candidate = {
    queryable: config.queryable === true,
    hidden: layer.visible === false,
    endpoint,
    serverTitle: optionalString(config.serverTitle, 240) ?? new URL(endpoint).hostname,
    version,
    name,
    title: boundedText(layer.title ?? name, 240, "wmc_layer_title_invalid"),
    abstract: optionalString(layer.description, 4_096),
    crs,
    formats: [format],
    styleName,
    metadataUrl: safeOptionalExportUrl(config.metadataUrl, `${path}.sourceConfiguration.metadataUrl`, report),
    dataUrl: safeOptionalExportUrl(config.dataUrl, `${path}.sourceConfiguration.dataUrl`, report)
  };
  addField(report, path, "mapped", "WMS endpoint, layer identity, visibility, format, CRS, and current named style mapped to WMC.", `$.ViewContext.LayerList.Layer[${index}]`);
  if (names.length > 1) {
    addField(report, `${path}.sourceConfiguration.layers`, "unsupported", "WMC receives the first layer from this compound OpenGeo Studio WMS request; the compound request remains in OpenGeo Studio.");
  }
  if (layer.opacity !== undefined && layer.opacity !== 1) {
    addField(report, `${path}.opacity`, "unsupported", "WMC 1.1 has no portable layer opacity field.");
  }
  if (layer.style && Object.keys(layer.style).length) {
    addField(report, `${path}.style`, "preserved_extension", "OpenGeo Studio renderer style remains in the project; WMC receives only the named WMS style.");
  }
  return candidate;
}

function writeLayer(layer, depth) {
  const indent = "  ".repeat(depth);
  const lines = [
    `${indent}<Layer queryable="${layer.queryable ? "1" : "0"}" hidden="${layer.hidden ? "1" : "0"}">`,
    `${indent}  <Server service="OGC:WMS" version="${escapeXml(layer.version)}" title="${escapeXml(layer.serverTitle)}">`,
    `${indent}    <OnlineResource xlink:type="simple" xlink:href="${escapeXml(layer.endpoint)}"/>`,
    `${indent}  </Server>`,
    `${indent}  <Name>${escapeXml(layer.name)}</Name>`,
    `${indent}  <Title>${escapeXml(layer.title)}</Title>`
  ];
  if (layer.abstract) lines.push(`${indent}  <Abstract>${escapeXml(layer.abstract)}</Abstract>`);
  if (layer.dataUrl) lines.push(...writeUrlElement("DataURL", layer.dataUrl, null, depth + 1));
  if (layer.metadataUrl) lines.push(...writeUrlElement("MetadataURL", layer.metadataUrl, null, depth + 1));
  for (const crs of layer.crs) lines.push(`${indent}  <SRS>${escapeXml(crs)}</SRS>`);
  lines.push(`${indent}  <FormatList>`);
  for (const [index, format] of layer.formats.entries()) {
    lines.push(`${indent}    <Format${index === 0 ? ' current="1"' : ""}>${escapeXml(format)}</Format>`);
  }
  lines.push(`${indent}  </FormatList>`);
  if (layer.styleName) {
    lines.push(
      `${indent}  <StyleList>`,
      `${indent}    <Style current="1">`,
      `${indent}      <Name>${escapeXml(layer.styleName)}</Name>`,
      `${indent}      <Title>${escapeXml(layer.styleName)}</Title>`,
      `${indent}    </Style>`,
      `${indent}  </StyleList>`
    );
  }
  lines.push(`${indent}</Layer>`);
  return lines;
}

function writeUrlElement(name, url, format, depth) {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<${name}${format ? ` format="${escapeXml(format)}"` : ""}>`,
    `${indent}  <OnlineResource xlink:type="simple" xlink:href="${escapeXml(url)}"/>`,
    `${indent}</${name}>`
  ];
}

function parseFormats(element) {
  if (!element) return [];
  return directChildren(element, "Format").slice(0, MAX_LIST_VALUES).map((entry) => ({
    value: requiredText(entry, 160, "wmc_format_invalid"),
    current: optionalBooleanAttribute(entry, "current") === true
  }));
}

function parseStyles(element, path, report) {
  if (!element) return [];
  return directChildren(element, "Style").slice(0, MAX_LIST_VALUES).map((entry, index) => {
    const current = optionalBooleanAttribute(entry, "current") === true;
    const sld = directChild(entry, "SLD");
    if (sld) {
      return {kind: "sld", current, xml: serializeInertElement(sld)};
    }
    const name = requiredText(requiredSingleChild(entry, "Name", "wmc_style_name_required"), 240, "wmc_style_name_invalid");
    const title = requiredText(requiredSingleChild(entry, "Title", "wmc_style_title_required"), 240, "wmc_style_title_invalid");
    const legendUrl = parseOptionalUrl(directChild(entry, "LegendURL"), `${path}.StyleList.Style[${index}].LegendURL`, report);
    return {kind: "named", current, name, title, legendUrl};
  });
}

function parseDimensions(element) {
  if (!element) return [];
  return directChildren(element, "Dimension").slice(0, MAX_LIST_VALUES).map((entry) => ({
    name: boundedText(entry.getAttribute("name"), 80, "wmc_dimension_name_invalid"),
    units: boundedText(entry.getAttribute("units"), 80, "wmc_dimension_units_invalid"),
    unitSymbol: boundedText(entry.getAttribute("unitSymbol"), 80, "wmc_dimension_symbol_invalid", {allowEmpty: true}),
    userValue: boundedText(entry.getAttribute("userValue"), 240, "wmc_dimension_value_invalid", {allowEmpty: true}),
    value: optionalString(entry.textContent?.trim(), 2_048)
  }));
}

function parseWindow(element) {
  if (!element) return null;
  return {
    width: boundedInteger(Number(element.getAttribute("width")), 1, 8_192, "wmc_window_width_invalid"),
    height: boundedInteger(Number(element.getAttribute("height")), 1, 8_192, "wmc_window_height_invalid")
  };
}

function parseBounds(element) {
  const crs = boundedText(element.getAttribute("SRS"), 80, "wmc_bounding_box_srs_invalid").toUpperCase();
  const minx = decimalAttribute(element, "minx");
  const miny = decimalAttribute(element, "miny");
  const maxx = decimalAttribute(element, "maxx");
  const maxy = decimalAttribute(element, "maxy");
  if (!(minx < maxx && miny < maxy)) throw wmcError("wmc_bounding_box_invalid");
  return {crs, minx, miny, maxx, maxy};
}

function mapViewFromBounds(bounds, window) {
  const geographic = geographicBounds(bounds);
  if (!geographic) {
    return {id: "wmc-primary", title: "WMC view", center: [0, 20], zoom: 2, pitch: 0, bearing: 0};
  }
  const width = window?.width ?? 1_280;
  const height = window?.height ?? 720;
  const longitudeSpan = Math.max(0.000001, geographic.maxx - geographic.minx);
  const latitudeSpan = Math.max(0.000001, geographic.maxy - geographic.miny);
  const horizontalZoom = Math.log2((360 * width) / (256 * longitudeSpan));
  const verticalZoom = Math.log2((170.102258 * height) / (256 * latitudeSpan));
  return {
    id: "wmc-primary",
    title: "WMC view",
    center: [(geographic.minx + geographic.maxx) / 2, (geographic.miny + geographic.maxy) / 2],
    zoom: clamp(Math.min(horizontalZoom, verticalZoom), 0, 22),
    pitch: 0,
    bearing: 0,
    bbox: [geographic.minx, geographic.miny, geographic.maxx, geographic.maxy]
  };
}

function geographicBounds(bounds) {
  if (GEOGRAPHIC_NAMES.has(bounds.crs)) {
    if (bounds.minx < -180 || bounds.maxx > 180 || bounds.miny < -90 || bounds.maxy > 90) return null;
    return bounds;
  }
  if (!WEB_MERCATOR_NAMES.has(bounds.crs)) return null;
  const longitude = (x) => x * 180 / 20037508.342789244;
  const latitude = (y) => 180 / Math.PI * (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2);
  return {
    minx: clamp(longitude(bounds.minx), -180, 180),
    miny: clamp(latitude(bounds.miny), -85.051129, 85.051129),
    maxx: clamp(longitude(bounds.maxx), -180, 180),
    maxy: clamp(latitude(bounds.maxy), -85.051129, 85.051129)
  };
}

function exportBounds(supplied, definition) {
  if (Array.isArray(supplied) && supplied.length === 4 && supplied.every(Number.isFinite)
    && supplied[0] < supplied[2] && supplied[1] < supplied[3]) {
    return {crs: "EPSG:4326", minx: supplied[0], miny: supplied[1], maxx: supplied[2], maxy: supplied[3]};
  }
  const retained = definition.extensions?.wmc?.bounds;
  if (retained && typeof retained === "object" && ["minx", "miny", "maxx", "maxy"].every((key) => Number.isFinite(retained[key]))) {
    return {
      crs: optionalString(retained.crs, 80) ?? "EPSG:4326",
      minx: retained.minx,
      miny: retained.miny,
      maxx: retained.maxx,
      maxy: retained.maxy
    };
  }
  const viewBounds = definition.mapViews?.[0]?.bbox;
  if (Array.isArray(viewBounds) && viewBounds.length === 4 && viewBounds.every(Number.isFinite)) {
    return {crs: "EPSG:4326", minx: viewBounds[0], miny: viewBounds[1], maxx: viewBounds[2], maxy: viewBounds[3]};
  }
  return {crs: "EPSG:4326", minx: -180, miny: -85.051129, maxx: 180, maxy: 85.051129};
}

function wmsTileUrl(endpoint, configuration) {
  const url = new URL(endpoint);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:service|request|version|layers|styles|format|transparent|width|height|bbox|srs|crs)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const parameters = {
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
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString().replaceAll("%7B", "{").replaceAll("%7D", "}");
}

function endpointFromTileUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:service|request|version|layers|styles|format|transparent|width|height|bbox|srs|crs)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function parseOptionalUrl(element, path, report) {
  if (!element) return null;
  const resource = directChild(element, "OnlineResource");
  if (!resource) return null;
  return sanitizeUrl(resource.getAttributeNS(XLINK_NAMESPACE, "href") || resource.getAttribute("xlink:href"), path, report);
}

function sanitizeUrl(value, path, report) {
  const text = boundedText(value, MAX_URL_CHARACTERS, "wmc_url_invalid");
  let url;
  try { url = new URL(text); } catch { throw wmcError("wmc_url_invalid"); }
  if (!["http:", "https:"].includes(url.protocol)) throw wmcError("wmc_url_scheme_invalid");
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    addField(report, path, "rejected_sensitive", "Credentials and credential-like query values were removed from the URL.");
    report.losses.push(`${path}: credential-bearing URL sanitized`);
  }
  return url.toString();
}

function sanitizedExportUrl(value, path, report) {
  return sanitizeUrl(value, path, report);
}

function safeOptionalExportUrl(value, path, report) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return sanitizedExportUrl(value, path, report); } catch { return null; }
}

function scanXml(root) {
  const state = {nodes: 0, attributes: 0, text: 0};
  const visit = (element, depth) => {
    if (depth > MAX_XML_DEPTH) throw wmcError("wmc_xml_depth_limit");
    state.nodes += 1;
    state.attributes += element.attributes?.length ?? 0;
    state.text += [...element.childNodes].filter(({nodeType}) => nodeType === 3).reduce((sum, node) => sum + (node.nodeValue?.length ?? 0), 0);
    if (state.nodes > MAX_XML_NODES) throw wmcError("wmc_xml_node_limit");
    if (state.attributes > MAX_XML_ATTRIBUTES) throw wmcError("wmc_xml_attribute_limit");
    if (state.text > MAX_TEXT_CHARACTERS) throw wmcError("wmc_text_limit");
    for (const child of elementChildren(element)) visit(child, depth + 1);
  };
  visit(root, 0);
}

function serializeInertElement(element, depth = 0) {
  if (depth > MAX_XML_DEPTH) throw wmcError("wmc_xml_depth_limit");
  return {
    namespace: optionalString(element.namespaceURI, 240),
    name: boundedText(element.localName, 160, "wmc_extension_name_invalid"),
    attributes: [...element.attributes].slice(0, 64).map((attribute) => ({
      namespace: optionalString(attribute.namespaceURI, 240),
      name: boundedText(attribute.name, 160, "wmc_extension_attribute_invalid"),
      value: boundedText(attribute.value, 2_048, "wmc_extension_attribute_value_invalid", {allowEmpty: true})
    })),
    text: optionalString([...element.childNodes].filter(({nodeType}) => nodeType === 3).map(({nodeValue}) => nodeValue ?? "").join("").trim(), 4_096),
    children: elementChildren(element).map((child) => serializeInertElement(child, depth + 1))
  };
}

function requiredSingleChild(element, name, code) {
  const children = directChildren(element, name);
  if (children.length !== 1) throw wmcError(code);
  return children[0];
}

function directChild(element, name) {
  return directChildren(element, name)[0] ?? null;
}

function directChildren(element, name = null) {
  return elementChildren(element).filter((child) => child.namespaceURI === WMC_NAMESPACE && (!name || child.localName === name));
}

function elementChildren(element) {
  return [...(element?.children ?? [])];
}

function booleanAttribute(element, name, code) {
  if (!element.hasAttribute(name)) throw wmcError(code);
  const value = optionalBooleanAttribute(element, name);
  if (value === null) throw wmcError(code);
  return value;
}

function optionalBooleanAttribute(element, name) {
  if (!element.hasAttribute(name)) return null;
  const value = element.getAttribute(name);
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw wmcError("wmc_boolean_invalid");
}

function decimalAttribute(element, name) {
  const text = element.getAttribute(name);
  if (text === null || text.trim() === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())) throw wmcError("wmc_decimal_invalid");
  const value = Number(text);
  if (!Number.isFinite(value)) throw wmcError("wmc_decimal_invalid");
  return value;
}

function requiredText(element, maximum, code) {
  return boundedText(element?.textContent, maximum, code);
}

function boundedText(value, maximum, code, {allowEmpty = false} = {}) {
  if (typeof value !== "string") throw wmcError(code);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maximum) throw wmcError(code);
  return text;
}

function optionalText(element, maximum) {
  return element ? optionalString(element.textContent?.trim(), maximum) : null;
}

function optionalString(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

function boundedIdentifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw wmcError(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw wmcError(code);
  return value;
}

function currentValue(values, fallback) {
  return values.find(({current}) => current)?.value ?? values[0]?.value ?? fallback;
}

function currentStyle(styles) {
  return styles.find(({current, kind}) => current && kind === "named")
    ?? styles.find(({kind}) => kind === "named")
    ?? null;
}

function arrayOrCsv(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function safeId(value) {
  const id = String(value ?? "wmc-context").toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return id || "wmc-context";
}

function numberText(value) {
  return Number(value).toFixed(8).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function createReport(direction, source, target) {
  return {
    $schema: "../schemas/conversion-report.schema.json",
    schemaVersion: "1.0.0",
    conversionId: `wmc.${direction}`,
    direction,
    source: structuredClone(source),
    target: structuredClone(target),
    policy: {
      networkAccess: "disabled",
      sensitiveValues: "reject",
      unknownFields: "preserve_extension",
      sizeLimitBytes: MAX_WMC_BYTES,
      layerLimit: MAX_LAYERS
    },
    summary: {status: "lossless", mapped: 0, preserved: 0, defaulted: 0, rejected: 0, unsupported: 0},
    fields: [],
    losses: [],
    warnings: []
  };
}

function addField(report, path, outcome, message, targetPath) {
  report.fields.push({path, ...(targetPath ? {targetPath} : {}), outcome, message});
}

function finishReport(report) {
  const counts = {mapped: 0, preserved_extension: 0, defaulted: 0, rejected_sensitive: 0, unsupported: 0};
  for (const field of report.fields) counts[field.outcome] += 1;
  report.summary = {
    status: counts.rejected_sensitive || report.losses.length
      ? "lossy"
      : counts.preserved_extension || counts.unsupported
        ? "preserved_with_extensions"
        : "lossless",
    mapped: counts.mapped,
    preserved: counts.preserved_extension,
    defaulted: counts.defaulted,
    rejected: counts.rejected_sensitive,
    unsupported: counts.unsupported
  };
}

function wmcError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
