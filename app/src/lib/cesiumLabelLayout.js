import RBush from 'rbush';

// A conservative screen-space placement pass. Canonical labels are unchanged;
// native projection/font metrics decide which labels fit at the current camera.
export function selectCesiumLabels(items,width,height) {
  const occupied=new RBush(),visible=new Set();
  for(const item of items) {
    const box=item.box;
    if(!item.visible || !box || !Object.values(box).every(Number.isFinite)
      || box.maxX<0 || box.minX>width || box.maxY<0 || box.minY>height)continue;
    if(!item.allowOverlap && occupied.collides(box))continue;
    visible.add(item.id);occupied.insert(box);
  }
  return visible;
}

export function createCesiumLabelLayout(C,viewer) {
  const items=[];let order=new Map(),revision=0,lastRevision=-1,lastWidth=0,lastHeight=0,lastCamera=null;
  const invalidate=()=>revision++;
  const remove=viewer.scene.preRender.addEventListener(()=>{
    const scene=viewer.scene,canvas=scene.canvas,width=canvas.clientWidth,height=canvas.clientHeight;
    if(revision===lastRevision && width===lastWidth && height===lastHeight
      && lastCamera && C.Matrix4.equalsEpsilon(lastCamera,viewer.camera.viewMatrix,1e-10))return;
    lastRevision=revision;lastWidth=width;lastHeight=height;lastCamera=C.Matrix4.clone(viewer.camera.viewMatrix,lastCamera);
    const occluder=new C.EllipsoidalOccluder(scene.globe.ellipsoid,viewer.camera.positionWC);
    const projected=items.map(item=>{
      const position=item.entity.position.getValue(viewer.clock.currentTime);
      const point=position && occluder.isPointVisible(position)?C.SceneTransforms.worldToWindowCoordinates(scene,position):null;
      const padding=item.halo+2,half=item.metrics.width/2+padding;
      // Native top anchor and the shared 1.1-em offset. Extra vertical padding
      // covers glyph ascender/descender differences without using private SDK APIs.
      const top=point?point.y+item.size*1.1-item.size*.25-padding:0;
      return {...item,id:item.entity,visible:item.source.show && Boolean(point) && item.hasText,
        box:point?{minX:point.x-half,maxX:point.x+half,minY:top,maxY:top+item.metrics.height+item.size*.5+2*padding}:null};
    }).sort((a,b)=>(order.get(b.layerId)??0)-(order.get(a.layerId)??0));
    const visible=selectCesiumLabels(projected,width,height);let changed=false;
    for(const item of items) {
      const show=visible.has(item.entity);
      if(item.entity.label.show?.getValue()!==show){item.entity.label.show=show;changed=true;}
    }
    // One follow-up frame applies changed entity properties. No timer/poll loop.
    if(changed)scene.requestRender();
  });
  return {add:item=>{items.push(item);invalidate();},setOrder:ids=>{order=new Map(ids.map((id,index)=>[id,index]));invalidate();},invalidate,destroy:remove};
}
