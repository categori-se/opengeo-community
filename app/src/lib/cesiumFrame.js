import {CESIUM_FRAME_HOST_URL,CESIUM_FRAME_PROTOCOL} from "./cesiumFrameHost.js";
import {CESIUM_FRAME_PATH} from "./cesiumRuntime.js";
import {cesiumLayerCompatibility} from "./cesiumLayers.js";

// This same-origin frame owns SDK lifetime, not authorization. Only our compiled
// host module is loaded; no provider document or user HTML enters the frame.
export function createCesiumFrameScene({container,entries,basemap,camera,signal,timeoutMs=20000}) {
  const report=cesiumLayerCompatibility(entries);
  if (!report.ready) return Promise.reject(Object.assign(Error("cesium_content_unsupported"),{issues:report.issues}));
  if (signal?.aborted) return Promise.reject(Error("cesium_scene_cancelled"));
  if (!Number.isFinite(timeoutMs) || timeoutMs<1 || timeoutMs>60000) return Promise.reject(Error("cesium_timeout_invalid"));
  return new Promise((resolve,reject)=>{
    const doc=container.ownerDocument, frame=doc.createElement("iframe");
    frame.title="Cesium map"; frame.setAttribute("data-opengeo-cesium-frame","1");
    frame.style.cssText="display:block;width:100%;height:100%;border:0";
    frame.referrerPolicy="no-referrer";
    let host=null, settled=false, destroyed=false;
    const fail=code=>{
      if (!settled) {settled=true;reject(Error(code));}
      destroy();
    };
    const destroy=()=>{
      if (destroyed) return; destroyed=true;
      clearTimeout(timer);signal?.removeEventListener("abort",abort);
      try {host?.close();} catch { /* Removing the frame also ends failed SDK teardown. */ }
      host=null;frame.remove();
      if (!settled) {settled=true;reject(Error("cesium_scene_cancelled"));}
    };
    const abort=()=>fail("cesium_scene_cancelled");
    const timer=setTimeout(()=>fail("cesium_frame_timeout"),timeoutMs);
    signal?.addEventListener("abort",abort,{once:true});
    const invoke=(name,...args)=>{
      if (destroyed || !frame.isConnected) throw Error("cesium_scene_closed");
      return structuredClone(host.invoke(name,args));
    };
    const listen=(name,callback)=>{
      if (destroyed || !frame.isConnected) throw Error("cesium_scene_closed");
      return host.listen(name,value=>{if(!destroyed)callback(structuredClone(value));});
    };
    try {
      // A real same-origin URL is required by the SDK's worker-origin checks.
      frame.src=new URL(CESIUM_FRAME_PATH,doc.baseURI).href;
      frame.onload=()=>{
        if (destroyed) return;
        try {
          const child=frame.contentDocument;
          const script=child.createElement("script");script.type="module";script.src=CESIUM_FRAME_HOST_URL;
          script.onerror=()=>fail("cesium_frame_host_failed");
          script.onload=async()=>{
            if (destroyed) return;
            try {
              host=frame.contentWindow.opengeoCesiumFrame;
              if (host?.protocol!==CESIUM_FRAME_PROTOCOL) return fail("cesium_frame_protocol_mismatch");
              const metadata=await host.open({entries:structuredClone(entries),basemap:structuredClone(basemap),camera:structuredClone(camera),timeoutMs});
              if (destroyed) return;
              clearTimeout(timer);settled=true;
              resolve(Object.freeze({...metadata,destroy,
                getCamera:()=>invoke("getCamera"),setCamera:value=>invoke("setCamera",value),
                setLayerVisibility:(id,visible)=>invoke("setLayerVisibility",id,visible),
                setLayerOrder:ids=>invoke("setLayerOrder",ids),
                setBasemapOpacity:value=>invoke("setBasemapOpacity",value),
                pick:point=>invoke("pick",point),project:position=>invoke("project",position),
                unproject:point=>invoke("unproject",point),requestRender:()=>invoke("requestRender"),resize:()=>invoke("resize"),
                onPick:callback=>listen("onPick",callback),onCameraChange:callback=>listen("onCameraChange",callback),
                onBasemapError:callback=>listen("onBasemapError",callback)
              }));
            } catch {if(!destroyed)fail("cesium_frame_scene_failed");}
          };
          child.head.append(script);
        } catch {fail("cesium_frame_host_failed");}
      };
      frame.onerror=()=>fail("cesium_frame_host_failed");
      container.append(frame);
    } catch {fail("cesium_frame_host_failed");}
  });
}
