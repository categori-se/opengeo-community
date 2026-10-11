import {canonicalJson} from './artifactCanonicalJson.js';

export function reviewedRasterOverview(record) {
  const overview=record.raster_overview;
  if(overview==null){if(record.objects?.length!==1)throw Error('Unexpected archive objects.');return null;}
  const [vector,raster]=record.objects??[];
  if(record.objects?.length!==2 || overview.object_index!==1 || overview.tile_size!==512
    || !Number.isInteger(overview.min_zoom) || !Number.isInteger(overview.max_zoom)
    || overview.min_zoom!==record.min_zoom || overview.min_zoom>overview.max_zoom
    || overview.vector_min_zoom!==overview.max_zoom+1 || overview.vector_min_zoom>record.max_zoom
    || raster.feature_count!==0 || vector.feature_count!==record.feature_count
    || ['bucket','prefix','expected_owner'].some(key=>vector[key]!==raster[key])
    || vector.key===raster.key || record.download_bytes!==vector.size_bytes+raster.size_bytes
    || record.decoded_bytes!==vector.decoded_size_bytes+raster.decoded_size_bytes
    || record.tile_layers.some(layer=>!['Polygon','MultiPolygon'].includes(layer.geometry_type))
    || overview.recipe?.version!==1 || overview.recipe?.tile_size!==512
    || canonicalJson(overview.recipe?.zooms)!==canonicalJson(Array.from({length:overview.max_zoom-overview.min_zoom+1},(_,i)=>i+overview.min_zoom))
    || overview.recipe?.sourceVectorSha256!==vector.sha256
    || typeof overview.description!=='string' || !overview.description)
    throw Error('Invalid paired raster overview.');
  return overview;
}

// The logical Layer spans both archives. Existing pairs may retain unused
// low-zoom vector tiles; newer pairs can start vectors exactly after the overview.
// Call only after reviewedRasterOverview has validated the descriptor.
export function validateVectorZoomRange(record, header, overview) {
  if (header.maxZoom !== record.max_zoom
    || (header.minZoom !== record.min_zoom
      && (!overview || header.minZoom !== overview.vector_min_zoom))) {
    throw Error('Archive tile header differs from its review.');
  }
}

export function validateOverviewHeader(overview, header, vectorHeader, metadata) {
  if(header.specVersion!==3 || header.tileType!==2 || header.tileCompression!==1
    || header.minZoom!==overview.min_zoom || header.maxZoom!==overview.max_zoom
    || ['minLon','minLat','maxLon','maxLat'].some(key=>header[key]!==vectorHeader[key])
    || canonicalJson(metadata.opengeo_raster_overview)!==canonicalJson(overview.recipe))
    throw Error('Raster overview differs from its preserved review.');
}

export function validateOverviewPng(data) {
  const bytes=new Uint8Array(data), signature=[137,80,78,71,13,10,26,10];
  if(bytes.length<33 || bytes.length>8*1024**2 || signature.some((v,i)=>bytes[i]!==v))
    throw Error('Invalid archive overview PNG.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(8)!==13 || view.getUint32(12)!==0x49484452
    || view.getUint32(16)!==512 || view.getUint32(20)!==512
    || bytes[24]!==8 || bytes[25]!==3 || bytes[26]!==0 || bytes[27]!==0 || bytes[28]!==0)
    throw Error('Archive overview PNG exceeds its reviewed image format.');
  return data;
}
