export const PORTAL_CONFIGURATION_SCHEMA_VERSION = "opengeo.portal-configuration.1.0.0";

export const PORTAL_CONFIGURATION_LIMITS = Object.freeze({
  maximumSources: 128,
  maximumCatalogNodes: 512,
  maximumCatalogDepth: 12,
  maximumTools: 128,
  maximumToolDepth: 8,
  maximumSearches: 64,
  maximumServices: 128,
  maximumLocations: 100,
  maximumXmlNodes: 4_000,
  maximumXmlDepth: 16,
  maximumXmlAttributes: 16_000,
  maximumTextCharacters: 131_072
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$/;
const COLOR_MODES = new Set(["light", "dark"]);
const TOOL_KINDS = new Set(["tool", "drawer"]);
const CATALOG_KINDS = new Set(["layer", "group"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_NAME = /^(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|credential|client[-_]?secret|private[-_]?key|key)$/i;
const SENSITIVE_QUERY = /(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|signature|authorization|credential)/i;

export function createPortalConfiguration({
  revision = 1,
  sources = [],
  catalog = [],
  tools = [],
  locations = [],
  theme = {id: "opengeo-default", title: "OpenGeo Studio default", colorMode: "dark"},
  upstream = null
} = {}) {
  return normalizePortalConfiguration({
    schemaVersion: PORTAL_CONFIGURATION_SCHEMA_VERSION,
    revision,
    sources,
    catalog,
    tools,
    searches: deriveSearches(tools),
    services: deriveServices(tools),
    locations,
    theme,
    ...(upstream ? {upstream} : {})
  });
}

export function normalizePortalConfiguration(value) {
  if (!record(value)) throw new TypeError("Portal configuration must be an object.");
  if (value.schemaVersion !== PORTAL_CONFIGURATION_SCHEMA_VERSION) {
    throw new TypeError(`Portal configuration must use ${PORTAL_CONFIGURATION_SCHEMA_VERSION}.`);
  }
  if (!Number.isInteger(value.revision) || value.revision < 1 || value.revision > 1_000_000) {
    throw new TypeError("Portal configuration revision must be a positive bounded integer.");
  }
  const sources = boundedArray(value.sources, PORTAL_CONFIGURATION_LIMITS.maximumSources, "sources")
    .map((source, index) => normalizeSource(source, index));
  uniqueBy(sources, ({name}) => name, "Portal source names must be unique.");
  const catalogState = {nodes: 0};
  const catalog = boundedArray(value.catalog, PORTAL_CONFIGURATION_LIMITS.maximumCatalogNodes, "catalog")
    .map((node, index) => normalizeCatalogNode(node, `catalog[${index}]`, 0, catalogState));
  const toolState = {nodes: 0};
  const tools = boundedArray(value.tools, PORTAL_CONFIGURATION_LIMITS.maximumTools, "tools")
    .map((node, index) => normalizeToolNode(node, `tools[${index}]`, 0, toolState));
  const locations = boundedArray(value.locations, PORTAL_CONFIGURATION_LIMITS.maximumLocations, "locations")
    .map((location, index) => normalizeLocation(location, index));
  uniqueBy(locations, ({id}) => id, "Portal location ids must be unique.");
  const theme = normalizeTheme(value.theme);
  const searches = deriveSearches(tools);
  const services = deriveServices(tools);
  if (searches.length > PORTAL_CONFIGURATION_LIMITS.maximumSearches) throw new TypeError("Portal configuration has too many searches.");
  if (services.length > PORTAL_CONFIGURATION_LIMITS.maximumServices) throw new TypeError("Portal configuration has too many services.");
  return {
    schemaVersion: PORTAL_CONFIGURATION_SCHEMA_VERSION,
    revision: value.revision,
    sources,
    catalog,
    tools,
    searches,
    services,
    locations,
    theme,
    ...(value.upstream ? {upstream: normalizeUpstream(value.upstream)} : {})
  };
}

export function portalConfigurationForProject(project) {
  if (!project?.portal) return null;
  try {
    return normalizePortalConfiguration(project.portal);
  } catch {
    return null;
  }
}

function normalizeSource(value, index) {
  if (!record(value)) throw new TypeError(`Portal source ${index + 1} must be an object.`);
  const name = identifier(value.name, `Portal source ${index + 1} name`);
  const type = identifier(value.type, `Portal source ${name} type`);
  const title = boundedText(value.title ?? name, 240, `Portal source ${name} title`);
  const element = normalizeXmlNode(value.element, `sources.${name}.element`);
  element.name = "map-source";
  element.attributes = {
    ...element.attributes,
    name,
    type,
    ...(title === name ? {} : {title})
  };
  return {
    name,
    type,
    title,
    element
  };
}

function normalizeCatalogNode(value, path, depth, state) {
  if (!record(value) || !CATALOG_KINDS.has(value.kind)) throw new TypeError(`${path} is not a supported catalog node.`);
  if (depth > PORTAL_CONFIGURATION_LIMITS.maximumCatalogDepth) throw new TypeError("Portal catalog nesting is too deep.");
  if (++state.nodes > PORTAL_CONFIGURATION_LIMITS.maximumCatalogNodes) throw new TypeError("Portal catalog has too many nodes.");
  const attributes = normalizeAttributes(value.attributes ?? {}, `${path}.attributes`);
  const children = boundedArray(value.children ?? [], PORTAL_CONFIGURATION_LIMITS.maximumCatalogNodes, `${path}.children`)
    .map((child, index) => normalizeCatalogNode(child, `${path}.children[${index}]`, depth + 1, state));
  const title = boundedText(value.title ?? attributes.title ?? value.source ?? value.kind, 240, `${path}.title`);
  const source = value.kind === "layer" ? boundedNullableText(value.source ?? attributes.src ?? null, 320, `${path}.source`) : null;
  const canonicalAttributes = {...attributes, title};
  if (value.kind === "layer" && source) canonicalAttributes.src = source;
  return {
    kind: value.kind,
    title,
    source,
    attributes: canonicalAttributes,
    metadata: boundedArray(value.metadata ?? [], 16, `${path}.metadata`).map((entry, index) => boundedText(entry, 2048, `${path}.metadata[${index}]`)),
    children
  };
}

function normalizeToolNode(value, path, depth, state) {
  if (!record(value) || !TOOL_KINDS.has(value.kind)) throw new TypeError(`${path} is not a supported tool node.`);
  if (depth > PORTAL_CONFIGURATION_LIMITS.maximumToolDepth) throw new TypeError("Portal tool nesting is too deep.");
  if (++state.nodes > PORTAL_CONFIGURATION_LIMITS.maximumTools) throw new TypeError("Portal configuration has too many tools.");
  const attributes = normalizeAttributes(value.attributes ?? {}, `${path}.attributes`);
  const name = identifier(value.name ?? attributes.name, `${path}.name`);
  const children = boundedArray(value.children ?? [], PORTAL_CONFIGURATION_LIMITS.maximumTools, `${path}.children`)
    .map((child, index) => normalizeToolNode(child, `${path}.children[${index}]`, depth + 1, state));
  const title = boundedText(value.title ?? attributes.title ?? name, 240, `${path}.title`);
  const type = value.kind === "tool" ? boundedText(value.type ?? attributes.type ?? "action", 80, `${path}.type`) : "drawer";
  const tip = boundedNullableText(value.tip ?? attributes.tip ?? null, 500, `${path}.tip`);
  const href = boundedNullableText(value.href ?? attributes.href ?? null, 2048, `${path}.href`);
  if (href) assertCredentialFreeUrl(href, `${path}.href`);
  const cssClass = boundedNullableText(value.cssClass ?? attributes["css-class"] ?? null, 160, `${path}.cssClass`);
  const canonicalAttributes = {...attributes, name, title};
  if (value.kind === "tool") canonicalAttributes.type = type;
  if (tip) canonicalAttributes.tip = tip;
  else delete canonicalAttributes.tip;
  if (href) canonicalAttributes.href = href;
  else delete canonicalAttributes.href;
  if (cssClass) canonicalAttributes["css-class"] = cssClass;
  else delete canonicalAttributes["css-class"];
  return {
    kind: value.kind,
    name,
    title,
    type,
    tip,
    href,
    cssClass,
    attributes: canonicalAttributes,
    children
  };
}

function normalizeLocation(value, index) {
  if (!record(value)) throw new TypeError(`Portal location ${index + 1} must be an object.`);
  const center = boundedArray(value.center, 2, `locations[${index}].center`);
  if (center.length !== 2 || !center.every(Number.isFinite) || center[0] < -180 || center[0] > 180 || center[1] < -90 || center[1] > 90) {
    throw new TypeError(`Portal location ${index + 1} center is invalid.`);
  }
  const zoom = Number(value.zoom);
  if (!Number.isFinite(zoom) || zoom < -2 || zoom > 24) throw new TypeError(`Portal location ${index + 1} zoom is invalid.`);
  return {
    id: identifier(value.id, `Portal location ${index + 1} id`),
    title: boundedText(value.title, 240, `Portal location ${index + 1} title`),
    center: [Number(center[0]), Number(center[1])],
    zoom
  };
}

function normalizeTheme(value) {
  if (!record(value)) throw new TypeError("Portal theme must be an object.");
  const colorMode = String(value.colorMode ?? "dark");
  if (!COLOR_MODES.has(colorMode)) throw new TypeError("Portal theme colorMode must be light or dark.");
  return {
    id: identifier(value.id, "Portal theme id"),
    title: boundedText(value.title, 240, "Portal theme title"),
    colorMode
  };
}

function normalizeUpstream(value) {
  if (!record(value) || value.product !== "geomoose" || value.version !== "3.15.2" || !/^[0-9a-f]{40}$/.test(value.commit ?? "")) {
    throw new TypeError("Portal upstream identity must be the pinned GeoMoose 3.15.2 commit.");
  }
  return {product: value.product, version: value.version, commit: value.commit};
}

function normalizeXmlNode(value, path, state = {nodes: 0, attributes: 0, text: 0}, depth = 0) {
  if (!record(value) || typeof value.name !== "string" || !XML_NAME.test(value.name)) throw new TypeError(`${path} has an invalid XML element name.`);
  if (depth > PORTAL_CONFIGURATION_LIMITS.maximumXmlDepth) throw new TypeError("Portal XML nesting is too deep.");
  if (++state.nodes > PORTAL_CONFIGURATION_LIMITS.maximumXmlNodes) throw new TypeError("Portal XML has too many elements.");
  const attributes = normalizeAttributes(value.attributes ?? {}, `${path}.attributes`);
  if (value.name === "param" && SENSITIVE_NAME.test(attributes.name ?? "")) {
    throw new TypeError(`${path} contains a credential-like parameter.`);
  }
  for (const name of ["href", "url", "src"]) {
    if (attributes[name]) assertCredentialFreeUrl(attributes[name], `${path}.attributes.${name}`);
  }
  state.attributes += Object.keys(attributes).length;
  if (state.attributes > PORTAL_CONFIGURATION_LIMITS.maximumXmlAttributes) throw new TypeError("Portal XML has too many attributes.");
  const text = boundedText(value.text ?? "", 16_384, `${path}.text`, {allowEmpty: true});
  if (value.name === "url" && text) assertCredentialFreeUrl(text, `${path}.text`);
  state.text += text.length;
  if (state.text > PORTAL_CONFIGURATION_LIMITS.maximumTextCharacters) throw new TypeError("Portal XML contains too much text.");
  const children = boundedArray(value.children ?? [], PORTAL_CONFIGURATION_LIMITS.maximumXmlNodes, `${path}.children`)
    .map((child, index) => normalizeXmlNode(child, `${path}.children[${index}]`, state, depth + 1));
  return {name: value.name, attributes, text, children};
}

function normalizeAttributes(value, path) {
  if (!record(value)) throw new TypeError(`${path} must be an object.`);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key) || !XML_NAME.test(key)) throw new TypeError(`${path} contains an invalid attribute name.`);
    output[key] = boundedText(entry, 2048, `${path}.${key}`, {allowEmpty: true});
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function deriveSearches(tools) {
  const searches = [];
  visitTools(tools, [], (tool, parents) => {
    if (tool.kind !== "tool" || tool.type !== "service") return;
    if (!parents.some((parent) => parent.name.toLowerCase().includes("search")) && !tool.name.toLowerCase().includes("search") && !tool.name.toLowerCase().includes("geocode")) return;
    searches.push({name: tool.name, title: tool.title, service: tool.name});
  });
  return searches;
}

function deriveServices(tools) {
  const services = [];
  visitTools(tools, [], (tool) => {
    if (tool.kind === "tool" && tool.type === "service") services.push({name: tool.name, title: tool.title});
  });
  return services;
}

function visitTools(nodes, parents, callback) {
  for (const node of nodes) {
    callback(node, parents);
    visitTools(node.children, [...parents, node], callback);
  }
}

function uniqueBy(values, key, message) {
  const seen = new Set();
  for (const value of values) {
    const candidate = key(value);
    if (seen.has(candidate)) throw new TypeError(message);
    seen.add(candidate);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function boundedText(value, maximum, label, {allowEmpty = false} = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function boundedNullableText(value, maximum, label) {
  return value === null || value === undefined || value === "" ? null : boundedText(value, maximum, label);
}

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be an array of at most ${maximum} items.`);
  return value;
}

function assertCredentialFreeUrl(value, label) {
  if (!/^https?:\/\//i.test(value)) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid HTTP(S) URL.`);
  }
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
    throw new TypeError(`${label} must not contain credentials or sensitive query fields.`);
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
