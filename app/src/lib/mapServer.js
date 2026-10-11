// Map export images are live display data, never original raster files.
export function mapServerTileUrl(endpoint, configuration) {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== "443") || /[\u0000-\u001f\u007f\\]/.test(endpoint)
    || host === "localhost" || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)
    || [".localhost", ".local", ".internal", ".home.arpa"].some(suffix => host.endsWith(suffix))
    || !/\/MapServer\/?$/.test(url.pathname)) {
    throw new TypeError("Use a public, credential-free HTTPS MapServer service URL.");
  }
  const ids = configuration.layerIds;
  if (configuration.serviceKind !== "mapserver" || ![256, 512].includes(configuration.tileSize)
    || configuration.imageFormat !== "png32" || !Array.isArray(ids) || !ids.length || ids.length > 32
    || ids.some(id => !Number.isInteger(id) || id < 0 || id > 1000000) || new Set(ids).size !== ids.length) {
    throw new TypeError("Invalid MapServer display configuration.");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/export";
  url.search = new URLSearchParams({f: "image", bbox: "{bbox-epsg-3857}", bboxSR: "3857", imageSR: "3857",
    size: `${configuration.tileSize},${configuration.tileSize}`, format: "png32", transparent: "true",
    layers: `show:${ids.join(",")}`}).toString();
  return url.href.replaceAll("%7B", "{").replaceAll("%7D", "}");
}
