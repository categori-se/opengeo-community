import {meanRadiusMeters, spatialBodyDefinition, spatialBodyDistanceMeters} from "./spatialBody.js";

export const POLYGON_3D_SCHEMA = "opengeo.polygon-3d-measurement.1.0.0";
export const POLYGON_3D_LIMITS = Object.freeze({vertices:128,extentMeters:100000,elevationMeters:100000,uncertaintyMeters:1000,exportBytes:131072});
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const fail=code=>Object.assign(Error(code),{code});
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rounded=value=>Number(value.toFixed(6));
const unit=([lon,lat])=>{const a=lon*Math.PI/180,b=lat*Math.PI/180;return [Math.cos(b)*Math.cos(a),Math.cos(b)*Math.sin(a),Math.sin(b)];};
const determinant=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);

// Earcut selects topology only after an explicit calculation. Normalization and
// API validation recompute the metric result from its bounded recorded topology.
export async function createPolygon3DMeasurement(input) {
  const prepared=prepare(input),{default:earcut}=await import("earcut");
  const indices=earcut(prepared.projected.flat()),sign=Math.sign(prepared.signedArea);
  const triangles=[];
  for(let i=0;i<indices.length;i+=3) {
    const t=indices.slice(i,i+3);
    if(Math.sign(determinant(...t.map(k=>prepared.projected[k])))!==sign)[t[1],t[2]]=[t[2],t[1]];
    triangles.push(t);
  }
  return assemble(input,prepared,triangles);
}

export function normalizePolygon3DMeasurement(value,{spatialBody}={}) {
  if(!value||value.schemaVersion!==POLYGON_3D_SCHEMA||value.kind!=="polygon-3d")throw fail("polygon3d_record_invalid");
  const body=spatialBodyDefinition(value.spatialBodyId);
  if(spatialBody&&spatialBody.id!==body.id)throw fail("polygon3d_body_invalid");
  const input={...value,spatialBody:body},expected=assemble(input,prepare(input),value.triangles);
  function equal(a,b,path="") {
    if(typeof b==="number")return Number.isFinite(a)&&Math.abs(a-b)<=(path.includes("summary")||path.includes("bounds")?(path.includes("areaSquareMeters")?.1:.01):path.endsWith("projectionAxis")?0:1e-6);
    if(b===null||typeof b!=="object")return a===b;
    return a!==null&&typeof a==="object"&&Array.isArray(a)===Array.isArray(b)
      &&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>Object.hasOwn(a,k)&&equal(a[k],b[k],path+"."+k));
  }
  if(!equal(value,expected))throw fail("polygon3d_summary_invalid");
  return expected;
}

function prepare({id,title,coordinates,spatialBody,spatialBodyId,source,uncertaintyMeters=null}) {
  if(!identifier.test(id??"")||!text(title,200))throw fail("polygon3d_identity_invalid");
  if(!Array.isArray(coordinates)||coordinates.length<3||coordinates.length>128||coordinates.some(c=>!Array.isArray(c)||c.length!==3
    ||!c.every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>85.05112878||Math.abs(c[2])>100000))throw fail("polygon3d_coordinates_invalid");
  if(new Set(coordinates.map(c=>c.join(","))).size!==coordinates.length)throw fail("polygon3d_duplicate_vertex");
  if(uncertaintyMeters!==null&&(!Number.isFinite(uncertaintyMeters)||uncertaintyMeters<0||uncertaintyMeters>1000))throw fail("polygon3d_uncertainty_invalid");
  if(!source||source.kind!=="user-supplied-vertices"||!text(source.label,200)||!text(source.verticalDatum,120)
    ||Object.keys(source).some(k=>!["kind","label","verticalDatum","geometryMeasurementId"].includes(k))
    ||source.geometryMeasurementId!=null&&!identifier.test(source.geometryMeasurementId))throw fail("polygon3d_source_invalid");
  const body=spatialBodyDefinition(spatialBody?.id??spatialBodyId??"earth"),radius=meanRadiusMeters(body);
  const origin=unit(coordinates[0]),lon=coordinates[0][0]*Math.PI/180,lat=coordinates[0][1]*Math.PI/180;
  const east=[-Math.sin(lon),Math.cos(lon),0],north=[-Math.sin(lat)*Math.cos(lon),-Math.sin(lat)*Math.sin(lon),Math.cos(lat)];
  const normals=coordinates.map(c=>{const u=unit(c);return [dot(u,east),dot(u,north),dot(u,origin)];});
  const points=coordinates.map((c,i)=>{const u=normals[i];return [(radius+c[2])*u[0],(radius+c[2])*u[1],radius*(u[2]-1)+c[2]*u[2]];});
  if(points.some(p=>Math.hypot(...sub(p,points[0]))>100000))throw fail("polygon3d_extent_limit");
  const normal=points.reduce((sum,p,i)=>cross(p,points[(i+1)%points.length]).map((v,k)=>v+sum[k]),[0,0,0]);
  const length=Math.hypot(...normal);if(length<1e-8)throw fail("polygon3d_projection_invalid");
  const axis=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  const projected=points.map(p=>p.filter((_v,i)=>i!==axis));
  for(let i=0;i<projected.length;i++)for(let j=0;j<i;j++) {
    if(Math.hypot(...sub(projected[i],projected[j]))<1e-6)throw fail("polygon3d_projection_invalid");
    if(i===j+1||j===0&&i===projected.length-1)continue;
    const a=projected[i],b=projected[(i+1)%projected.length],c=projected[j],d=projected[(j+1)%projected.length];
    if([0,1].some(k=>Math.max(a[k],b[k])<Math.min(c[k],d[k])-1e-8||Math.max(c[k],d[k])<Math.min(a[k],b[k])-1e-8))continue;
    if(determinant(a,b,c)*determinant(a,b,d)<=1e-8&&determinant(c,d,a)*determinant(c,d,b)<=1e-8)throw fail("polygon3d_projection_invalid");
  }
  const signedArea=projected.reduce((sum,p,i)=>sum+p[0]*projected[(i+1)%points.length][1]-p[1]*projected[(i+1)%points.length][0],0)/2;
  if(Math.abs(signedArea)<1e-8)throw fail("polygon3d_projection_invalid");
  return {coordinates:coordinates.map(c=>[...c]),points,normals,body,radius,axis,projected,signedArea,
    deviation:Math.max(...points.map(p=>Math.abs(dot(sub(p,points[0]),normal)/length)))};
}

function topology(projected,signedArea,triangles) {
  const n=projected.length,edges=new Map(),sign=Math.sign(signedArea);let area=0;
  if(!Array.isArray(triangles)||triangles.length!==n-2)throw fail("polygon3d_topology_invalid");
  for(const t of triangles) {
    if(!Array.isArray(t)||t.length!==3||new Set(t).size!==3||t.some(i=>!Number.isInteger(i)||i<0||i>=n))throw fail("polygon3d_topology_invalid");
    const a=determinant(...t.map(i=>projected[i]))/2;
    if(a*sign<=1e-8)throw fail("polygon3d_topology_invalid");area+=a;
    for(let i=0;i<3;i++){const x=t[i],y=t[(i+1)%3],key=`${Math.min(x,y)},${Math.max(x,y)}`,e=edges.get(key)??[];e.push([x,y]);edges.set(key,e);}
  }
  for(let i=0;i<n;i++) {
    const j=(i+1)%n,key=`${Math.min(i,j)},${Math.max(i,j)}`,e=edges.get(key);
    if(e?.length!==1||e[0][0]!==i||e[0][1]!==j)throw fail("polygon3d_topology_invalid");edges.delete(key);
  }
  if([...edges.values()].some(e=>e.length!==2||e[0][0]!==e[1][1]||e[0][1]!==e[1][0])
    ||Math.abs(area-signedArea)>Math.max(1e-6,Math.abs(signedArea)*1e-9))throw fail("polygon3d_topology_invalid");
}

function assemble(input,p,triangles) {
  topology(p.projected,p.signedArea,triangles);
  const {coordinates,points,normals}=p,n=points.length;
  let perimeter=0,area=0,width=0;
  for(let i=0;i<n;i++) {
    perimeter+=Math.hypot(...sub(points[(i+1)%n],points[i]));
    for(let j=0;j<i;j++)width=Math.max(width,spatialBodyDistanceMeters(coordinates[i].slice(0,2),coordinates[j].slice(0,2),p.body));
  }
  for(const t of triangles)area+=Math.hypot(...cross(sub(points[t[1]],points[t[0]]),sub(points[t[2]],points[t[0]])))/2;
  const elevations=coordinates.map(c=>c[2]),height=Math.max(...elevations)-Math.min(...elevations),u=input.uncertaintyMeters??null;
  let bounds=null;
  if(u!==null) {
    let edgeLow=0,edgeHigh=0,areaLow=0,areaHigh=0;
    const edge=(i,j)=>sub(points[j],points[i]).map((v,k)=>[v-u*(Math.abs(normals[j][k])+Math.abs(normals[i][k])),v+u*(Math.abs(normals[j][k])+Math.abs(normals[i][k]))]);
    for(let i=0;i<n;i++){const [lo,hi]=normInterval(edge(i,(i+1)%n));edgeLow+=lo;edgeHigh+=hi;}
    for(const [a,b,c] of triangles) {
      const x=edge(a,b),y=edge(a,c),v=[[1,2],[2,0],[0,1]].map(([i,j])=>difference(product(x[i],y[j]),product(x[j],y[i])));
      const [lo,hi]=normInterval(v);areaLow+=lo/2;areaHigh+=hi/2;
    }
    bounds={perimeterMeters:[rounded(Math.max(0,edgeLow-1e-6)),rounded(edgeHigh+1e-6)],areaSquareMeters:[rounded(Math.max(0,areaLow-1e-6)),rounded(areaHigh+1e-6)],heightMeters:[rounded(Math.max(0,height-2*u)),rounded(height+2*u)]};
  }
  return {schemaVersion:POLYGON_3D_SCHEMA,id:input.id,title:input.title,kind:"polygon-3d",spatialBodyId:p.body.id,
    measurementModel:"mean-sphere-radial-elevation-chords",distanceUnit:"meter",areaUnit:"square-meter",coordinates,
    triangles:triangles.map(t=>[...t]),source:{kind:input.source.kind,label:input.source.label,verticalDatum:input.source.verticalDatum,geometryMeasurementId:input.source.geometryMeasurementId??null},
    uncertaintyMeters:u,model:{surface:"vertex-triangulated",projectionAxis:p.axis,radiusMeters:p.radius,maximumPlaneDeviationMeters:rounded(p.deviation),verticalAccuracy:"not-declared",uncertainty:"conservative-radial-intervals",betweenVertices:"planar-facets"},
    summary:{perimeterMeters:rounded(perimeter),areaSquareMeters:rounded(area),widthMeters:rounded(width),heightMeters:rounded(height)},bounds};
}
function product(a,b){const v=[a[0]*b[0],a[0]*b[1],a[1]*b[0],a[1]*b[1]];return [Math.min(...v),Math.max(...v)];}
function difference(a,b){return [a[0]-b[1],a[1]-b[0]];}
function normInterval(values){return [Math.hypot(...values.map(([a,b])=>a<=0&&b>=0?0:Math.min(Math.abs(a),Math.abs(b)))),Math.hypot(...values.map(([a,b])=>Math.max(Math.abs(a),Math.abs(b))))];}
function text(v,max){return typeof v==="string"&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\x00-\x1f]/.test(v);}

export function polygon3DGeojson(measurement) {
  const input=normalizePolygon3DMeasurement(measurement),ring=[...input.coordinates,input.coordinates[0]];
  const json=JSON.stringify({type:"FeatureCollection",features:[{type:"Feature",id:input.id,properties:{title:input.title,...input.summary},geometry:{type:"Polygon",coordinates:[ring]}}],opengeo:{measurement:input,outputCustody:"locally-created",coordinateZUnit:"metres",verticalDatum:input.source.verticalDatum}});
  if(new TextEncoder().encode(json).length>POLYGON_3D_LIMITS.exportBytes)throw fail("polygon3d_export_limit");return json;
}

export function polygon3DPreview(measurement) {
  const value=normalizePolygon3DMeasurement(measurement),p=prepare(value);
  return {points:p.projected,axis:p.axis,triangles:value.triangles};
}
