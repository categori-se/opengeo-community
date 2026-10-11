// Real local MapLibre canvas, production Style resolution/installation, synthetic geometry.
export async function verifyStyleCanvas(page, modules) {
  return page.evaluate(async ({workbench, style, maplibre}) => {
    const {addMapLayer, setLayerOpacity} = await import(workbench);
    const {resolveLayerStyle} = await import(style);
    const {default: renderer} = await import(maplibre);
    const layer = structuredClone(document.querySelector('.opengeo-workbench').__opengeoLayers.find(layer=>layer.styleReference));
    const resolved = await resolveLayerStyle(globalThis.__acceptanceAdapter, layer);
    const container = document.createElement('div');
    Object.assign(container.style, {position:'fixed',top:'0',left:'0',width:'256px',height:'256px',zIndex:'99999'});
    document.body.append(container);
    const map = new renderer.Map({container,style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]},center:[0,0],zoom:3,preserveDrawingBuffer:true,attributionControl:false,interactive:false});
    const failures=[];map.on('error',e=>failures.push(e.error?.message));
    const idle = () => new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Canvas did not settle')),10000);
      map.once('idle',()=>{clearTimeout(timeout);resolve();});map.triggerRepaint();
    });
    const require = (condition,message) => {if(!condition)throw Error(message);};
    const pixels = () => {
      const canvas=map.getCanvas(),gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
      const values=new Uint8Array(4*canvas.width*canvas.height);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,values);
      return values;
    };
    const count = (data,color) => {let n=0;for(let i=0;i<data.length;i+=4)if(color.every((v,j)=>Math.abs(data[i+j]-v)<=3))n++;return n;};
    try {
      await idle();
      const state={map,layerHandles:new Map(),resolvedLayerStyles:new Map([[layer.layerId,resolved]])};
      const geometry={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[[-10,0],[10,0]]}}]};
      layer.visible=true;layer.opacity=1;
      addMapLayer(state,layer,geometry,[]);await idle();
      require(count(pixels(),[18,52,86])>30,'Pinned Style color was not painted');
      const handle=state.layerHandles.get(layer.layerId);
      for(const id of handle.layerIds)map.setLayoutProperty(id,'visibility','none');
      await idle();require(count(pixels(),[18,52,86])===0,'Hidden Layer still paints');
      for(const id of handle.layerIds)map.setLayoutProperty(id,'visibility','visible');
      setLayerOpacity(state,layer.layerId,0.5);
      require(map.getPaintProperty(handle.paintLayerIds[0],'line-opacity')===1,'Composite slider changed feature opacity');
      require(map.getPaintProperty(handle.paintLayerIds[0],'line-layer-opacity')===0.5,'Composite slider did not set pass opacity');
      await idle();require(count(pixels(),[137,154,171])>30,'Layer opacity was not composited');
      // A second pass tests renderer stack order on the same synthetic geometry.
      map.addLayer({id:'order-probe',type:'line',source:handle.sourceId,paint:{'line-color':'#ff0000','line-width':6}});
      await idle();require(count(pixels(),[255,0,0])>30,'Top pass was not painted');
      map.moveLayer(handle.paintLayerIds[0]);setLayerOpacity(state,layer.layerId,1);
      await idle();require(count(pixels(),[18,52,86])>30,'Layer order did not change portrayal');
      for(const id of [...handle.layerIds,'order-probe'])map.setLayoutProperty(id,'visibility','none');
      const pointStyle={parts:[{id:'point',type:'circle',paint:{'circle-color':'#ff0000','circle-radius':10,'circle-stroke-color':'#00ff00','circle-stroke-width':5,'circle-stroke-opacity':0.6}}]};
      const pointData={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[0,0]}}]};
      for(const [id,opacity] of [['transparent-point',0],['faded-point',0.5]]) {
        const point={...layer,layerId:id,geometryType:'Point',opacity,opacityMode:'feature'};
        state.resolvedLayerStyles.set(id,pointStyle);addMapLayer(state,point,pointData,[]);await idle();
        if(opacity===0)require(count(pixels(),[255,255,255])===256*256,'Transparent point outline still paints');
        else require(count(pixels(),[178,255,178])>10,'Point outline does not respect Style and Layer opacity');
      }
      require(failures.length===0,failures.join('; '));
      return {savedCompositeSliderPixels:true,pinnedStylePixels:true,visibilityPixels:true,opacityPixels:true,renderOrderPixels:true,pointOutlineOpacityPixels:true,geometry:'synthetic local LineString and Point',renderer:'local Chromium WebGL; physical GPU not established'};
    } finally {map.remove();container.remove();}
  }, modules);
}
