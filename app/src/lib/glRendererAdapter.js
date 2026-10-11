// SDK ownership only. GL style/camera calls still use the map's native API;
// non-GL engines need a separate capability mapping before admission.
const mapAdapters = new WeakMap();
const registeredProtocols = new WeakMap();

export function rendererAdapterFor(map, fallback) {
  return mapAdapters.get(map) ?? fallback;
}

export function createGlRendererAdapter({id, engine, initialize = () => {}}) {
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
      return map;
    },
    createBounds() { return new engine.LngLatBounds(); },
    createPopup(options) { return new engine.Popup(options); },
    disposeMap(map) {
      if (!map || disposed.has(map)) return;
      if (mapAdapters.get(map) !== adapter) throw new Error("renderer_map_owner_mismatch");
      map.remove();
      disposed.add(map);
      mapAdapters.delete(map);
    }
  });
  return adapter;
}
