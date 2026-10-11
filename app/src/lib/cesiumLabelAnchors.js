import Polygon from 'ol/geom/Polygon.js';
import {toLonLat} from 'ol/proj.js';
import {CESIUM_LABEL_LIMIT} from './cesiumLabels.js';

function areaAnchor(rings) {
  // Keep connected rings continuous across ±180° before projected interior-point
  // calculation. Align hole copies to the exterior; never change source geometry.
  let exteriorCenter;
  const continuous=rings.map((ring,index)=>{
    let previous=ring[0]?.[0];
    const copy=ring.map(([longitude,latitude])=>{
      if(Math.abs(latitude)>85.0511287798066)throw Error('cesium_polar_label_unsupported');
      const x=longitude+360*Math.round((previous-longitude)/360);previous=x;return [x,latitude];
    });
    if(copy.length<4 || copy[0][0]!==copy.at(-1)[0] || copy[0][1]!==copy.at(-1)[1])throw Error('cesium_polygon_label_ring_invalid');
    const center=copy.reduce((sum,p)=>sum+p[0],0)/copy.length;
    if(index===0)exteriorCenter=center;
    else {const offset=360*Math.round((exteriorCenter-center)/360);for(const coordinate of copy)coordinate[0]+=offset;}
    return copy;
  });
  const polygon=new Polygon(continuous).transform('EPSG:4326','EPSG:3857');
  const [x,y,width]=polygon.getInteriorPoint().getCoordinates();
  if(!Number.isFinite(x) || !Number.isFinite(y) || !(width>0) || !polygon.intersectsCoordinate([x,y]))throw Error('cesium_polygon_label_anchor_invalid');
  return toLonLat([x,y]);
}

export function cesiumLabelAnchors(geojson,accepts=()=>true) {
  const features=[];
  geojson.features.forEach((feature,index)=>{
    if(!accepts(feature))return;
    const {type,coordinates}=feature.geometry;
    let anchors;
    if(type==='Point')anchors=[coordinates];
    else if(type==='MultiPoint')anchors=coordinates;
    // The shared label Style uses symbol-placement: point. MapLibre anchors
    // that placement at each line's first vertex, not at a new invented centre.
    else if(type==='LineString')anchors=[coordinates[0]];
    else if(type==='MultiLineString')anchors=coordinates.map(line=>line[0]);
    else if(type==='Polygon')anchors=[areaAnchor(coordinates)];
    else if(type==='MultiPolygon')anchors=coordinates.map(areaAnchor);
    else throw Error('cesium_label_geometry_unsupported');
    for(const [part,position] of anchors.entries()) {
      if(features.length>=CESIUM_LABEL_LIMIT)throw Error('cesium_label_limit');
      features.push({type:'Feature',id:`${index}/${part}`,geometry:{type:'Point',coordinates:[...position]},properties:{opengeoFeatureIndex:index}});
    }
  });
  return {type:'FeatureCollection',features};
}
