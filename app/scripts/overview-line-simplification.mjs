import assert from 'node:assert/strict';

function distanceSquared(p,a,b){
 const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
 const t=den?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den)):0;
 return (p.x-a.x-t*dx)**2+(p.y-a.y-t*dy)**2;
}

// Every accepted chord bounds all vertices of its corresponding source subpath.
// Keep source endpoints, direction and part membership; do not manufacture points.
export function simplifyOverviewLine(feature,{zoom,fullDetailZoom,tolerance}){
 assert.ok(zoom<fullDetailZoom,'Never simplify full-detail lines');
 assert.equal(feature.type,2);
 assert.ok(Number.isFinite(tolerance)&&tolerance>0&&tolerance<=8);
 let before=0,after=0,maximumDeviation=0;
 const geometry=feature.loadGeometry().map(line=>{
  before+=line.length;
  if(line.length<=2){after+=line.length;return line;}
  const keep=new Set([0,line.length-1]),stack=[[0,line.length-1]];
  let lineDeviation=0;
  while(stack.length){
   const [a,b]=stack.pop();let farthest=-1,maximum=0;
   for(let i=a+1;i<b;i++){const d=distanceSquared(line[i],line[a],line[b]);if(d>maximum){maximum=d;farthest=i;}}
   if(maximum>tolerance*tolerance){keep.add(farthest);stack.push([a,farthest],[farthest,b]);}
   else lineDeviation=Math.max(lineDeviation,Math.sqrt(maximum));
  }
  let result=[...keep].sort((a,b)=>a-b).map(i=>line[i]);
  const positive=points=>points.some((p,i)=>i>0&&(p.x!==points[i-1].x||p.y!==points[i-1].y));
  // A closed, subpixel contour must not become a zero-length line.
  if(positive(line)&&!positive(result)){result=line;lineDeviation=0;}
  after+=result.length;maximumDeviation=Math.max(maximumDeviation,lineDeviation);return result;
 });
 return {feature:{id:feature.id,type:feature.type,properties:feature.properties,loadGeometry:()=>geometry},
         before,after,maximumDeviation};
}
