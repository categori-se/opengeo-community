import {MAPBOX_RUNTIME} from "./mapboxRuntime.js";
import {createMapboxAdapter} from "./mapboxAdapter.js";

// No SDK import, network request, worker or Map exists until load() is called
// with a configured public-token session. Reuse SDK bytes, never hidden maps.
export function createMapboxLoader({document: doc = globalThis.document,
  window: win = globalThis.window, timeoutMs = 15000} = {}) {
  let pending = null;
  function loadSDK() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      let loaded = 0, settled = false;
      const script = doc.createElement("script"), css = doc.createElement("link");
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove(); css.remove();
        // Never expose SDK errors/URLs: they can contain credentials.
        reject(new Error("mapbox_runtime_load_failed"));
      };
      const ready = () => {
        if (settled || ++loaded !== 2) return;
        if (win.mapboxgl?.version !== MAPBOX_RUNTIME.version) return fail();
        settled = true;
        clearTimeout(timer);
        resolve(win.mapboxgl);
      };
      const timer = setTimeout(fail, timeoutMs);
      script.src = `${MAPBOX_RUNTIME.basePath}mapbox-gl.js`;
      script.integrity = MAPBOX_RUNTIME.assets.find(a => a.name === "mapbox-gl.js").integrity;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      css.rel = "stylesheet";
      css.href = `${MAPBOX_RUNTIME.basePath}mapbox-gl.css`;
      css.integrity = MAPBOX_RUNTIME.assets.find(a => a.name === "mapbox-gl.css").integrity;
      css.crossOrigin = "anonymous";
      css.referrerPolicy = "no-referrer";
      script.onload = css.onload = ready;
      script.onerror = css.onerror = fail;
      doc.head.append(css, script);
    }).catch(error => { pending = null; throw error; });
    return pending;
  }
  return Object.freeze({
    async load(session) {
      if (!session?.configured) throw new Error("mapbox_public_token_required");
      const engine = await loadSDK();
      // Recheck after asynchronous loading in case the user cleared the token.
      return createMapboxAdapter(engine, session);
    }
  });
}
