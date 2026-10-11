import {cesiumLabelIssue,CESIUM_LABEL_LIMIT,cesiumLabelGeometryCost,CESIUM_LABEL_AREA_WORK_LIMIT} from './cesiumLabels.js';
import {inspectCesiumPass,CESIUM_STYLE_BUDGET} from './cesiumStyleAdmission.js';
// A projection of existing Layer/Style records, never a new persisted resource.
const geometryTypes = new Set(["Point","MultiPoint","LineString","MultiLineString","Polygon","MultiPolygon"]);

export function cesiumLayerCompatibility(entries) {
  const issues=[], ids=new Set(), budget={positions:500000}; let features=0,styleWork=0,labelCount=0,labelAreaWork=0;
  const add=(entry,code,message)=>issues.push({layerId:entry.layer?.layerId,title:entry.layer?.title,code,message});
  for (const entry of entries) {
    const {layer,geojson,parts}=entry;
    if (!layer?.layerId || ids.has(layer.layerId)) add(entry,"identity","Layer identities must be distinct.");
    ids.add(layer?.layerId);
    const labelIssue=cesiumLabelIssue(entry);
    if(labelIssue)add(entry,'labels',labelIssue);
    if(layer?.labels?.enabled)for(const feature of geojson?.features??[]){const cost=cesiumLabelGeometryCost(feature.geometry);labelCount+=cost.occurrences;labelAreaWork+=cost.areaWork;}
    if (layer?.opacityMode==="composite") add(entry,"opacity","Composite opacity needs a Cesium mapping.");
    if (layer?.filter && parts?.some(part=>!part.filter)) add(entry,"filter","Resolve this Layer's filtered Style before switching.");
    if (geojson?.type!=="FeatureCollection" || !Array.isArray(geojson.features) || geojson.crs) {
      add(entry,"source","Cesium needs loaded WGS84 vector features; service and archive adapters remain separate.");
    } else {
      features+=geojson.features.length;
      if (geojson.features.some(f=>f.type!=="Feature" || !geometryTypes.has(f.geometry?.type) || !validCoordinates(f.geometry.coordinates,budget))) {
        add(entry,"geometry","This geometry, elevation or coordinate reference is not mapped to Cesium yet.");
      }
    }
    if (!parts?.length) add(entry,"style","Resolve this Layer's Style before switching.");
    for (const part of parts??[]) {
      try {styleWork+=inspectCesiumPass(part).cost*(geojson?.features?.length??0);}
      catch {add(entry,"presentation","This Style's symbols, context-dependent expressions, textures or scale rules need a Cesium mapping.");}
    }
  }
  if(labelAreaWork>CESIUM_LABEL_AREA_WORK_LIMIT)issues.push({code:'label-geometry-limit',message:'This area-label scene exceeds the bounded geometry workload; keep MapLibre.'});
  if(labelCount>CESIUM_LABEL_LIMIT)issues.push({code:'label-limit',message:'This scene exceeds the native 5,000-label limit; keep MapLibre.'});
  if (features>50000) issues.push({code:"feature-limit",message:"This vector scene exceeds the initial 50,000-feature limit; keep the current renderer."});
  if(styleWork>CESIUM_STYLE_BUDGET)issues.push({code:'style-limit',message:'This Style exceeds the bounded native expression workload; keep the current renderer.'});
  return {ready:issues.length===0,issues};
}

function validCoordinates(value,budget,depth=0) {
  if (!Array.isArray(value) || !value.length || depth>4) return false;
  if (typeof value[0]==="number") return --budget.positions>=0 && value.length===2 && value.every(Number.isFinite)
    && Math.abs(value[0])<=180 && Math.abs(value[1])<=90;
  return value.every(child=>validCoordinates(child,budget,depth+1));
}

export function cesiumPassFeatures(geojson,type,accepts=()=>true) {
  const features=[];
  geojson.features.forEach((feature,index)=>{
    if(!accepts(feature))return;
    let geometry=feature.geometry;
    if (type==="circle" && !geometry.type.includes("Point")) return;
    if (type==="fill" && !geometry.type.includes("Polygon")) return;
    if (type==="line") {
      if (geometry.type==="Polygon") geometry={type:"MultiLineString",coordinates:geometry.coordinates};
      else if (geometry.type==="MultiPolygon") geometry={type:"MultiLineString",coordinates:geometry.coordinates.flat()};
      else if (!geometry.type.includes("LineString")) return;
    }
    // Provider simplestyle/marker URL properties must not override the saved Style
    // or cause implicit requests. Picking resolves the untouched original feature.
    features.push({type:"Feature",id:String(index),geometry:structuredClone(geometry),properties:{opengeoFeatureIndex:index}});
  });
  return {type:"FeatureCollection",features};
}
