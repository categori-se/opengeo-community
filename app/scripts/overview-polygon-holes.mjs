import assert from 'node:assert/strict';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';

// Explicit cartographic overview generalization. Full-detail callers never use it.
// Match the installed renderer's largest-hole selection in the encoded artifact,
// so any omission is counted and disclosed instead of occurring silently in WebGL.
export function fitOverviewPolygonHoles(feature,{zoom,fullDetailZoom}){
  assert.ok(zoom<fullDetailZoom,'Never remove full-detail polygon holes');
  const geometry=feature.loadGeometry();
  if(geometry.length<=500)return {feature,omittedNonzeroRings:0,zeroAreaRings:0};
  const complete=classifyRings(geometry.map(r=>r.slice()),0),limited=classifyRings(geometry.map(r=>r.slice()),500);
  const originalRings=complete.reduce((n,p)=>n+p.length,0),kept=limited.flat().map(r=>r.slice());
  assert.equal(complete.length,limited.length,'Overview exterior polygons must remain');
  return {feature:{id:feature.id,type:feature.type,properties:feature.properties,loadGeometry:()=>kept},
    omittedNonzeroRings:originalRings-kept.length,zeroAreaRings:geometry.length-originalRings};
}
