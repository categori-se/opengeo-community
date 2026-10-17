import {sightLineModel} from "./sightLineModel.js";
import {meanRadiusMeters, spatialBodyDefinition} from "./spatialBody.js";

export const GRID_VIEWSHED_LIMITS = Object.freeze({side:63,cells:3969,triangles:7688,distanceMeters:100000,
  heightMeters:1000,uncertaintyMeters:1000,triangleChecks:4000000,milliseconds:5000,exportBytes:8*1024*1024});
const UNITS=Object.freeze({metres:1,"international-feet":0.3048,"us-survey-feet":1200/3937});
const EPS=1e-8,TOLERANCE=.01;
const add=(a,b)=>a.map((v,i)=>v+b[i]), sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const average=points=>points.reduce((sum,p)=>add(sum,p),[0,0,0]).map(v=>v/points.length);
const unit=([lon,lat])=>{const a=lon*Math.PI/180,b=lat*Math.PI/180;return [Math.cos(b)*Math.cos(a),Math.cos(b)*Math.sin(a),Math.sin(b)];};
const coordinate=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90;
const fail=code=>Object.assign(Error(code),{code});
const snapshots=new WeakMap();
const LEGEND=Object.freeze([
  {code:0,label:"Unknown / outside computation",color:"#9ca3af"},
  {code:1,label:"Occluded",color:"#dc2626"},{code:2,label:"Grazing",color:"#eab308"},
  {code:3,label:"Visible",color:"#16a34a"},{code:4,label:"Observer",color:"#2563eb"}
]);

/** Visibility of cell centres on a triangulated surface made from cached DEM
 * samples. Unknown triangles are opaque uncertainty, never fabricated ground.
 * Coordinates are mapped to a local metric frame, so angular raster units are
 * never used as metres. This function cannot load a raster or perform I/O.
 */
export async function computeGridViewshed({grid,observer,band,unit:heightUnit,elevationConfirmed=false,
  side=17,maximumDistanceMeters=10000,observerHeightMeters=1.75,targetHeightMeters=0,
  uncertaintyMeters=null,curvature=true,signal,onProgress=()=>{},
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),now=()=>performance.now()}={}) {
  if(!elevationConfirmed||!Object.hasOwn(UNITS,heightUnit))throw fail("viewshed_elevation_interpretation_required");
  if(!grid?.active?.()||!Number.isInteger(grid.width)||!Number.isInteger(grid.height)||grid.width<2||grid.height<2
    ||!grid.metadata?.bands?.includes(band)||!coordinate(observer))throw fail("viewshed_source_invalid");
  if(!Number.isInteger(side)||side<3||side>GRID_VIEWSHED_LIMITS.side||side%2!==1
    ||!Number.isFinite(maximumDistanceMeters)||maximumDistanceMeters<=0||maximumDistanceMeters>100000
    ||![observerHeightMeters,targetHeightMeters].every(v=>Number.isFinite(v)&&v>=0&&v<=1000)
    ||uncertaintyMeters!==null&&(!Number.isFinite(uncertaintyMeters)||uncertaintyMeters<0||uncertaintyMeters>1000)
    ||typeof curvature!=="boolean")throw fail("viewshed_options_invalid");
  const started=now(),stats={triangleChecks:0,processed:0,total:0,milliseconds:0};
  const guard=()=>{
    signal?.throwIfAborted();if(!grid.active())throw fail("viewshed_source_changed");
    if(now()-started>=GRID_VIEWSHED_LIMITS.milliseconds||stats.triangleChecks>=GRID_VIEWSHED_LIMITS.triangleChecks)throw fail("viewshed_compute_limit");
  };
  guard();const selected=grid.locate(...observer);if(!selected)throw fail("viewshed_observer_outside_window");
  const ground=grid.value(selected.column,selected.row,band),factor=UNITS[heightUnit];
  if(!Number.isFinite(ground)||!Number.isFinite(ground*factor)||Math.abs(ground*factor)>100000)throw fail("viewshed_observer_nodata");
  const snapped=grid.coordinate(selected.column,selected.row),up=unit(snapped),lon=snapped[0]*Math.PI/180,lat=snapped[1]*Math.PI/180;
  const east=[-Math.sin(lon),Math.cos(lon),0],north=[-Math.sin(lat)*Math.cos(lon),-Math.sin(lat)*Math.sin(lon),Math.cos(lat)];
  const radius=meanRadiusMeters(spatialBodyDefinition("earth")),half=(side-1)/2;
  const window=[Math.max(0,selected.column-half),Math.max(0,selected.row-half),Math.min(grid.width,selected.column+half+1),Math.min(grid.height,selected.row+half+1)];
  const width=window[2]-window[0],height=window[3]-window[1];if(width<2||height<2)throw fail("viewshed_grid_too_small");
  const cells=[];let observerIndex;
  for(let row=window[1];row<window[3];row++)for(let column=window[0];column<window[2];column++) {
    const location=grid.coordinate(column,row);if(!coordinate(location))throw fail("viewshed_grid_coordinate_invalid");
    const direction=unit(location),angle=2*Math.asin(Math.min(1,Math.hypot(...sub(direction,up))/2)),distance=radius*angle;
    if(distance>100000)throw fail("viewshed_grid_extent_limit");
    const e=dot(direction,east),n=dot(direction,north),horizontal=Math.hypot(e,n);
    const vertical=curvature?[e,n,dot(direction,up)]:[0,0,1];
    const base=curvature?[radius*e,radius*n,radius*(dot(direction,up)-1)]:[horizontal?distance*e/horizontal:0,horizontal?distance*n/horizontal:0,0];
    const rawValue=grid.value(column,row,band),raw=Number.isFinite(rawValue)?rawValue:null,value=raw===null?null:raw*factor;
    const cell={index:cells.length,column,row,location,raw,value:Number.isFinite(value)&&Math.abs(value)<=100000?value:null,
      base,vertical,direction:horizontal?[e/horizontal,n/horizontal]:[0,0],distance};
    if(column===selected.column&&row===selected.row) {observerIndex=cell.index;cell.base=[0,0,0];cell.vertical=[0,0,1];cell.distance=0;}
    cells.push(cell);
  }
  stats.total=cells.length;const observerCell=cells[observerIndex],uncertainty=uncertaintyMeters??0;
  const known=cells.filter(c=>c.value!==null).map(c=>c.value),minimum=Math.min(...known),maximum=Math.max(...known);
  const bottom=minimum-uncertainty-(curvature?(radius+102000)*(1-Math.cos(100000/(2*radius))):0)-1;
  const ceiling=maximum+Math.max(observerHeightMeters,targetHeightMeters)+uncertainty
    +(curvature?(radius+102000)*(1-Math.cos(200000/radius)):0)+1;
  const position=(cell,value)=>add(cell.base,cell.vertical.map(v=>v*value));
  const triangles=[];
  for(let row=0;row<height-1;row++)for(let column=0;column<width-1;column++) {
    const a=row*width+column,b=a+1,c=a+width,d=c+1;
    for(const indices of [[a,b,d],[a,d,c]]) {
      const vertices=indices.map(i=>cells[i]),unknown=vertices.some(c=>c.value===null);
      const floor=vertices.map(c=>position(c,bottom));
      const topFor=(scenario,target=-1)=>vertices.map(c=>position(c,unknown?ceiling:c.value+
        (scenario===0?0:(c.index===observerIndex||c.index===target?-scenario:scenario)*uncertainty)));
      const tops=[topFor(0),...(uncertainty?[topFor(1),topFor(-1)]:[])];
      const inside=average([...floor,...tops[0]]);
      const sides=vertices.map((_c,i)=>plane(tops[0][i],tops[0][(i+1)%3],floor[i],inside));
      const bottomPlane=plane(...floor,inside);
      const topsPlanes=tops.map(top=>plane(...top,average(floor)));
      const bounds=box([...floor,...tops.flat(),...vertices.flatMap(c=>c.value===null?[]:[position(c,c.value-uncertainty),position(c,c.value+uncertainty)])]);
      triangles.push({indices,unknown,sides:[...sides,bottomPlane],tops:topsPlanes,bounds,topFor});
    }
  }
  guard();const tree=buildTree(triangles);guard();
  const options={band,unit:heightUnit,elevationConfirmed:true,side,maximumDistanceMeters,observerHeightMeters,targetHeightMeters,uncertaintyMeters,curvature};
  const result={schemaVersion:"opengeo.cached-grid-viewshed.1.0.0",status:"complete",reason:null,
    observer:{requested:[...observer],location:[...snapped],pixel:{column:selected.column,row:selected.row},elevationMeters:observerCell.value},
    options,model:{surface:"cell-centre-triangulated",distance:"observer-centred-mean-sphere-metres",curvature,
      radiusMeters:radius,refraction:false,verticalAccuracy:"not-declared",elevationInterpretation:"user-supplied",
      toleranceMeters:TOLERANCE,missingTerrain:"unknown",outsideGrid:"not-evaluated",buildings:false,vegetation:false},
    source:sourceMetadata(grid.metadata),
    input:{window,width,height,coordinates:cells.map(c=>[...c.location]),values:cells.map(c=>c.raw)},
    legend:LEGEND.map(row=>({...row})),cells:cells.map(c=>({column:c.column,row:c.row,location:[...c.location],distanceMeters:c.distance,
      elevationMeters:c.value,visibility:"not-computed",uncertainty:"not-evaluated"})),metrics:stats};
  const trace=(cell,scenario)=>{
    const model=sightLineModel({distanceMeters:cell.distance,radiusMeters:radius,observerElevationMeters:observerCell.value+observerHeightMeters,
      targetElevationMeters:cell.value+targetHeightMeters,curvature});
    const ray=model.segment(-scenario*uncertainty),start=[0,0,ray.start[1]],end=[cell.direction[0]*ray.end[0],cell.direction[1]*ray.end[0],ray.end[1]];
    let unknown=false,grazing=false;
    const candidates=queryTree(tree,start,end);
    for(const tri of candidates) {
      stats.triangleChecks++;if(stats.triangleChecks%256===0)guard();
      let top=tri.tops[scenario===0||!uncertainty?0:scenario===1?1:2];
      if(scenario&&uncertainty&&!tri.unknown&&tri.indices.includes(cell.index))top=plane(...tri.topFor(scenario,cell.index),average(tri.indices.map(i=>position(cells[i],bottom))));
      const hit=clipPrism(start,end,[top,...tri.sides],cell.distance);
      if(!hit)continue;
      if(tri.unknown) {unknown=true;continue;}
      if(hit==="occluded")return "occluded";grazing=true;
    }
    return unknown?"unknown":grazing?"grazing":"visible";
  };
  try {
    for(const cell of cells) {
      guard();const output=result.cells[cell.index];
      if(cell.index===observerIndex)output.visibility="observer";
      else if(cell.value===null)output.visibility="unknown";
      else if(cell.distance>maximumDistanceMeters)output.visibility="outside-distance";
      else {
        output.visibility=trace(cell,0);
        if(uncertaintyMeters!==null) {
          const worst=uncertainty?trace(cell,1):output.visibility,best=uncertainty?trace(cell,-1):output.visibility;
          output.uncertainty=worst==="visible"?"visible-for-bound":best==="occluded"?"occluded-for-bound"
            :worst==="unknown"||best==="unknown"?"unknown":"uncertain";
        }
      }
      stats.processed++;if(stats.processed%16===0) {onProgress({...stats});await yieldControl();}
    }
  } catch(error) {
    if(error.code!=="viewshed_compute_limit")throw error;
    result.status="partial";result.reason="compute-limit";
  }
  signal?.throwIfAborted();if(!grid.active())throw fail("viewshed_source_changed");
  stats.milliseconds=now()-started;result.counts=Object.fromEntries(["visible","occluded","grazing","unknown","outside-distance","observer","not-computed"]
    .map(name=>[name,result.cells.filter(c=>c.visibility===name).length]));
  onProgress({...stats});signal?.throwIfAborted();if(!grid.active())throw fail("viewshed_source_changed");
  snapshots.set(result,{grid,record:structuredClone(result)});return result;
}

function sourceMetadata(metadata) {
  const source=metadata.source??{},text=value=>typeof value==="string"?value:null;
  return {imageIndex:metadata.imageIndex,projection:text(metadata.projection),scaleX:metadata.scaleX,scaleY:metadata.scaleY,
    window:[...metadata.window],origin:Array.isArray(metadata.origin)?[...metadata.origin]:null,
    resolution:Array.isArray(metadata.resolution)?[...metadata.resolution]:null,interpretation:text(metadata.interpretation),bands:[...metadata.bands],
    noData:metadata.noData??null,source:{url:text(source.url),etag:text(source.etag),size:Number.isFinite(source.size)?source.size:null,
      verified:source.verified===true,license:text(source.license),attribution:text(source.attribution)}};
}

function plane(a,b,c,inside) {
  let n=cross(sub(b,a),sub(c,a)),length=Math.hypot(...n);if(!Number.isFinite(length)||length<1e-10)throw fail("viewshed_degenerate_grid");
  n=n.map(v=>v/length);let d=dot(n,a);if(dot(n,inside)>d){n=n.map(v=>-v);d=-d;}return [...n,d];
}
function box(points) {return [0,1,2].map(i=>Math.min(...points.map(p=>p[i]))).concat([0,1,2].map(i=>Math.max(...points.map(p=>p[i]))));}
function buildTree(triangles) {
  const bounds=[0,1,2].map(i=>Math.min(...triangles.map(t=>t.bounds[i]))).concat([3,4,5].map(i=>Math.max(...triangles.map(t=>t.bounds[i]))));
  if(triangles.length<=8)return {bounds,triangles};
  const axis=[0,1,2].sort((a,b)=>(bounds[b+3]-bounds[b])-(bounds[a+3]-bounds[a]))[0];
  const ordered=[...triangles].sort((a,b)=>(a.bounds[axis]+a.bounds[axis+3])-(b.bounds[axis]+b.bounds[axis+3]));
  const half=Math.floor(ordered.length/2);return {bounds,left:buildTree(ordered.slice(0,half)),right:buildTree(ordered.slice(half))};
}
function queryTree(tree,start,end,output=[]) {
  let low=0,high=1;
  for(let i=0;i<3;i++) {
    const delta=end[i]-start[i];
    if(Math.abs(delta)<EPS){if(start[i]<tree.bounds[i]-EPS||start[i]>tree.bounds[i+3]+EPS)return output;}
    else {const a=(tree.bounds[i]-EPS-start[i])/delta,b=(tree.bounds[i+3]+EPS-start[i])/delta;low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));if(low>high)return output;}
  }
  if(tree.triangles)output.push(...tree.triangles);else {queryTree(tree.left,start,end,output);queryTree(tree.right,start,end,output);}return output;
}
function clipPrism(start,end,planes,distance) {
  const delta=sub(end,start),endpoint=Math.max(1e-9,.0001/distance);let low=endpoint,high=1-endpoint;
  const top=planes[0],height=dot(top,start)-top[3],slope=dot(top,delta);
  for(let i=0;i<planes.length;i++) {
    const p=planes[i],a=dot(p,start)-p[3],b=dot(p,delta);
    if(Math.abs(b)<EPS) {if(a>(i===0?TOLERANCE:EPS))return null;}
    else {const t=(EPS-a)/b;if(b>0)high=Math.min(high,t);else low=Math.max(low,t);if(low>high)return null;}
  }
  return Math.min(height+slope*low,height+slope*high)<-TOLERANCE?"occluded":"grazing";
}

export function viewshedGeojson(result,grid,{sourceTermsConfirmed=false}={}) {
  if(!sourceTermsConfirmed)throw fail("viewshed_export_terms_required");
  if(!grid?.active?.())throw fail("viewshed_source_changed");
  const saved=snapshots.get(result);if(!saved||saved.grid!==grid)throw fail("viewshed_export_invalid");
  result=saved.record;
  const url=result?.source?.source?.url;
  if(typeof url!=="string")throw fail("viewshed_export_source_invalid");
  const parsed=new URL(url),sensitive=/(?:token|key|secret|signature|credential|authorization|session)/i;
  if(parsed.protocol!=="https:"||parsed.username||parsed.password||sensitive.test(parsed.search)
    ||[...parsed.searchParams.keys()].some(k=>sensitive.test(k)))throw fail("viewshed_export_source_invalid");
  if(result.schemaVersion!=="opengeo.cached-grid-viewshed.1.0.0"||!Array.isArray(result.cells)||result.cells.length>3969)throw fail("viewshed_export_invalid");
  const codes={visible:3,occluded:1,grazing:2,observer:4};
  const features=result.cells.map(cell=>({type:"Feature",properties:{...cell,visibility_code:codes[cell.visibility]??0},geometry:{type:"Polygon",coordinates:[[
    grid.coordinate(cell.column,cell.row,true),grid.coordinate(cell.column,cell.row+1,true),grid.coordinate(cell.column+1,cell.row+1,true),
    grid.coordinate(cell.column+1,cell.row,true),grid.coordinate(cell.column,cell.row,true)]]}}));
  const collection={type:"FeatureCollection",features,opengeo:{schemaVersion:result.schemaVersion,status:result.status,reason:result.reason,
    source:result.source,observer:result.observer,model:result.model,options:result.options,input:result.input,metrics:result.metrics,counts:result.counts,legend:result.legend,
    outputCustody:"locally-created-derived",license:null,sourceTermsConfirmation:"user-confirmed"}};
  const json=JSON.stringify(collection);if(new TextEncoder().encode(json).length>GRID_VIEWSHED_LIMITS.exportBytes)throw fail("viewshed_export_limit");return json;
}
