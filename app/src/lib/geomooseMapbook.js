import {emptyMapDefinition} from "./mapDefinition.js";
import {
  PORTAL_CONFIGURATION_LIMITS,
  createPortalConfiguration,
  normalizePortalConfiguration
} from "./portalConfiguration.js";
import {analyzePortalCatalog} from "./portalCatalog.js";

const MAX_MAPBOOK_BYTES = 256 * 1024;
const MAPBOOK_VERSION = "3.0";
const GEOMOOSE_RELEASE = Object.freeze({
  product: "geomoose",
  version: "3.15.2",
  commit: "6eb12a80c9d379b5634126da6ad047071fa85b92"
});
const OPENGEO_RELEASE = Object.freeze({product: "opengeo", version: "0.1.0", commit: null});
const SENSITIVE_NAME = /^(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|credential|client[-_]?secret|private[-_]?key|key)$/i;
const SENSITIVE_QUERY = /(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|signature|authorization|credential)/i;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$/;

export const GEOMOOSE_MAPBOOK_LIMITS = Object.freeze({
  maximumBytes: MAX_MAPBOOK_BYTES,
  maximumSources: PORTAL_CONFIGURATION_LIMITS.maximumSources,
  maximumCatalogNodes: PORTAL_CONFIGURATION_LIMITS.maximumCatalogNodes,
  maximumCatalogDepth: PORTAL_CONFIGURATION_LIMITS.maximumCatalogDepth,
  maximumTools: PORTAL_CONFIGURATION_LIMITS.maximumTools,
  maximumToolDepth: PORTAL_CONFIGURATION_LIMITS.maximumToolDepth,
  maximumXmlNodes: PORTAL_CONFIGURATION_LIMITS.maximumXmlNodes,
  maximumXmlDepth: PORTAL_CONFIGURATION_LIMITS.maximumXmlDepth,
  maximumXmlAttributes: PORTAL_CONFIGURATION_LIMITS.maximumXmlAttributes,
  maximumTextCharacters: PORTAL_CONFIGURATION_LIMITS.maximumTextCharacters,
  networkAccess: "disabled",
  activeXml: "rejected"
});

export function importGeoMooseMapbook(text, {DOMParser: Parser = globalThis.DOMParser} = {}) {
  if (typeof text !== "string") throw mapbookError("mapbook_text_required");
  const sourceBytes = byteLength(text);
  if (sourceBytes > MAX_MAPBOOK_BYTES) throw mapbookError("mapbook_too_large");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw mapbookError("active_xml_rejected");
  if (typeof Parser !== "function") throw mapbookError("dom_parser_unavailable");
  const xml = new Parser().parseFromString(text, "application/xml");
  if (xml.querySelector?.("parsererror") || xml.documentElement?.localName === "parsererror") throw mapbookError("malformed_mapbook");
  const root = xml.documentElement;
  if (root?.localName !== "mapbook" || root.namespaceURI) throw mapbookError("geomoose_mapbook_root_required");
  if (root.getAttribute("version") !== MAPBOOK_VERSION) throw mapbookError("geomoose_mapbook_3_required");

  const report = createReport("import", GEOMOOSE_RELEASE, OPENGEO_RELEASE);
  addField(report, "$.mapbook.@version", "mapped", "GeoMoose mapbook 3.0 mapped to the pinned portal upstream identity.", "$.definition.portal.upstream");
  const state = {nodes: 0, attributes: 0, text: 0};
  const sourceElements = directChildren(root, "map-source");
  if (sourceElements.length > GEOMOOSE_MAPBOOK_LIMITS.maximumSources) throw mapbookError("mapbook_source_limit");
  const sources = sourceElements.map((element, index) => parseSource(element, index, report, state));
  const catalogElement = directChildren(root, "catalog")[0] ?? null;
  const toolbarElement = directChildren(root, "toolbar")[0] ?? null;
  const catalogState = {nodes: 0};
  const catalog = catalogElement
    ? directChildren(catalogElement).filter(({localName}) => localName === "group" || localName === "layer")
      .map((element, index) => parseCatalogNode(element, `$.mapbook.catalog[${index}]`, report, 0, catalogState))
    : [];
  const toolState = {nodes: 0};
  const tools = toolbarElement
    ? directChildren(toolbarElement).filter(({localName}) => localName === "drawer" || localName === "tool")
      .map((element, index) => parseToolNode(element, `$.mapbook.toolbar[${index}]`, report, 0, toolState))
    : [];
  const portal = createPortalConfiguration({
    sources,
    catalog,
    tools,
    locations: [],
    theme: {id: "opengeo-default", title: "OpenGeo default", colorMode: "dark"},
    upstream: GEOMOOSE_RELEASE
  });
  addField(report, "$.mapbook.catalog", "mapped", `${catalogState.nodes} catalog nodes mapped into the standalone portal configuration.`, "$.definition.portal.catalog");
  recordCatalogConversion(report, analyzePortalCatalog(portal));
  addField(report, "$.mapbook.toolbar", "mapped", `${toolState.nodes} tools and drawers mapped into the standalone portal configuration.`, "$.definition.portal.tools");
  addField(report, "$.mapbook.toolbar.searches", "mapped", `${portal.searches.length} search tools derived from the configured toolbar.`, "$.definition.portal.searches");
  addField(report, "$.mapbook.toolbar.services", "mapped", `${portal.services.length} service tools derived from the configured toolbar.`, "$.definition.portal.services");
  addField(report, "$.definition.portal.locations", "defaulted", "The source mapbook declares no saved locations; OpenGeo starts with an empty versioned location list.", "$.definition.portal.locations");
  addField(report, "$.definition.portal.theme", "defaulted", "The source mapbook declares no portable theme record; OpenGeo uses its accessible default theme.", "$.definition.portal.theme");

  const handled = new Set([...sourceElements, catalogElement, toolbarElement].filter(Boolean));
  const otherElements = [];
  for (const [index, element] of directChildren(root).entries()) {
    if (handled.has(element)) continue;
    const parsed = parseXmlNode(element, `$.mapbook.extensions[${index}]`, report, state, 0);
    if (parsed) {
      otherElements.push(parsed);
      addField(report, `$.mapbook.${element.localName}`, "preserved_extension", "An unrecognized top-level element remains inert in the GeoMoose extension.", "$.definition.extensions.geomoose.otherElements");
    }
  }
  finishReport(report);
  return {
    schemaVersion: "1.0.0",
    map: {
      name: "GeoMoose 3.15.2 mapbook",
      description: "Imported offline from a pinned GeoMoose mapbook with explicit preservation and loss reporting.",
      definition: emptyMapDefinition({
        portal,
        extensions: {
          geomoose: {
            schemaVersion: "1.0.0",
            upstream: {...GEOMOOSE_RELEASE},
            mapbookVersion: MAPBOOK_VERSION,
            otherElements
          }
        }
      })
    },
    report,
    source: {format: "geomoose-mapbook", version: MAPBOOK_VERSION, byteLength: sourceBytes}
  };
}

export function exportGeoMooseMapbook(openGeo) {
  if (!openGeo || typeof openGeo !== "object") throw mapbookError("opengeo_project_required");
  const definition = openGeo.definition && typeof openGeo.definition === "object" ? openGeo.definition : openGeo;
  const portal = normalizePortalConfiguration(definition.portal);
  const report = createReport("export", OPENGEO_RELEASE, GEOMOOSE_RELEASE);
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<mapbook version="${MAPBOOK_VERSION}">`];
  for (const [index, source] of portal.sources.entries()) {
    const element = structuredClone(source.element);
    element.name = "map-source";
    element.attributes = {
      ...element.attributes,
      name: source.name,
      type: source.type,
      ...(source.title === source.name ? {} : {title: source.title})
    };
    lines.push(writeXmlNode(element, 1));
    addField(report, `$.definition.portal.sources[${index}]`, "mapped", "Portal source configuration exported as a GeoMoose map-source.", `$.mapbook.map-source[${index}]`);
  }
  lines.push(writeContainer("catalog", portal.catalog.map(catalogXmlNode), 1));
  lines.push(writeContainer("toolbar", portal.tools.map(toolXmlNode), 1));
  addField(report, "$.definition.portal.catalog", "mapped", "The ordered grouped catalog exported to the mapbook catalog.", "$.mapbook.catalog");
  for (const [index, entry] of analyzePortalCatalog(portal).entries.entries()) {
    addField(
      report,
      `$.definition.portal.catalogLayers[${index}]`,
      "mapped",
      `Catalog reference ${entry.reference || "(missing)"} exported with its grouping, order, visibility, legend, metadata, and source-binding intent.`,
      `$.mapbook.catalog.${entry.key}`
    );
  }
  addField(report, "$.definition.portal.tools", "mapped", "The ordered tools and drawers exported to the mapbook toolbar.", "$.mapbook.toolbar");
  addField(report, "$.definition.portal.searches", "mapped", "Search records are represented by their source service tools and drawers.", "$.mapbook.toolbar");
  addField(report, "$.definition.portal.services", "mapped", "Service records are represented by their source service tools.", "$.mapbook.toolbar");
  if (portal.locations.length) {
    addField(report, "$.definition.portal.locations", "preserved_extension", "Saved OpenGeo locations have no standard GeoMoose mapbook 3.0 field and remain in the OpenGeo map definition.");
  }
  if (portal.theme.id !== "opengeo-default" || portal.theme.colorMode !== "dark") {
    addField(report, "$.definition.portal.theme", "preserved_extension", "The OpenGeo theme remains in the map definition because mapbook 3.0 has no portable theme field.");
  }
  for (const [index, element] of (definition.extensions?.geomoose?.otherElements ?? []).entries()) {
    lines.push(writeXmlNode(element, 1));
    addField(report, `$.definition.extensions.geomoose.otherElements[${index}]`, "preserved_extension", "The inert GeoMoose top-level extension was restored to the mapbook.", `$.mapbook.extensions[${index}]`);
  }
  lines.push("</mapbook>", "");
  const xml = lines.join("\n");
  if (byteLength(xml) > MAX_MAPBOOK_BYTES) throw mapbookError("exported_mapbook_too_large");
  finishReport(report);
  return {schemaVersion: "1.0.0", xml, portal, report};
}

function parseSource(element, index, report, state) {
  const name = requiredIdentifier(element.getAttribute("name"), `map-source ${index + 1} name`);
  const type = requiredIdentifier(element.getAttribute("type"), `map-source ${name} type`);
  const parsed = parseXmlNode(element, `$.mapbook.map-source[${index}]`, report, state, 0);
  if (!parsed) throw mapbookError("mapbook_source_rejected");
  addField(report, `$.mapbook.map-source[${index}]`, "mapped", `Map source ${name} retained as bounded versioned portal configuration without dereferencing it.`, `$.definition.portal.sources[${index}]`);
  return {
    name,
    type,
    title: boundedText(element.getAttribute("title") || name, 240, "map-source title"),
    element: parsed
  };
}

function parseCatalogNode(element, path, report, depth, state) {
  if (depth > GEOMOOSE_MAPBOOK_LIMITS.maximumCatalogDepth) throw mapbookError("mapbook_catalog_depth");
  if (++state.nodes > GEOMOOSE_MAPBOOK_LIMITS.maximumCatalogNodes) throw mapbookError("mapbook_catalog_limit");
  const kind = element.localName;
  const attributes = safeAttributes(element, path, report);
  const source = kind === "layer" ? attributes.src ?? null : null;
  const children = directChildren(element).filter(({localName}) => localName === "group" || localName === "layer")
    .map((child, index) => parseCatalogNode(child, `${path}.children[${index}]`, report, depth + 1, state));
  const metadata = directChildren(element, "metadata").map((entry) => boundedText(entry.textContent?.trim() ?? "", 2048, "catalog metadata", {allowEmpty: true}));
  return {
    kind,
    title: boundedText(attributes.title ?? source ?? kind, 240, "catalog title"),
    source,
    attributes,
    metadata,
    children
  };
}

function parseToolNode(element, path, report, depth, state) {
  if (depth > GEOMOOSE_MAPBOOK_LIMITS.maximumToolDepth) throw mapbookError("mapbook_tool_depth");
  if (++state.nodes > GEOMOOSE_MAPBOOK_LIMITS.maximumTools) throw mapbookError("mapbook_tool_limit");
  const kind = element.localName;
  const attributes = safeAttributes(element, path, report);
  const name = requiredIdentifier(attributes.name, `${kind} name`);
  const children = directChildren(element).filter(({localName}) => localName === "drawer" || localName === "tool")
    .map((child, index) => parseToolNode(child, `${path}.children[${index}]`, report, depth + 1, state));
  return {
    kind,
    name,
    title: boundedText(attributes.title ?? name, 240, `${kind} title`),
    type: kind === "tool" ? boundedText(attributes.type ?? "action", 80, "tool type") : "drawer",
    tip: attributes.tip ?? null,
    href: attributes.href ?? null,
    cssClass: attributes["css-class"] ?? null,
    attributes,
    children
  };
}

function parseXmlNode(element, path, report, state, depth) {
  if (depth > GEOMOOSE_MAPBOOK_LIMITS.maximumXmlDepth) throw mapbookError("mapbook_xml_depth");
  if (++state.nodes > GEOMOOSE_MAPBOOK_LIMITS.maximumXmlNodes) throw mapbookError("mapbook_xml_node_limit");
  if (!XML_NAME.test(element.localName ?? "")) throw mapbookError("mapbook_xml_name_invalid");
  const attributes = safeAttributes(element, path, report);
  if (element.localName === "param" && SENSITIVE_NAME.test(attributes.name ?? "")) {
    addField(report, `${path}.@value`, "rejected_sensitive", "Credential-like GeoMoose parameters are removed; reconnect them through governed OpenGeo connection custody.");
    report.losses.push(`${path}: credential-like parameter removed`);
    return null;
  }
  const children = [];
  for (const [index, child] of directChildren(element).entries()) {
    const parsed = parseXmlNode(child, `${path}.${child.localName}[${index}]`, report, state, depth + 1);
    if (parsed) children.push(parsed);
  }
  let text = directText(element);
  if (element.localName === "url" && /^https?:\/\//i.test(text)) {
    const sanitized = sanitizeUrl(text);
    if (sanitized !== text) {
      addField(report, `${path}.#text`, "rejected_sensitive", "Credentials and sensitive query fields were removed from the URL.");
      report.losses.push(`${path}.#text: credential-bearing URL sanitized`);
      text = sanitized;
    }
  }
  state.text += text.length;
  if (state.text > GEOMOOSE_MAPBOOK_LIMITS.maximumTextCharacters) throw mapbookError("mapbook_text_limit");
  return {name: element.localName, attributes, text, children};
}

function safeAttributes(element, path, report) {
  const output = {};
  for (const attribute of [...element.attributes]) {
    if (!XML_NAME.test(attribute.name)) throw mapbookError("mapbook_xml_attribute_invalid");
    if (SENSITIVE_NAME.test(attribute.name)) {
      addField(report, `${path}.@${attribute.name}`, "rejected_sensitive", "Credential-like XML attributes are not imported.");
      report.losses.push(`${path}.@${attribute.name}: sensitive value removed`);
      continue;
    }
    let value = boundedText(attribute.value, 2048, "XML attribute", {allowEmpty: true});
    if (["href", "url", "src"].includes(attribute.name) && /^https?:\/\//i.test(value)) {
      const sanitized = sanitizeUrl(value);
      if (sanitized !== value) {
        addField(report, `${path}.@${attribute.name}`, "rejected_sensitive", "Credentials and sensitive query fields were removed from the URL.");
        report.losses.push(`${path}.@${attribute.name}: credential-bearing URL sanitized`);
        value = sanitized;
      }
    }
    output[attribute.name] = value;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function catalogXmlNode(node) {
  const attributes = {...node.attributes};
  if (node.title) attributes.title = node.title;
  if (node.kind === "layer" && node.source) attributes.src = node.source;
  return {
    name: node.kind,
    attributes,
    text: "",
    children: [
      ...node.metadata.map((value) => ({name: "metadata", attributes: {}, text: value, children: []})),
      ...node.children.map(catalogXmlNode)
    ]
  };
}

function toolXmlNode(node) {
  const attributes = {...node.attributes, name: node.name, title: node.title};
  if (node.kind === "tool") attributes.type = node.type;
  if (node.tip) attributes.tip = node.tip;
  else delete attributes.tip;
  if (node.href) attributes.href = node.href;
  else delete attributes.href;
  if (node.cssClass) attributes["css-class"] = node.cssClass;
  else delete attributes["css-class"];
  return {name: node.kind, attributes, text: "", children: node.children.map(toolXmlNode)};
}

function writeContainer(name, children, depth) {
  return writeXmlNode({name, attributes: {}, text: "", children}, depth);
}

function writeXmlNode(node, depth) {
  const indent = "  ".repeat(depth);
  const attributes = Object.entries(node.attributes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
  const children = node.children ?? [];
  const content = node.text ?? "";
  if (!children.length && !content) return `${indent}<${node.name}${attributes}/>`;
  if (!children.length) return `${indent}<${node.name}${attributes}>${escapeText(content)}</${node.name}>`;
  const nested = children.map((child) => writeXmlNode(child, depth + 1)).join("\n");
  const leadingText = content ? `${escapeText(content)}\n` : "";
  return `${indent}<${node.name}${attributes}>\n${leadingText}${nested}\n${indent}</${node.name}>`;
}

function directChildren(element, localName = null) {
  return [...(element?.children ?? [])].filter((child) => !localName || child.localName === localName);
}

function directText(element) {
  return [...(element?.childNodes ?? [])]
    .filter((node) => node.nodeType === 3 || node.nodeType === 4)
    .map((node) => node.nodeValue ?? "")
    .join("")
    .trim();
}

function sanitizeUrl(value) {
  let url;
  try { url = new URL(value); } catch { return value; }
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) if (SENSITIVE_QUERY.test(key)) url.searchParams.delete(key);
  return url.toString();
}

function createReport(direction, source, target) {
  return {
    $schema: "../schemas/conversion-report.schema.json",
    schemaVersion: "1.0.0",
    conversionId: `geomoose.${direction}.mapbook`,
    direction,
    source: {...source},
    target: {...target},
    policy: {networkAccess: "disabled", sensitiveValues: "reject", unknownFields: "preserve_extension", sizeLimitBytes: MAX_MAPBOOK_BYTES},
    summary: {status: "lossless", mapped: 0, preserved: 0, defaulted: 0, rejected: 0, unsupported: 0},
    fields: [],
    losses: [],
    warnings: []
  };
}

function addField(report, path, outcome, message, targetPath) {
  report.fields.push({path, ...(targetPath ? {targetPath} : {}), outcome, message});
}

function recordCatalogConversion(report, analysis) {
  for (const [index, entry] of analysis.entries.entries()) {
    const path = `$.mapbook.catalogLayers[${index}]`;
    const targetPath = `$.definition.portal.catalog.${entry.key}`;
    if (entry.compatibility === "direct") {
      addField(
        report,
        path,
        "mapped",
        `Catalog reference ${entry.reference} is structurally resolved and can be displayed only after binding an authorized exact OpenGeo source revision.`,
        targetPath
      );
      continue;
    }
    if (entry.compatibility === "unresolved") {
      addField(
        report,
        path,
        "unsupported",
        `Catalog reference ${entry.reference || "(missing)"} does not resolve to a declared GeoMoose map source and remains visible but disabled.`,
        targetPath
      );
      report.losses.push(`${path}: unresolved catalog source ${entry.reference || "(missing)"}`);
      continue;
    }
    const requirement = entry.compatibility === "ingest_required"
      ? "a governed dataset ingest"
      : "a governed compatibility adapter";
    addField(
      report,
      path,
      "preserved_extension",
      `Catalog reference ${entry.reference} is preserved exactly and remains disabled until ${requirement} is selected.`,
      targetPath
    );
    report.warnings.push(`${path}: ${entry.reference} requires ${requirement} before display`);
  }
}

function finishReport(report) {
  const counts = {mapped: 0, preserved_extension: 0, defaulted: 0, rejected_sensitive: 0, unsupported: 0};
  for (const field of report.fields) counts[field.outcome] += 1;
  report.summary = {
    status: counts.rejected_sensitive || report.losses.length ? "lossy" : counts.preserved_extension || counts.unsupported ? "preserved_with_extensions" : "lossless",
    mapped: counts.mapped,
    preserved: counts.preserved_extension,
    defaulted: counts.defaulted,
    rejected: counts.rejected_sensitive,
    unsupported: counts.unsupported
  };
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw mapbookError("mapbook_identifier_invalid", label);
  return value;
}

function boundedText(value, maximum, label, {allowEmpty = false} = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw mapbookError("mapbook_text_invalid", label);
  }
  return value;
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function mapbookError(code, message = code) {
  return Object.assign(new Error(message), {code});
}
