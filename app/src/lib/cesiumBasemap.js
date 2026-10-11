import {REVIEWED_KEY_FREE_BASEMAPS} from './reviewedBasemapSources.js';
import {ESRI_BASEMAP_OPTIONS} from './esriBasemaps.js';

// Reuse the existing source review and public Esri choice. No credentials,
// metadata discovery, alternate endpoint or implicit provider selection.
const sources = [
  ...REVIEWED_KEY_FREE_BASEMAPS.filter(source=>source.kind==='raster'),
  ...ESRI_BASEMAP_OPTIONS.filter(source=>!source.requiresKey).map(source=>({...source,minZoom:0,maxZoom:23}))
];
export function validateCesiumBasemap(value) {
  if(value==null)return null;
  const source=sources.find(source=>source.url===value.url);
  if(!source || value.tileSize!==source.tileSize || value.scheme!=='xyz'
    || !Number.isInteger(value.minZoom) || !Number.isInteger(value.maxZoom)
    || value.minZoom<(source.minZoom??0) || value.minZoom>1
    || value.maxZoom>source.maxZoom || value.maxZoom<value.minZoom
    || !Number.isFinite(value.opacity) || value.opacity<0 || value.opacity>1)
    throw Error('cesium_basemap_unsupported');
  return {basemapId:String(value.basemapId??''),title:String(value.title??source.title),
    url:source.url,tileSize:source.tileSize,scheme:'xyz',minZoom:value.minZoom,maxZoom:value.maxZoom,
    opacity:value.opacity,visible:value.visible!==false,attribution:source.attribution,
    bounds:[...(source.sourceConfiguration?.coverageBounds??[-180,-85.051129,180,85.051129])]};
}

export function cesiumBasemapContent(style,basemapId) {
  const part=style?.layers?.find(part=>part.id==='basemap' && part.type==='raster');
  const source=style?.sources?.[part?.source];
  const fallback={basemap:null,message:'The current background has no native Cesium mapping. Use a plain globe or keep the current renderer.'};
  if(!part || source?.type!=='raster' || source.tiles?.length!==1)return fallback;
  // Reject paint adjustments that the native imagery layer cannot preserve.
  if(Object.keys(part.paint??{}).some(key=>key!=='raster-opacity'))return fallback;
  const reviewed=sources.find(candidate=>candidate.url===source.tiles[0]);
  if(!reviewed)return fallback;
  try {
    const basemap=validateCesiumBasemap({basemapId,title:reviewed.title,url:source.tiles[0],
      tileSize:source.tileSize??512,scheme:source.scheme??'xyz',minZoom:source.minzoom??0,
      maxZoom:source.maxzoom??22,opacity:part.paint?.['raster-opacity']??1,visible:part.layout?.visibility!=='none'});
    return {basemap,message:`Cesium will retain ${basemap.title}, its attribution and current opacity.`};
  }catch{return fallback;}
}
