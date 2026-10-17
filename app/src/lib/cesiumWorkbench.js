import {createCesiumFrameScene} from './cesiumFrame.js';
import {cesiumLayerCompatibility} from './cesiumLayers.js';
import {mapboxCompatibility} from './mapboxAdapter.js';
import {cesiumBasemapContent} from './cesiumBasemap.js';

export const rendererTitle = id => ({maplibre:'MapLibre',mapbox:'Mapbox',cesium:'Cesium'}[id] ?? id);

export function cesiumWorkbenchContent(context) {
  const {state,layers,dataByLayerId}=context;
  const style=state.map?.getStyle();
  const entries=[...layers].reverse().map(layer=>({layer,geojson:dataByLayerId.get(layer.layerId),
    labelPart:(style?.layers??[]).find(part=>part.id===state.layerHandles.get(layer.layerId)?.labelLayerId),
    parts:(style?.layers??[]).filter(part=>state.layerHandles.get(layer.layerId)?.paintLayerIds?.includes(part.id))
      // Workbench sets this layout property from Layer visibility. The native
      // adapter has a separate Layer switch, so hidden Layers must remain showable.
      .map(part=>({...part,layout:{...part.layout,visibility:'visible'}}))}));
  const report=cesiumLayerCompatibility(entries);
  const add=(code,message)=>report.issues.push({code,message});
  for(const issue of mapboxCompatibility({state,layers}).issues.filter(issue=>['active-edit','planet','terrain-scene','archive-protocol','point-clustering'].includes(issue.code)))report.issues.push(issue);
  if(context.loadingDatasetLayerIds.size || context.liveFeatureRequests.size) add('loading','Wait for Layers to finish loading before switching.');
  if(layers.some(layer=>layer.sourceType==='external-feature-reference')) add('live-source','Live feature-service queries need a Cesium view adapter; keep the current renderer.');
  if(layers.some(layer=>layer.sourceType==='kml-places')) add('kml','KML Places and overlays currently need MapLibre.');
  if(state.featureHaloEnabled || state.measurePoints?.length || state.queryResult?.features?.length
    || state.historicalImagery?.enabled || state.historicalImagery?.sunlight?.enabled || state.graticule)
    add('overlays','Turn off temporary highlights, results, measurements and view overlays before switching.');
  const owned=new Set(entries.flatMap(entry=>entry.parts.map(part=>part.id)));
  if((style?.layers??[]).some(part=>!owned.has(part.id) && part.layout?.visibility!=="none"
    && part.id.startsWith('opengeo-') && style.sources?.[part.source]?.data?.features?.length))
    add('transient-content','Clear the displayed temporary overlays before switching.');
  report.ready=report.issues.length===0;
  return {entries,...report,...cesiumBasemapContent(style,state.currentBasemapId)};
}

// A narrow bridge for shared Project saving, camera fitting and restoration.
// It does not pretend to implement the GL style API. Native-mode controls call
// explicit scene operations; the retained style is only for switching back.
export async function prepareCesiumWorkbench({container,entries,basemap,snapshot,signal}) {
  const scene=await createCesiumFrameScene({container,entries,basemap,camera:snapshot.camera,signal});
  const style=structuredClone(snapshot.style);
  let closed=false;
  const camera=()=>scene.getCamera();
  const move=options=>scene.setCamera({...camera(),...options});
  const map={scene,basemap,
    setBasemapOpacity(value) {
      scene.setBasemapOpacity(value);
      const part=style.layers.find(part=>part.id==='basemap');
      if(part)part.paint={...part.paint,'raster-opacity':value};
    },
    getStyle:()=>structuredClone(style),isStyleLoaded:()=>!closed,
    getCenter:()=>{const [lng,lat]=camera().center;return {lng,lat};},
    getZoom:()=>camera().zoom,getPitch:()=>camera().pitch,getBearing:()=>camera().bearing,
    jumpTo:move,easeTo:move,flyTo:move,
    resize:()=>{if(!closed)scene.resize();},
    fitBounds(bounds,{padding=64,maxZoom=14}={}) {
      const [[west,south],[east,north]]=bounds.toArray?.()??bounds;
      const mercatorY=lat=>Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,lat))*Math.PI/360));
      const width=Math.max(1,container.clientWidth-2*padding),height=Math.max(1,container.clientHeight-2*padding);
      const dx=Math.max(1e-8,(east-west)/360),dy=Math.max(1e-8,(mercatorY(north)-mercatorY(south))/(2*Math.PI));
      move({center:[(west+east)/2,(south+north)/2],zoom:Math.max(0,Math.min(maxZoom,Math.log2(width/(512*dx)),Math.log2(height/(512*dy)))),pitch:0,bearing:0});
    },
    setLayerVisibility(id,visible) {
      scene.setLayerVisibility(id,visible);
      const entry=entries.find(entry=>entry.layer.layerId===id);
      const ids=new Set([...entry.parts.map(part=>part.id),entry.labelPart?.id]);
      for(const part of style.layers)if(ids.has(part.id))part.layout={...part.layout,visibility:visible?'visible':'none'};
    },
    setLayerOrder(ids) {
      scene.setLayerOrder(ids);
      const parts=new Map(entries.map(entry=>[entry.layer.layerId,new Set(entry.parts.map(part=>part.id))]));
      const owned=new Set(entries.flatMap(entry=>entry.parts.map(part=>part.id)));
      style.layers=[...style.layers.filter(part=>!owned.has(part.id)),...ids.flatMap(id=>style.layers.filter(part=>parts.get(id).has(part.id)))];
    },
    remove(){if(closed)return;closed=true;scene.destroy();}
  };
  return map;
}
export const cesiumWorkbenchAdapter=Object.freeze({id:'cesium',disposeMap:map=>map?.remove()});
