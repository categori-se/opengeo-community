// ImageServer exportImage is a display surface. Its PNG/JPEG bytes are not
// analytical source pixels and never stand in for a retained original raster.
export function normalizeImageServerTileUrl(tileUrl) {
  // Older saved maps unescaped JSON braces along with MapLibre's bbox token.
  // Normalize only the display URL, preserving the saved source and query values.
  return tileUrl.replaceAll("{", "%7B").replaceAll("}", "%7D")
    .replace(/([?&]bbox=)%7[bB]bbox-epsg-3857%7[dD](?=&|$)/g, "$1{bbox-epsg-3857}");
}

export function imageServerTileUrl(endpoint, configuration) {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== "443") || /[\u0000-\u001f\u007f\\]/.test(endpoint)
    || host === "localhost" || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)
    || [".localhost", ".local", ".internal", ".home.arpa"].some(suffix => host.endsWith(suffix))
    || !/\/ImageServer\/?$/.test(url.pathname)) {
    throw new TypeError("Use a public, credential-free HTTPS ImageServer service URL.");
  }
  if (configuration.serviceKind !== "imageserver"
    || ![256, 512].includes(configuration.tileSize)
    || !["png32", "jpg"].includes(configuration.imageFormat)
    || !["RSP_NearestNeighbor", "RSP_BilinearInterpolation"].includes(configuration.interpolation)
    || !Array.isArray(configuration.bandIds) || ![0, 1, 3].includes(configuration.bandIds.length)
    || configuration.bandIds.some(band => !Number.isInteger(band) || band < 0 || band > 255)) {
    throw new TypeError("Invalid ImageServer display configuration.");
  }
  const rasterIds = configuration.rasterIds === undefined ? [] : configuration.rasterIds;
  if (!Array.isArray(rasterIds) || rasterIds.length > 32
    || Array.from(rasterIds).some(id => !Number.isInteger(id) || id < 0 || id > 2_147_483_647)
    || new Set(rasterIds).size !== rasterIds.length) {
    throw new TypeError("Invalid ImageServer raster selection.");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/exportImage";
  url.search = new URLSearchParams({
    f: "image", bbox: "{bbox-epsg-3857}", bboxSR: "3857", imageSR: "3857",
    size: `${configuration.tileSize},${configuration.tileSize}`,
    format: configuration.imageFormat, interpolation: configuration.interpolation,
    adjustAspectRatio: "false",
    ...(configuration.bandIds.length ? {bandIds: configuration.bandIds.join(",")} : {}),
    ...(rasterIds.length ? {mosaicRule: JSON.stringify({mosaicMethod: "esriMosaicLockRaster", lockRasterIds: rasterIds})} : {})
  }).toString();
  return normalizeImageServerTileUrl(url.href);
}
