const STYLE_KINDS = new Set(["maplibre-style", "provider-style"]);
const RASTER_KINDS = new Set(["raster", "provider-raster", "governed-raster"]);

export const BASEMAP_ACTIVATION_LIMITS = Object.freeze({
  timeoutMilliseconds: 8_000,
  probeSizePixels: 256
});

export function basemapRequiresNetworkProbe(basemap) {
  return STYLE_KINDS.has(basemap?.kind) || RASTER_KINDS.has(basemap?.kind);
}

export function basemapProbeStyle(basemap) {
  if (STYLE_KINDS.has(basemap?.kind) && typeof basemap.styleUrl === "string") {
    return basemap.styleUrl;
  }
  if (RASTER_KINDS.has(basemap?.kind) && typeof basemap.url === "string") {
    return {
      version: 8,
      sources: {
        candidate: {
          type: "raster",
          tiles: [basemap.url],
          tileSize: basemap.tileSize ?? 256,
          scheme: basemap.scheme ?? "xyz",
          minzoom: basemap.minZoom ?? 0,
          maxzoom: basemap.maxZoom ?? 22,
          ...(Array.isArray(basemap.sourceConfiguration?.coverageBounds)
            ? {bounds: basemap.sourceConfiguration.coverageBounds}
            : {}),
          attribution: basemap.attribution
        }
      },
      layers: [{id: "candidate", type: "raster", source: "candidate"}]
    };
  }
  throw new Error("unsupported_basemap_probe");
}

export function basemapProbeView(basemap, currentView = {}) {
  const bounds = basemap?.sourceConfiguration?.coverageBounds;
  const boundedCenter = Array.isArray(bounds)
    && bounds.length === 4
    && bounds.every(Number.isFinite)
    && bounds[0] < bounds[2]
    && bounds[1] < bounds[3]
    ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
    : null;
  const currentCenter = Array.isArray(currentView.center)
    && currentView.center.length === 2
    && currentView.center.every(Number.isFinite)
    ? currentView.center
    : [0, 0];
  const minimumZoom = basemap?.minZoom ?? 0;
  const maximumZoom = basemap?.maxZoom ?? 22;
  const requestedZoom = Number.isFinite(currentView.zoom) ? currentView.zoom : 2;
  const currentWithinCoverage = boundedCenter &&
    currentCenter[0] >= bounds[0] && currentCenter[0] <= bounds[2] &&
    currentCenter[1] >= bounds[1] && currentCenter[1] <= bounds[3];
  return Object.freeze({
    center: currentWithinCoverage ? currentCenter : boundedCenter ?? currentCenter,
    zoom: Math.min(maximumZoom, Math.max(minimumZoom, requestedZoom))
  });
}

export function basemapActivationFailureMessage({candidateTitle, currentTitle, code}) {
  const reason = code === "timeout"
    ? "did not become ready within 8 seconds"
    : code === "connection"
      ? "could not be resolved through its project connection"
      : "reported a loading or rendering error";
  return `${candidateTitle} ${reason}. ${currentTitle} is still displayed and remains the saved selection.`;
}
