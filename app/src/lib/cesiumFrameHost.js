
// Framework fingerprints this module and its imports. Importing it in Studio
// only resolves the host URL; the SDK runs in the marked frame's module realm.
export const CESIUM_FRAME_HOST_URL = import.meta.url;
export const CESIUM_FRAME_PROTOCOL = "opengeo.cesium-frame.1";

if (typeof window!=="undefined" && window.frameElement?.getAttribute("data-opengeo-cesium-frame")==="1") {
  let scene=null, controller=null, opening=false;
  const close=()=>{controller?.abort();scene?.destroy();scene=null;};
  const methods=new Set(["getCamera","setCamera","setLayerVisibility","setLayerOrder","setBasemapOpacity","pick","project","unproject","requestRender","resize"]);
  window.opengeoCesiumFrame=Object.freeze({
    protocol:CESIUM_FRAME_PROTOCOL,
    async open(options) {
      if (opening || scene) throw Error("cesium_frame_already_open");
      opening=true; controller=new AbortController();
      const {createCesiumLoader}=await import("./cesiumLoader.js");
      if(controller.signal.aborted)throw Error("cesium_scene_cancelled");
      const adapter=await createCesiumLoader().load();
      if (controller.signal.aborted) throw Error("cesium_scene_cancelled");
      scene=await adapter.createScene({...options,container:document.body,signal:controller.signal});
      return {id:adapter.id,version:adapter.version};
    },
    invoke(name,args) {
      if (!scene || !methods.has(name)) throw Error("cesium_frame_operation_unavailable");
      return scene[name](...args);
    },
    listen(name,callback) {
      if (!scene || !["onPick","onCameraChange","onBasemapError"].includes(name)) throw Error("cesium_frame_event_unavailable");
      return scene[name](callback);
    },
    close
  });
  window.addEventListener("pagehide",close,{once:true});
}
