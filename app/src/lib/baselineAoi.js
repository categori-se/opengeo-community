import {meanRadiusMeters,spatialBodyDefinition} from "./spatialBody.js";

export const BASELINE_AOI_LIMITS=Object.freeze({positions:256,components:8,rings:16,checks:2_000_000,
  prepareMilliseconds:2000,longitudeSpanDegrees:6,latitudeSpanDegrees:6,maximumAbsoluteLatitude:80});
const radius=meanRadiusMeters(spatialBodyDefinition("earth"));
const fail=code=>Object.assign(Error(code),{code});
const plain=value=>value&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const tolerance=(a,b,c)=>64*Number.EPSILON*(Math.abs((b[0]-a[0])*(c[1]-a[1]))+Math.abs((b[1]-a[1])*(c[0]-a[0])))+1e-24;
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const signedArea=ring=>ring.reduce((sum,point,index)=>sum+point[0]*ring[(index+1)%ring.length][1]-point[1]*ring[(index+1)%ring.length][0],0)/2;
const bounds=points=>points.reduce((box,[x,y])=>[Math.min(box[0],x),Math.min(box[1],y),Math.max(box[2],x),Math.max(box[3],y)],[Infinity,Infinity,-Infinity,-Infinity]);
const separate=(a,b)=>a[2]<b[0]||a[0]>b[2]||a[3]<b[1]||a[1]>b[3];
const unit=([longitude,latitude])=>{const lon=longitude*Math.PI/180,lat=latitude*Math.PI/180;
  return [Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];};

/** Prepare one deliberately supplied loaded polygon. Gnomonic straight edges
 * represent shortest great-circle arcs; clipping never reads raster/source data.
 * Invalid topology is rejected, never repaired or summed as an AOI union.
 */
export async function prepareBaselineAoi({geometry,source={},signal,now=()=>performance.now(),
  assertCurrent=()=>{},guard=()=>{},limits={}}={}) {
  const budget={...BASELINE_AOI_LIMITS};
  if(!plain(limits))throw fail("baseline_aoi_limit_invalid");
  for(const [key,value] of Object.entries(limits)) {
    if(!Object.hasOwn(budget,key)||!Number.isFinite(value)||value<=0||value>budget[key])throw fail("baseline_aoi_limit_invalid");
    budget[key]=value;
  }
  const started=now(),stats={checks:0,cellChecks:0,candidateChecks:0,triangleClips:0,topologyChecks:0};
  let preparing=true;
  const verify=()=>{signal?.throwIfAborted();assertCurrent();guard();
    if(preparing&&now()-started>=budget.prepareMilliseconds)throw fail("baseline_aoi_prepare_limit");};
  const work=()=>{if(++stats.checks>budget.checks)throw fail("baseline_aoi_compute_limit");if(stats.checks%64===0)verify();};
  verify();
  const reference=sourceReference(source);
  if(!plain(geometry)||!["Polygon","MultiPolygon"].includes(geometry.type))throw fail("baseline_aoi_polygon_required");
  const input=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;
  if(!Array.isArray(input)||!input.length||input.length>budget.components)throw fail("baseline_aoi_component_limit");
  let positions=0,ringCount=0,west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
  const polygons=input.map(rings=>{
    if(!Array.isArray(rings)||!rings.length)throw fail("baseline_aoi_ring_invalid");
    return rings.map(ring=>{
      if(++ringCount>budget.rings)throw fail("baseline_aoi_ring_limit");
      if(!Array.isArray(ring)||ring.length<4)throw fail("baseline_aoi_ring_invalid");
      positions+=ring.length;if(positions>budget.positions)throw fail("baseline_aoi_position_limit");
      for(let index=0;index<ring.length;index++) {
        work();const point=ring[index];
        if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180
          ||Math.abs(point[1])>budget.maximumAbsoluteLatitude)throw fail("baseline_aoi_coordinate_invalid");
        if(index&&Math.abs(point[0]-ring[index-1][0])>180)throw fail("baseline_aoi_antimeridian_unsupported");
        west=Math.min(west,point[0]);east=Math.max(east,point[0]);south=Math.min(south,point[1]);north=Math.max(north,point[1]);
      }
      if(!same(ring[0],ring.at(-1)))throw fail("baseline_aoi_ring_unclosed");
      return ring.slice(0,-1).map(point=>[...point]);
    });
  });
  if(east-west>budget.longitudeSpanDegrees||north-south>budget.latitudeSpanDegrees)throw fail("baseline_aoi_extent_unsupported");
  const center=[(west+east)/2,(south+north)/2],origin=unit(center),lon=center[0]*Math.PI/180,lat=center[1]*Math.PI/180;
  const eastAxis=[-Math.sin(lon),Math.cos(lon),0],northAxis=[-Math.sin(lat)*Math.cos(lon),-Math.sin(lat)*Math.sin(lon),Math.cos(lat)];
  const project=point=>{const vector=unit(point),denominator=dot(vector,origin);
    if(!Number.isFinite(denominator)||denominator<=.25)throw fail("baseline_aoi_projection_unsupported");
    return [dot(vector,eastAxis)/denominator,dot(vector,northAxis)/denominator];};
  const projected=polygons.map(rings=>rings.map(ring=>ring.map(project)));
  for(const rings of projected) {
    for(const ring of rings)validateRing(ring,work);
    for(let index=1;index<rings.length;index++) {
      rejectRingIntersection(rings[0],rings[index],work);
      if(pointInRing(rings[index][0],rings[0])!==1)throw fail("baseline_aoi_topology_invalid");
      for(let other=1;other<index;other++) {
        rejectRingIntersection(rings[other],rings[index],work);
        if(pointInRing(rings[index][0],rings[other])!==-1||pointInRing(rings[other][0],rings[index])!==-1)throw fail("baseline_aoi_topology_invalid");
      }
    }
  }
  verify();const {default:earcut}=await import("earcut");verify();
  const triangles=[],parts=[];
  for(const rings of projected) {
    const points=rings.flat(),holes=[];let count=rings[0].length;
    for(const ring of rings.slice(1)){holes.push(count);count+=ring.length;}
    const indices=earcut(points.flat(),holes),part=[];let triangleArea=0;
    for(let index=0;index<indices.length;index+=3) {
      work();const triangle=indices.slice(index,index+3).map(vertex=>points[vertex]);
      const area=signedArea(triangle);if(!Number.isFinite(area)||area===0)throw fail("baseline_aoi_topology_invalid");
      if(area<0)triangle.reverse();triangleArea+=Math.abs(area);
      part.push({points:triangle,bounds:bounds(triangle)});
    }
    const expected=Math.abs(signedArea(rings[0]))-rings.slice(1).reduce((sum,ring)=>sum+Math.abs(signedArea(ring)),0);
    if(!part.length||expected<=0||Math.abs(triangleArea-expected)>Math.max(1e-22,expected*1e-10))throw fail("baseline_aoi_topology_invalid");
    for(const earlier of parts)for(const a of earlier)for(const b of part) {
      work();stats.topologyChecks++;if(separate(a.bounds,b.bounds))continue;
      const intersection=clip(a.points,b.points,work),area=Math.abs(signedArea(intersection));
      if(area>Math.max(1e-23,Math.min(Math.abs(signedArea(a.points)),Math.abs(signedArea(b.points)))*1e-12))throw fail("baseline_aoi_topology_invalid");
    }
    parts.push(part);triangles.push(...part);
  }
  const sphericalArea=points=>{
    if(points.length<3)return 0;
    // In the orthonormal gnomonic frame a point's unit vector is
    // (1,x,y)/hypot(1,x,y). Its spherical triangle determinant is the
    // two-dimensional orientation divided by the three vector lengths.
    // Evaluate that difference before normalization: inverse longitude/latitude
    // can round a tiny valid clipped edge onto one duplicate coordinate.
    const a=points[0],lengthA=Math.hypot(1,...a);let area=0;
    for(let index=1;index<points.length-1;index++) {
      const b=points[index],c=points[index+1],determinant=cross(a,b,c);
      if(Math.abs(determinant)<=tolerance(a,b,c))continue;
      const lengthB=Math.hypot(1,...b),lengthC=Math.hypot(1,...c);
      const denominator=1+(1+dot(a,b))/(lengthA*lengthB)+(1+dot(b,c))/(lengthB*lengthC)+(1+dot(c,a))/(lengthC*lengthA);
      if(!Number.isFinite(denominator)||denominator<=0)throw fail("baseline_aoi_cell_geometry_unsupported");
      area+=2*Math.atan2(Math.abs(determinant)/(lengthA*lengthB*lengthC),denominator)*radius**2;
    }
    if(!Number.isFinite(area)||area<0)throw fail("baseline_aoi_cell_geometry_unsupported");return area;
  };
  const areaSquareMeters=triangles.reduce((sum,triangle)=>sum+sphericalArea(triangle.points),0);
  if(!Number.isFinite(areaSquareMeters)||areaSquareMeters<=0)throw fail("baseline_aoi_area_invalid");
  verify();preparing=false;
  const metadata=freeze({kind:"user-supplied-loaded-polygon",geometry:{type:geometry.type,
    coordinates:geometry.type==="Polygon"?polygons[0].map(ring=>[...ring,ring[0]].map(point=>[...point])):
      polygons.map(rings=>rings.map(ring=>[...ring,ring[0]].map(point=>[...point])))},source:reference,
    bounds:[west,south,east,north],positionCount:positions,polygonCount:polygons.length,ringCount,
    areaSquareMeters,method:{id:"gnomonic-geodesic-triangle-cell-intersection",version:"1.0.0",radiusMeters:radius,
      projectionCenter:center,edges:"shortest-great-circle-between-supplied-vertices",areaUnit:"square-meter",
      areaEvaluation:"stable-gnomonic-spherical-triangle-excess",
      topology:"validated-simple-rings-disjoint-filled-components",multipartTouching:"shared-boundaries-allowed",
      sourceGridEdges:"geodesic-cell-corner-approximation",ellipsoidalSurvey:false},limits:{...budget}});
  return Object.freeze({areaSquareMeters,metadata,get metrics(){return Object.freeze({...stats});},intersectCell(corners){
    verify();stats.cellChecks++;work();
    if(!Array.isArray(corners)||corners.length!==4||corners.some(point=>!Array.isArray(point)||point.length!==2
      ||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>85.05112878))throw fail("baseline_aoi_cell_geometry_unsupported");
    if(Math.max(...corners.map(point=>point[0]))-Math.min(...corners.map(point=>point[0]))>180)throw fail("baseline_aoi_cell_geometry_unsupported");
    const cell=corners.map(project);let sign=0;
    for(let index=0;index<4;index++) {
      const a=cell[index],b=cell[(index+1)%4],c=cell[(index+2)%4],determinant=cross(a,b,c);
      if(Math.abs(determinant)<=tolerance(a,b,c)||sign&&Math.sign(determinant)!==sign)throw fail("baseline_aoi_cell_geometry_unsupported");
      sign=Math.sign(determinant);
    }
    if(sign<0)cell.reverse();const box=bounds(cell);let area=0;
    for(const triangle of triangles) {
      work();stats.candidateChecks++;if(separate(box,triangle.bounds))continue;
      stats.triangleClips++;area+=sphericalArea(clip(triangle.points,cell,work));
    }
    if(!Number.isFinite(area)||area<0||area>areaSquareMeters+Math.max(1e-6,areaSquareMeters*1e-9))throw fail("baseline_aoi_area_invalid");
    return Math.min(area,areaSquareMeters);
  }});
}

function sourceReference(source) {
  if(!plain(source))throw fail("baseline_aoi_source_invalid");
  const output={};
  for(const key of ["layerId","datasetId","featureId","sourceVersion"])if(source[key]!==undefined&&source[key]!==null) {
    const value=source[key];if(!(typeof value==="string"&&(key==="featureId"
      ?value.length<=512&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
      :/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))
      ||["featureId","sourceVersion"].includes(key)&&typeof value==="number"&&Number.isFinite(value)))throw fail("baseline_aoi_source_invalid");output[key]=value;
  }
  for(const key of ["sourceGeneration","featureIndex"])if(source[key]!==undefined&&source[key]!==null) {
    if(!Number.isSafeInteger(source[key])||source[key]<(key==="sourceGeneration"?1:0))throw fail("baseline_aoi_source_invalid");output[key]=source[key];
  }
  return output;
}
function onSegment(point,a,b) {
  return Math.abs(cross(a,b,point))<=tolerance(a,b,point)&&point[0]>=Math.min(a[0],b[0])-1e-14
    &&point[0]<=Math.max(a[0],b[0])+1e-14&&point[1]>=Math.min(a[1],b[1])-1e-14&&point[1]<=Math.max(a[1],b[1])+1e-14;
}
function segmentsIntersect(a,b,c,d) {
  if(separate(bounds([a,b]),bounds([c,d])))return false;
  if(onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b))return true;
  return Math.sign(cross(a,b,c))!==Math.sign(cross(a,b,d))&&Math.sign(cross(c,d,a))!==Math.sign(cross(c,d,b));
}
function validateRing(ring,work) {
  if(new Set(ring.map(point=>point.join(","))).size!==ring.length||Math.abs(signedArea(ring))<=1e-23)throw fail("baseline_aoi_topology_invalid");
  for(let index=0;index<ring.length;index++) {
    const a=ring[index],b=ring[(index+1)%ring.length],c=ring[(index+2)%ring.length];
    if(Math.abs(cross(a,b,c))<=tolerance(a,b,c)&&(b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0)throw fail("baseline_aoi_topology_invalid");
    for(let other=index+1;other<ring.length;other++) {
      work();if(other===index+1||index===0&&other===ring.length-1)continue;
      if(segmentsIntersect(a,b,ring[other],ring[(other+1)%ring.length]))throw fail("baseline_aoi_topology_invalid");
    }
  }
}
function rejectRingIntersection(a,b,work) {
  for(let first=0;first<a.length;first++)for(let second=0;second<b.length;second++) {
    work();if(segmentsIntersect(a[first],a[(first+1)%a.length],b[second],b[(second+1)%b.length]))throw fail("baseline_aoi_topology_invalid");
  }
}
function pointInRing(point,ring) {
  let inside=false;
  for(let index=0;index<ring.length;index++) {
    const a=ring[index],b=ring[(index+1)%ring.length];if(onSegment(point,a,b))return 0;
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside?1:-1;
}
function clip(subject,boundary,work) {
  let output=subject;
  for(let index=0;index<boundary.length&&output.length;index++) {
    work();const a=boundary[index],b=boundary[(index+1)%boundary.length],input=output;output=[];
    let previous=input.at(-1),previousDistance=cross(a,b,previous),previousInside=previousDistance>=0;
    for(const current of input) {
      const distance=cross(a,b,current),inside=distance>=0;
      if(inside!==previousInside) {
        const fraction=previousDistance/(previousDistance-distance);
        output.push([previous[0]+fraction*(current[0]-previous[0]),previous[1]+fraction*(current[1]-previous[1])]);
      }
      if(inside)output.push(current);previous=current;previousDistance=distance;previousInside=inside;
    }
  }
  // Shared edges have zero area. Remove duplicate endpoints before measuring.
  return output.filter((point,index)=>!same(point,output[(index+1)%output.length]));
}
function freeze(value) {
  if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
