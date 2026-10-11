const PROTOCOLS = {
  wms: {label: "WMS capabilities", suffix: "/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0", accept: "application/xml"},
  ogc: {label: "OGC API discovery", suffix: "/ogc", accept: "application/json"},
  wmts: {label: "WMTS capabilities", suffix: "/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0", accept: "application/xml"},
  wcs: {label: "WCS capabilities", suffix: "/wcs?SERVICE=WCS&REQUEST=GetCapabilities&VERSION=2.0.1", accept: "application/xml"}
};

export const SERVICE_CONNECTION_PROTOCOLS = Object.entries(PROTOCOLS).map(([value, {label}]) => ({value, label}));

export function serviceConnectionTarget(projectId, slug, protocol = "ogc") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)
    || typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)
    || !Object.hasOwn(PROTOCOLS, protocol)) throw new TypeError("Invalid service connection");
  return {...PROTOCOLS[protocol], path: `/projects/${projectId}${protocol === "wms" ? "" : `/services/${slug}`}${PROTOCOLS[protocol].suffix}`};
}

export function serviceConnectionUrl(baseUrl, target, origin) {
  const base = new URL(baseUrl, origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError("Invalid API connection URL");
  }
  return `${base.href.replace(/\/$/, "")}${target.path}`;
}

export async function readServiceConnection(adapter, projectId, slug, protocol, {signal} = {}) {
  const target = serviceConnectionTarget(projectId, slug, protocol);
  const response = await adapter.requestResponse(target.path, {accept: target.accept, signal});
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error("Service preview unavailable");
    error.status = response.status;
    throw error;
  }
  const media = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (media !== target.accept && !(target.accept === "application/xml" && media === "text/xml")) {
    await response.body?.cancel();
    throw new TypeError("Unexpected service document type");
  }
  const maximum = 2_097_152;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new RangeError("Service document is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Missing service document");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new RangeError("Service document is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (!size) throw new TypeError("Missing service document");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  const content = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  return {content, mediaType: media, bytes: size};
}
