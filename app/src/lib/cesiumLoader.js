import {CESIUM_RUNTIME} from "./cesiumRuntime.js";
import {createCesiumAdapter} from "./cesiumAdapter.js";

// No optional runtime assets or scene exist before deliberate load().
export function createCesiumLoader({document:doc=globalThis.document, window:win=globalThis.window, timeoutMs=15000}={}) {
  let pending;
  return Object.freeze({
    load() {
      if (pending) return pending;
      pending = new Promise((resolve,reject)=>{
        const script=doc.createElement("script"), css=doc.createElement("link");
        let settled=false, loaded=0;
        const fail=()=>{
          if (settled) return; settled=true; clearTimeout(timer);
          script.remove(); css.remove(); reject(Error("cesium_runtime_load_failed"));
        };
        const ready=async()=>{
          if (settled || ++loaded!==2) return;
          try {
            // The module script was SRI-checked; import reuses that module-map
            // entry instead of fetching another SDK or using a blob bootstrap.
            const engine=await import(script.src);
            if (settled) return;
            if (engine.VERSION!==CESIUM_RUNTIME.version) return fail();
            engine.buildModuleUrl.setBaseUrl(new URL(CESIUM_RUNTIME.basePath,doc.baseURI).href);
            const adapter=createCesiumAdapter(engine);
            settled=true; clearTimeout(timer); resolve(adapter);
          } catch { fail(); }
        };
        const timer=setTimeout(fail,timeoutMs);
        // Derived SDK bytes need a new browser cache key even when the upstream
        // version and worker base stay fixed. The edge cutover still invalidates
        // its shared path; the digest also avoids an old immutable browser entry.
        const index=CESIUM_RUNTIME.assets.find(asset=>asset.name==="index.js");
        script.type="module"; script.src=`${CESIUM_RUNTIME.basePath}index.js?sha256=${index.sha256}`;
        css.rel="stylesheet"; css.href=`${CESIUM_RUNTIME.basePath}Widgets/widgets.css`;
        for (const [element,name] of [[script,"index.js"],[css,"Widgets/widgets.css"]]) {
          element.integrity=CESIUM_RUNTIME.assets.find(asset=>asset.name===name).integrity;
          element.crossOrigin="anonymous"; element.referrerPolicy="no-referrer";
          element.onload=ready; element.onerror=fail;
        }
        doc.head.append(css,script);
      }).catch(error=>{pending=null;throw error;});
      return pending;
    }
  });
}
