import {isRegisteredMapFont,mapLabelTextValues,mapFontSha256,PINNED_MAP_FONT,PINNED_MAP_FONT_STACK} from './mapFonts.js';
import {CESIUM_RUNTIME} from './cesiumRuntime.js';

export const CESIUM_FONT_ROOT=`${CESIUM_RUNTIME.basePath}opengeo-font/`;
export const CESIUM_FONT_SHA256='8ab4aa561e7db0eb3e1af8b0bed2a315e0a33fe2ed3070e645d1b89f8efc1d5c';
export const CESIUM_LABEL_LIMIT=5000;
export const CESIUM_LABEL_AREA_WORK_LIMIT=50_000_000;
export function cesiumLabelGeometryCost(geometry) {
  const multi=geometry?.type?.startsWith('Multi');
  const occurrences=multi?(geometry.coordinates?.length??0):1;
  const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  const areaWork=(Array.isArray(polygons)?polygons:[]).reduce((sum,rings)=>{
    const vertices=Array.isArray(rings)?rings.reduce((count,ring)=>count+(Array.isArray(ring)?ring.length:0),0):0;
    return sum+vertices*vertices;
  },0);
  return {occurrences,areaWork};
}

// Native placement is intentionally admitted separately from geometry paint.
// Unsupported layouts stay in the current renderer, with their definitions intact.
export function cesiumLabelIssue({layer,geojson,labelPart}) {
  if(!layer?.labels?.enabled)return null;
  if(!isRegisteredMapFont(layer.labels.fontRef))return 'Choose the pinned Open Sans font in Layer Properties before using Cesium labels.';
  const size=layer.labels.size??12,halo=layer.labels.haloWidth??1.2;
  if(!Number.isFinite(size) || size<=0 || size>128 || !Number.isFinite(halo) || halo<0 || halo>16)return 'This label size or halo needs a supported native mapping.';
  if(!labelPart || labelPart.type!=='symbol')return 'Resolve this Layer’s label Style before switching.';
  if(!Array.isArray(geojson?.features) || !geojson.features.every(feature=>['Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon'].includes(feature.geometry?.type)))return 'This label geometry needs a native mapping.';
  if(labelPart.layout?.['symbol-placement'] && labelPart.layout['symbol-placement']!=='point')return 'Curved and repeated line labels still need MapLibre.';
  for(const feature of geojson.features) {
    const g=feature.geometry,polygons=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
    if(!Array.isArray(polygons))return 'This label geometry needs a native mapping.';
    for(const rings of polygons) {
      if(!Array.isArray(rings))return 'This label geometry needs a native mapping.';
      for(const ring of rings) {
        if(!Array.isArray(ring))return 'This label geometry needs a native mapping.';
        for(const coordinate of ring)if(Math.abs(coordinate?.[1])>85.0511287798066)return 'Polar area labels need a native projection mapping; keep MapLibre.';
      }
    }
  }
  if(mapLabelTextValues(layer,geojson).some(text=>text.length>256))return 'Labels longer than 256 characters still need MapLibre.';
  return null;
}

// Verified source bytes of the existing glyph font, not a system-font substitute.
// Loaded only inside the disposable native frame when labeled content is selected.
export async function loadCesiumLabelFont(doc,signal) {
  async function bytes(name,max) {
    const response=await fetch(`${CESIUM_FONT_ROOT}${name}`,{signal,credentials:'omit',redirect:'error'});
    if(!response.ok)throw Error('cesium_font_unavailable');
    const value=new Uint8Array(await response.arrayBuffer());
    if(value.length>max)throw Error('cesium_font_size_invalid');
    return value;
  }
  const manifestBytes=await bytes('manifest.json',128000);
  if(await mapFontSha256(manifestBytes)!==PINNED_MAP_FONT.manifestChecksumSha256)throw Error('cesium_font_manifest_mismatch');
  const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
  const fontBytes=await bytes('OpenSans-Regular.ttf',1000000);
  if(manifest.fontSha256!==CESIUM_FONT_SHA256 || await mapFontSha256(fontBytes)!==CESIUM_FONT_SHA256)throw Error('cesium_font_mismatch');
  const face=new doc.defaultView.FontFace(PINNED_MAP_FONT_STACK,fontBytes);
  await face.load();
  if(signal?.aborted)throw Error('cesium_scene_cancelled');
  doc.fonts.add(face);
  const coverage=new Set(manifest.codepoints);
  const context=doc.createElement('canvas').getContext('2d');
  return {
    text(value,size) {
      for(const character of value)if(!['\n','\r'].includes(character) && !coverage.has(character.codePointAt(0)))throw Error('cesium_font_coverage_missing');
      const font=`${size}px/${size*1.2}px "${PINNED_MAP_FONT_STACK}"`;context.font=font;
      const lines=[];
      for(const paragraph of value.replace(/\r\n?/g,'\n').split('\n')) {
        let line='';
        for(const word of paragraph.split(/ +/)) {
          const candidate=line?`${line} ${word}`:word;
          if(line && context.measureText(candidate).width>size*10){lines.push(line);line=word;}
          else line=candidate;
        }
        lines.push(line);
      }
      // Match the saved default ten-em width and 1.2-em line spacing. Long
      // unbroken words stay whole; native glyph rasterization can still differ.
      return {text:lines.join('\n'),font,metrics:{width:Math.max(...lines.map(line=>context.measureText(line).width)),height:size*1.2*lines.length}};
    },
    destroy(){doc.fonts.delete(face);}
  };
}
