// Clipping can introduce rectangle corners inside a source polygon, away from its edges.
export function pointInPolygon(point,rings){
 const inRing=ring=>{
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
   const a=ring[i],b=ring[j];
   if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
 };
 return rings.length>0&&inRing(rings[0])&&!rings.slice(1).some(inRing);
}

export function isExpectedClippingCorner({position,rings,point,previous,next,extent,buffer}){
 const onX=point.x===-buffer||point.x===extent+buffer;
 const onY=point.y===-buffer||point.y===extent+buffer;
 const distinct=p=>p.x!==point.x||p.y!==point.y;
 const followsClipEdges=(previous.x===point.x&&next.y===point.y)||(previous.y===point.y&&next.x===point.x);
 return onX&&onY&&distinct(previous)&&distinct(next)&&followsClipEdges&&pointInPolygon(position,rings);
}
