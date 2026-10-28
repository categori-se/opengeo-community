// SDK ownership only. GL style/camera calls still use the map's native API;
// non-GL engines need a separate capability mapping before admission.
const mapAdapters = new WeakMap();
const registeredProtocols = new WeakMap();

export function rendererAdapterFor(map, fallback) {
  return mapAdapters.get(map) ?? fallback;
}

export function createGlRendererAdapter({id, engine, initialize = () => {}, requiresPainter = false}) {
  const disposed = new WeakSet();
  const adapter = Object.freeze({
    id,
    get version() { return engine.getVersion(); },
    initialize,
    registerProtocol(name, handler) {
      let protocols = registeredProtocols.get(engine);
      if (!protocols) registeredProtocols.set(engine, protocols = new Map());
      if (protocols.has(name)) {
        if (protocols.get(name) !== handler) throw new Error("renderer_protocol_conflict");
        return;
      }
      engine.addProtocol(name, handler);
      protocols.set(name, handler);
    },
    createMap(options) {
      const map = new engine.Map(options);
      mapAdapters.set(map, adapter);
      // MapLibre 6 can return from its constructor after WebGL2 setup fails,
      // leaving an object whose resize/remove methods require a missing painter.
      if ((requiresPainter || "painter" in map) && !map.painter) {
        adapter.disposeMap(map);
        throw new Error("renderer_graphics_unavailable");
      }
      return map;
    },
    createBounds() { return new engine.LngLatBounds(); },
    createPopup(options) { return new engine.Popup(options); },
    disposeMap(map) {
      if (!map || disposed.has(map)) return;
      if (mapAdapters.get(map) !== adapter) throw new Error("renderer_map_owner_mismatch");
      disposed.add(map);
      try { map.remove(); }
      catch {
        // A failed/context-lost SDK must not trap the user inside its dialog.
        // Detach its owned surface even when the SDK cannot finish teardown.
        try { map.getCanvas?.()?.remove(); } catch { /* No usable canvas. */ }
      } finally { mapAdapters.delete(map); }
    }
  });
  return adapter;
}
