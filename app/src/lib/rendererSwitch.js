// Prepare in a separate surface. The caller alone commits a ready candidate;
// errors, cancellation and timeouts never dispose or mutate the current map.
export function sameRendererCamera(before,after) {
  const values=view=>[...(view?.center??[]),view?.zoom,view?.pitch,view?.bearing];
  const a=values(before),b=values(after);
  return a.length===5 && b.length===5 && a.every((value,index)=>Number.isFinite(value)
    && Number.isFinite(b[index]) && Math.abs(value-b[index])<=1e-7);
}

export function prepareRendererMap({adapter, container, style, camera, images = [],
  transformRequest, signal, timeoutMs = 15000}) {
  return new Promise((resolve, reject) => {
    let map = null, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      map?.off("error", failed);
      map?.off("idle", ready);
      map?.off("styleimagemissing", imageMissing);
    };
    const finish = (code = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code) {
        try { adapter.disposeMap(map); } catch { /* Keep the original view usable. */ }
        reject(new Error(code));
      } else resolve(map);
    };
    const failed = () => finish("renderer_candidate_failed");
    const aborted = () => finish("renderer_switch_cancelled");
    const ready = () => { if (map?.isStyleLoaded()) finish(); };
    const imageMissing = ({id}) => {
      const image = images.find(item => item.id === id);
      if (!image) return failed();
      try { map.addImage(id, image.pixels, image.options); } catch { failed(); }
    };
    const timer = setTimeout(() => finish("renderer_switch_timeout"), timeoutMs);
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, {once:true});
    try {
      adapter.initialize();
      map = adapter.createMap({container, style, ...camera, transformRequest,
        attributionControl:{compact:false}, preserveDrawingBuffer:true,
        canvasContextAttributes:{preserveDrawingBuffer:true}});
      map.on("error", failed);
      map.on("idle", ready);
      map.on("styleimagemissing", imageMissing);
    } catch { failed(); }
  });
}

export function rendererStyle(style, engineId, retainedSky = null) {
  const copy = structuredClone(style);
  const projection = copy.projection?.type ?? copy.projection?.name ?? "mercator";
  if (!["mercator", "globe"].includes(projection)) throw Error("renderer_projection_unsupported");
  copy.projection = engineId === "mapbox" ? {name:projection} : {type:projection};
  // Sky is an engine presentation option, retained separately for switching back.
  // Never remove canonical Layer/Style definitions to make a candidate load.
  if (engineId === "mapbox") delete copy.sky;
  else if (retainedSky) copy.sky = structuredClone(retainedSky);
  return copy;
}
