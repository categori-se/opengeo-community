import {cesiumLabelAnchors} from './cesiumLabelAnchors.js';
import {createCesiumLabelLayout} from './cesiumLabelLayout.js';
import {loadCesiumLabelFont} from './cesiumLabels.js';
import {mapLabelTextValues} from './mapFonts.js';
import {CESIUM_RUNTIME} from "./cesiumRuntime.js";
import {cesiumLayerCompatibility, cesiumPassFeatures} from "./cesiumLayers.js";
import {validateCesiumBasemap} from "./cesiumBasemap.js";
import {compileCesiumPass,CESIUM_STYLE_BUDGET} from './cesiumStyle.js';

const EARTH_CIRCUMFERENCE = 40075016.68557849;

// Native scene operations. Deliberately not a pretend MapLibre Map: Workbench
// must use the renderer boundary before offering Cesium as an engine switch.
export function createCesiumAdapter(C) {
  if (C?.VERSION!==CESIUM_RUNTIME.version) throw Error("cesium_runtime_version_mismatch");
  return Object.freeze({id:"cesium",version:C.VERSION,compatibility:cesiumLayerCompatibility,
    async createScene({container,entries,basemap,camera={center:[0,0],zoom:2,bearing:0,pitch:0},signal,timeoutMs=15000}) {
      basemap=validateCesiumBasemap(basemap);
      const report=cesiumLayerCompatibility(entries);
      if (!report.ready) throw Object.assign(Error("cesium_content_unsupported"),{issues:report.issues});
      // Immutable adapter snapshot; the caller retains canonical definitions.
      entries=structuredClone(entries);
      const records=new Map(), identities=new WeakMap(), pickListeners=new Set(), cameraListeners=new Set();
      const styleBudget={remaining:CESIUM_STYLE_BUDGET};
      const basemapErrorListeners=new Set();
      let removeCameraListener=null,removeImageryError=null,imagery=null,imageryFailed=false;
      let viewer, labelFont=null, labelLayout=null, destroyed=false, cancelReady=null, lastCamera=structuredClone(camera);
      const ensure=()=>{if(destroyed || signal?.aborted) throw Error("cesium_scene_cancelled");};
      const requestRender=()=>{ensure();viewer.scene.requestRender();};
      const destroy=()=>{
        if (destroyed) return;
        destroyed=true; cancelReady?.(); signal?.removeEventListener("abort",destroy);
        removeCameraListener?.();removeImageryError?.();pickListeners.clear();cameraListeners.clear();basemapErrorListeners.clear();
        labelLayout?.destroy();
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        labelFont?.destroy();
      };
      const color=(value,fallback,opacity=1)=>{
        const parsed=Array.isArray(value)?new C.Color(...value):C.Color.fromCssColorString(value??fallback);
        if (!parsed || opacity<0 || opacity>1) throw Error("cesium_color_unsupported");
        return parsed.withAlpha(parsed.alpha*opacity);
      };
      function setCamera(value) {
        ensure();
        if (!Array.isArray(value.center) || value.center.length!==2 || !value.center.every(Number.isFinite)
          || Math.abs(value.center[0])>180 || Math.abs(value.center[1])>85
          || !Number.isFinite(value.zoom) || value.zoom<0 || value.zoom>24
          || !Number.isFinite(value.bearing??0) || !Number.isFinite(value.pitch??0)
          || (value.pitch??0)<0 || (value.pitch??0)>85) throw Error("cesium_camera_unsupported");
        const height=Math.max(1,viewer.scene.canvas.clientHeight), fovy=viewer.camera.frustum.fovy;
        const metresPerPixel=EARTH_CIRCUMFERENCE*Math.cos(C.Math.toRadians(value.center[1]))/(512*2**value.zoom);
        const range=metresPerPixel*height/(2*Math.tan(fovy/2));
        viewer.camera.lookAt(C.Cartesian3.fromDegrees(...value.center),new C.HeadingPitchRange(
          C.Math.toRadians(value.bearing??0),C.Math.toRadians((value.pitch??0)-90),range));
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        lastCamera=structuredClone(value); requestRender();
      }
      function getCamera() {
        ensure();
        const canvas=viewer.scene.canvas;
        const target=viewer.camera.pickEllipsoid(new C.Cartesian2(canvas.clientWidth/2,canvas.clientHeight/2),viewer.scene.globe.ellipsoid);
        if (!target) return structuredClone(lastCamera);
        const cartographic=C.Cartographic.fromCartesian(target), latitude=C.Math.toDegrees(cartographic.latitude);
        const range=C.Cartesian3.distance(viewer.camera.positionWC,target);
        const metresPerPixel=2*range*Math.tan(viewer.camera.frustum.fovy/2)/Math.max(1,canvas.clientHeight);
        const inverse=C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(target),new C.Matrix4());
        const offset=C.Matrix4.multiplyByPoint(inverse,viewer.camera.positionWC,new C.Cartesian3());
        const up=C.Matrix4.multiplyByPointAsVector(inverse,viewer.camera.upWC,new C.Cartesian3());
        return {center:[C.Math.toDegrees(cartographic.longitude),latitude],
          zoom:Math.log2(EARTH_CIRCUMFERENCE*Math.cos(cartographic.latitude)/(512*metresPerPixel)),
          bearing:C.Math.toDegrees(Math.atan2(up.x,up.y)),
          pitch:C.Math.toDegrees(Math.atan2(Math.hypot(offset.x,offset.y),offset.z))};
      }
      function setLayerOrder(ids) {
        ensure();
        if (ids.length!==records.size || new Set(ids).size!==records.size || ids.some(id=>!records.has(id))) throw Error("cesium_layer_order_invalid");
        labelLayout?.setOrder(ids);
        let zIndex=0;
        for (const id of ids) for (const {source} of records.get(id)) {
          viewer.dataSources.raiseToTop(source);
          for (const entity of source.entities.values) {
            if (entity.polygon) entity.polygon.zIndex=zIndex;
            if (entity.polyline) entity.polyline.zIndex=zIndex;
          }
          zIndex++;
        }
        requestRender();
      }
      function pick({x,y}) {
        ensure(); const hit=viewer.scene.pick(new C.Cartesian2(x,y));
        const identity=hit?.id && identities.get(hit.id);
        return identity?structuredClone(identity):null;
      }
      const listen=(listeners,callback)=>{ensure();listeners.add(callback);return ()=>listeners.delete(callback);};
      async function addLabels(entry) {
        if(!entry.layer.labels?.enabled)return;
        const {layer,labelPart}=entry,options=layer.labels;
        const program=compileCesiumPass({...entry.parts[0],filter:labelPart.filter});
        const data=cesiumLabelAnchors(entry.geojson,feature=>program.accepts(feature,styleBudget));
        const texts=mapLabelTextValues(layer,entry.geojson),size=options.size??12;
        const source=new C.GeoJsonDataSource(`${layer.layerId}/labels`);
        await source.load(data,{clampToGround:true,describe:()=>undefined});ensure();
        for(const entity of source.entities.values) {
          const index=entity.properties.opengeoFeatureIndex.getValue();
          const text=labelFont.text(texts[index],size);
          entity.billboard=undefined;entity.name=layer.title;entity.description=undefined;
          entity.label=new C.LabelGraphics({text:text.text,font:text.font,
            fillColor:color(options.color,'#111827'),outlineColor:color(options.haloColor,'#ffffff'),
            outlineWidth:options.haloWidth??1.2,style:C.LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin:C.HorizontalOrigin.CENTER,verticalOrigin:C.VerticalOrigin.TOP,
            pixelOffset:new C.Cartesian2(0,size*1.1),heightReference:C.HeightReference.CLAMP_TO_GROUND});
          identities.set(entity,{layerId:layer.layerId,featureIndex:index,feature:entry.geojson.features[index]});
          labelLayout.add({layerId:layer.layerId,entity,source,allowOverlap:options.allowOverlap===true,
            metrics:text.metrics,size,halo:options.haloWidth??1.2,hasText:Boolean(text.text.trim())});
        }
        source.show=layer.visible!==false;
        await viewer.dataSources.add(source);ensure();
        records.get(layer.layerId).push({source,passVisible:true});
      }
      async function addPass(entry,part) {
        const program=compileCesiumPass(part);
        const data=cesiumPassFeatures(entry.geojson,part.type,feature=>program.accepts(feature,styleBudget));
        const source=new C.GeoJsonDataSource(`${entry.layer.layerId}/${part.id}`);
        await source.load(data,{clampToGround:true,describe:()=>undefined}); ensure();
        for (const entity of source.entities.values) {
          const index=entity.properties.opengeoFeatureIndex.getValue();
          const p=program.paint(entry.geojson.features[index],styleBudget);
          identities.set(entity,{layerId:entry.layer.layerId,featureIndex:index,feature:entry.geojson.features[index]});
          entity.name=entry.layer.title; entity.description=undefined;
          if (entity.billboard) {
            entity.billboard=undefined;
            entity.point=new C.PointGraphics({pixelSize:2*(p["circle-radius"]??5),
              color:color(p["circle-color"],"#000000",p["circle-opacity"]??1),
              outlineColor:color(p["circle-stroke-color"],"#000000",p["circle-stroke-opacity"]??1),
              outlineWidth:p["circle-stroke-width"]??0,heightReference:C.HeightReference.CLAMP_TO_GROUND});
          }
          if (entity.polygon) {
            entity.polygon.outline=false;
            entity.polygon.material=color(p["fill-color"],"#000000",p["fill-opacity"]??1);
          }
          if (entity.polyline) {
            entity.polyline.width=p["line-width"]??1;
            entity.polyline.material=color(p["line-color"],"#000000",p["line-opacity"]??1);
          }
        }
        const passVisible=part.layout?.visibility!=="none";
        source.show=entry.layer.visible!==false && passVisible;
        await viewer.dataSources.add(source); ensure();
        records.get(entry.layer.layerId).push({source,passVisible});
      }
      try {
        ensure();
        if(entries.some(entry=>entry.layer.labels?.enabled))labelFont=await loadCesiumLabelFont(container.ownerDocument,signal);
        ensure();
        viewer=new C.Viewer(container,{baseLayer:false,baseLayerPicker:false,terrainProvider:new C.EllipsoidTerrainProvider(),
          animation:false,timeline:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,
          fullscreenButton:false,infoBox:false,selectionIndicator:false,skyBox:false,skyAtmosphere:false,
          scene3DOnly:true,shouldAnimate:false,requestRenderMode:true,maximumRenderTimeChange:Infinity,targetFrameRate:30,
          contextOptions:{webgl:{preserveDrawingBuffer:true}}});
        if(labelFont)labelLayout=createCesiumLabelLayout(C,viewer);
        viewer.scene.globe.baseColor=C.Color.fromCssColorString("#dbe5e8");
        viewer.scene.globe.enableLighting=false;
        // Fetch the current view, without speculative ancestor/sibling imagery.
        viewer.scene.globe.preloadAncestors=false;
        viewer.scene.globe.preloadSiblings=false;
        if (viewer.scene.sun) viewer.scene.sun.show=false;
        if (viewer.scene.moon) viewer.scene.moon.show=false;
        if(basemap) {
          const provider=new C.UrlTemplateImageryProvider({url:basemap.url,
            tileWidth:basemap.tileSize,tileHeight:basemap.tileSize,
            tilingScheme:new C.WebMercatorTilingScheme(),
            rectangle:C.Rectangle.fromDegrees(...basemap.bounds),
            minimumLevel:basemap.minZoom,maximumLevel:basemap.maxZoom,
            credit:new C.Credit(basemap.attribution,true),enablePickFeatures:false});
          removeImageryError=provider.errorEvent.addEventListener(error=>{
            error.retry=false;if(imageryFailed)return;imageryFailed=true;
            cancelReady?.('cesium_basemap_failed');
            for(const callback of basemapErrorListeners)callback('The background could not load. Layers are retained; switch back or check the source connection.');
          });
          imagery=viewer.imageryLayers.addImageryProvider(provider);
          imagery.alpha=basemap.opacity;imagery.show=basemap.visible && basemap.opacity>0;
        }
        signal?.addEventListener("abort",destroy,{once:true});
        setCamera(camera);
        for (const entry of entries) {
          records.set(entry.layer.layerId,[]);
          for (const part of entry.parts) {
            await addPass(entry,part);
            if (part.type==="fill" && part.paint?.["fill-outline-color"]) await addPass(entry,{
              id:`${part.id}/outline`,type:"line",layout:part.layout,
              ...(part.filter?{filter:part.filter}:{}),
              paint:{"line-color":part.paint["fill-outline-color"],"line-width":1,"line-opacity":part.paint["fill-opacity"]??1}});
          }
          await addLabels(entry);
        }
        setLayerOrder(entries.map(entry=>entry.layer.layerId));
        await new Promise((resolve,reject)=>{
          let settled=false, frames=0;
          const finish=error=>{
            if (settled) return; settled=true;
            clearTimeout(timer); clearInterval(refresh); removeRender(); removeError(); cancelReady=null;
            error?reject(Object.assign(Error(error),{readiness:{frames,dataSources:viewer.dataSourceDisplay.ready,globe:viewer.scene.globe.tilesLoaded}})):resolve();
          };
          const removeRender=viewer.scene.postRender.addEventListener(()=>{
            frames++;
            if(imageryFailed)finish('cesium_basemap_failed');
            else if(viewer.dataSourceDisplay.ready && viewer.scene.globe.tilesLoaded && (!labelLayout || frames>=2)) finish();
          });
          const removeError=viewer.scene.renderError.addEventListener(()=>finish("cesium_render_failed"));
          const timer=setTimeout(()=>finish("cesium_scene_timeout"),timeoutMs);
          const refresh=setInterval(()=>viewer.scene.requestRender(),100);
          cancelReady=(reason="cesium_scene_cancelled")=>finish(reason); requestRender();
        });
        ensure();
        viewer.screenSpaceEventHandler.setInputAction(event=>{
          const selection={point:{x:event.position.x,y:event.position.y},feature:pick(event.position)};
          for(const callback of pickListeners)callback(selection);
        },C.ScreenSpaceEventType.LEFT_CLICK);
        removeCameraListener=viewer.camera.changed.addEventListener(()=>{
          lastCamera=getCamera();
          if(cameraListeners.size)for(const callback of cameraListeners)callback(structuredClone(lastCamera));
        });
        return Object.freeze({id:"cesium",viewer,destroy,getCamera,setCamera,requestRender,setLayerOrder,
          setBasemapOpacity(value) {
            ensure();if(!imagery || !Number.isFinite(value) || value<0 || value>1)throw Error('cesium_basemap_opacity_invalid');
            imagery.alpha=value;imagery.show=basemap.visible && value>0;requestRender();
          },
          setLayerVisibility(id,visible) {
            ensure(); if (!records.has(id)) throw Error("cesium_layer_not_found");
            for (const pass of records.get(id)) pass.source.show=Boolean(visible)&&pass.passVisible;
            labelLayout?.invalidate();requestRender();
          },
          pick,
          resize() {ensure();viewer.resize();setCamera(lastCamera);},
          project(position) {
            ensure();const point=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,C.Cartesian3.fromDegrees(...position));
            return point?{x:point.x,y:point.y}:null;
          },
          unproject({x,y}) {
            ensure();const point=viewer.camera.pickEllipsoid(new C.Cartesian2(x,y),viewer.scene.globe.ellipsoid);
            if(!point)return null;
            const value=C.Cartographic.fromCartesian(point);return [C.Math.toDegrees(value.longitude),C.Math.toDegrees(value.latitude)];
          },
          onPick:callback=>listen(pickListeners,callback),
          onBasemapError:callback=>listen(basemapErrorListeners,callback),
          onCameraChange:callback=>listen(cameraListeners,callback)
        });
      } catch(error) {destroy();throw error;}
    }
  });
}
