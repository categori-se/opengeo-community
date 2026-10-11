import {createGlRendererAdapter} from "./glRendererAdapter.js";
import {isRegisteredMapFont} from "./mapFonts.js";
import {MAPBOX_RUNTIME} from "./mapboxRuntime.js";

export const MAPBOX_VERSION = MAPBOX_RUNTIME.version;

export function createMapboxAdapter(engine, session) {
  if (engine?.version !== MAPBOX_VERSION) throw new Error("mapbox_runtime_version_mismatch");
  if (!session?.configured) throw new Error("mapbox_public_token_required");
  // Pass tokens per Map, never through the SDK's process-wide accessToken setter.
  const sdk = {
    getVersion: () => engine.version,
    Map: class {
      constructor(options) {
        const map = new engine.Map(session.mapOptions({...options, localFontFamily:null}));
        const set = map.setProjection?.bind(map), get = map.getProjection?.bind(map);
        if (set && get) {
          map.setProjection = projection => set(typeof projection === "string" ? projection : {name:projection.type ?? projection.name});
          map.getProjection = () => { const value=get(); return {...value, type:value.name}; };
        }
        // Native Mapbox names differ; keep the shared font boundary explicit.
        if (map.getGlyphsUrl && map.setGlyphsUrl) {
          map.getGlyphs = map.getGlyphsUrl.bind(map);
          map.setGlyphs = map.setGlyphsUrl.bind(map);
        }
        return map;
      }
    },
    Popup: engine.Popup,
    LngLatBounds: engine.LngLatBounds,
    addProtocol() { throw new Error("mapbox_custom_protocol_not_supported"); }
  };
  return createGlRendererAdapter({id: "mapbox", engine: sdk});
}

// A readiness report, not permission to drop incompatible content. Check hidden
// layers too: toggling visibility must not turn a retained definition into loss.
export function mapboxCompatibility({layers = [], style = null, state = {}, allowPendingFonts = false}) {
  const issues = [];
  const add = (code, message, layer = null) => issues.push({code, message,
    ...(layer ? {layerId: layer.layerId, title: layer.title ?? layer.layerId} : {})});
  for (const layer of layers) {
    if (["pmtiles-vector", "pmtiles-raster"].includes(layer.sourceType)
      || state.archiveTileSessions?.has(layer.layerId)) {
      add("archive-protocol", "This archive needs the MapLibre protocol adapter.", layer);
    }
    if (layer.labels?.enabled && (!isRegisteredMapFont(layer.labels.fontRef)
      || !(state.mapFontSession?.supportsRenderer("mapbox") || (allowPendingFonts && state.mapFontSession?.available)))) {
      add("pinned-fonts", "Choose and load a supported pinned font in Layer Properties before using Mapbox labels.", layer);
    }
    if (layer.opacityMode === "composite") add("composite-opacity", "Composite layer opacity has not been mapped to Mapbox.", layer);
    if (layer.sourceType === "kml-places") add("kml-presentation", "KML Places and overlays currently use MapLibre.", layer);
  }
  for (const source of Object.values(style?.sources ?? {})) {
    const urls = [source.url, ...(source.tiles ?? [])];
    if (urls.some(url => typeof url === "string" && /^(pmtiles|reviewed-archive|opengeo-font):/.test(url))) {
      add("style-protocol", "The displayed style uses a MapLibre-specific source protocol.");
    }
  }
  if (style?.glyphs?.startsWith("opengeo-font:") && !(state.mapFontSession?.supportsRenderer("mapbox")
    && state.mapFontSession.ownsGlyphTemplate(style.glyphs))) add("style-fonts", "The displayed style's pinned font transport is unavailable.");
  if (Array.isArray(style?.sprite)) add("multi-sprite", "This style's multiple sprite sheets need MapLibre.");
  if (style?.layers?.some(layer => Object.keys(layer.paint ?? {}).some(key => key.endsWith("-layer-opacity")))) {
    add("style-composite-opacity", "The displayed style uses MapLibre composite opacity.");
  }
  if (state.spatialBody?.id && state.spatialBody.id !== "earth") add("planet", "Non-Earth projects require MapLibre for now.");
  if (state.terrainEnabled || state.openScene3dEnabled) add("terrain-scene", "Terrain and 3D scene compatibility needs review before switching.");
  if (state.mapAuthoring || state.temporaryEdit || state.queryDrawing || state.measureMode
    || state.shapeEditor || state.imageOverlayEditor || state.flightSession) {
    add("active-edit", "Finish or cancel the active drawing or measurement before switching.");
  }
  return {ready: issues.length === 0, issues};
}
