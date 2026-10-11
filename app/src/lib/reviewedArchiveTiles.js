import {PMTiles, SharedPromiseCache, Compression, TileType} from "pmtiles";
import {createReviewedArchiveRangeSource, createReviewedArchiveReadBudget} from "./reviewedArchiveRange.js";
import {reviewedArchiveLayerRanges} from "./reviewedArchiveLayerRanges.js";
import {reviewedArchiveOverview} from "./reviewedArchivePresentation.js";
import {reviewedRasterOverview, validateVectorZoomRange, validateOverviewHeader, validateOverviewPng} from "./reviewedRasterOverview.js";

const sessions = new Map();
const DECODED_LIMIT = 16 * 1024 ** 2;

// Bound decompression of both PMTiles directories and individual vector tiles.
export async function decompressReviewedTile(data, compression) {
  if (compression === Compression.None) {
    if (data.byteLength > DECODED_LIMIT) throw Error("Decoded archive tile is too large.");
    return data;
  }
  if (compression !== Compression.Gzip) throw Error("Unsupported archive tile compression.");
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DECODED_LIMIT) throw Error("Decoded archive tile is too large.");
      parts.push(value);
    }
  } finally {await reader.cancel().catch(() => {});}
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) {result.set(part, offset); offset += part.byteLength;}
  return result.buffer;
}

export async function loadReviewedArchiveTiles(options) {
  const {record} = options;
  if (!Array.isArray(record.tile_layers) || !record.tile_layers.length || record.tile_layers.length > 4
    || !Number.isInteger(record.min_zoom) || !Number.isInteger(record.max_zoom)
    || record.min_zoom < 0 || record.max_zoom > 22 || record.min_zoom > record.max_zoom
    || !Number.isSafeInteger(record.feature_count) || record.feature_count < 0
    || record.feature_count > (record.objects?.[0]?.block_index ? 10000000 : 100000)
    || record.tile_layers.some(layer => !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(layer.source_layer)
      || !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(layer.geometry_type)
      || !Number.isSafeInteger(layer.feature_count) || layer.feature_count < 0 || !layer.geometry_method)
    || new Set(record.tile_layers.map(layer => layer.source_layer)).size !== record.tile_layers.length
    || record.tile_layers.reduce((sum, layer) => sum + layer.feature_count, 0) !== record.feature_count) {
    throw Error("Invalid reviewed archive tile layers.");
  }
  const rasterOverview=reviewedRasterOverview(record), budget=createReviewedArchiveReadBudget();
  let session;
  const sources=[],caches=[];
  const dispose=()=>{for(const source of sources)source.dispose();for(const cache of caches)cache.cache.clear();};
  const makeSource=object=>{
    const source=createReviewedArchiveRangeSource({...options,budget,
      record:{...record,objects:[object],download_bytes:object.size_bytes},
      onProgress:()=>options.onProgress?.({downloaded:sources.reduce((n,s)=>n+s.stats().downloaded,0),total:record.download_bytes,requests:budget.stats().requests}),
      onError:error=>{dispose();session?.dispose();options.onError?.(error);}});
    sources.push(source);return source;
  };
  const source = makeSource(record.objects[0]);
  const cache = new SharedPromiseCache(32, false, decompressReviewedTile);
  caches.push(cache);
  const pmtiles = new PMTiles(source, cache, decompressReviewedTile);
  try {
    const header = await pmtiles.getHeader();
    validateVectorZoomRange(record, header, rasterOverview);
    if (header.specVersion !== 3 || header.tileType !== TileType.Mvt
      || ![header.minLon, header.minLat, header.maxLon, header.maxLat].every(Number.isFinite)
      || header.minLon < -180 || header.maxLon > 180 || header.minLat < -90 || header.maxLat > 90
      || header.minLon >= header.maxLon || header.minLat >= header.maxLat) throw Error("Archive tile header differs from its review.");
    const metadata = await pmtiles.getMetadata();
    const names = metadata.vector_layers?.map(layer => layer.id);
    if (!Array.isArray(names) || names.length !== record.tile_layers.length
      || record.tile_layers.some(layer => !names.includes(layer.source_layer))) throw Error("Archive tile layer inventory differs from its review.");
    let layerRanges = reviewedArchiveLayerRanges(record, metadata);
    const overview = reviewedArchiveOverview(record, metadata);
    let raster=null;
    if(rasterOverview){
      const rasterSource=makeSource(record.objects[1]);
      const rasterCache=new SharedPromiseCache(16,false,decompressReviewedTile);caches.push(rasterCache);
      const archive=new PMTiles(rasterSource,rasterCache,decompressReviewedTile);
      const rasterHeader=await archive.getHeader(),rasterMetadata=await archive.getMetadata();
      validateOverviewHeader(rasterOverview,rasterHeader,header,rasterMetadata);
      raster={archive,header:rasterHeader,review:rasterOverview};
      layerRanges=(layerRanges??record.tile_layers.map(layer=>({sourceLayer:layer.source_layer,minZoom:header.minZoom,maxZoom:header.maxZoom})))
        .map(range=>({...range,minZoom:Math.max(range.minZoom,rasterOverview.vector_min_zoom)}));
      if(layerRanges.some(r=>r.minZoom>r.maxZoom))throw Error('Raster overview hides the declared vector detail.');
    }
    await options.assertScope?.(); options.signal?.throwIfAborted();
    const id = crypto.randomUUID();
    session = {kind: "reviewed-archive-tiles", record, source, pmtiles,
      url: `reviewed-archive://${id}/tiles.json`, header, layerRanges, overview, raster,
      assertScope: options.assertScope,
      fail(error) {this.dispose(); options.onError?.(error);},
      dispose() {sessions.delete(id); dispose();}};
    sessions.set(id, session);
    return session;
  } catch (error) {dispose(); throw error;}
}

// A closed session has no network fallback. Signed S3 URLs never enter map styles.
export async function reviewedArchiveTileResponse({url}, controller) {
  const parsed = new URL(url), session = sessions.get(parsed.hostname);
  if (parsed.protocol !== "reviewed-archive:" || !session || session.source.stats().closed) throw Error("Archive read session is closed.");
  try {
  await session.assertScope?.();
  controller.signal.throwIfAborted();
  if (parsed.pathname === "/tiles.json") {
    const h = session.header;
    const sourceLayer = parsed.searchParams.get("source_layer");
    const range = sourceLayer === null ? {minZoom: h.minZoom, maxZoom: h.maxZoom}
      : session.layerRanges.find(layer => layer.sourceLayer === sourceLayer);
    if (!range) throw Error("Unknown archive tile layer.");
    return {data: {tiles: [session.url.replace("tiles.json", "{z}/{x}/{y}")],
      minzoom: range.minZoom, maxzoom: range.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat]}};
  }
  const raster=parsed.pathname.startsWith('/overview/');
  if(raster&&!session.raster)throw Error('Archive has no reviewed raster overview.');
  const match = parsed.pathname.match(raster ? /^\/overview\/(\d+)\/(\d+)\/(\d+)$/ : /^\/(\d+)\/(\d+)\/(\d+)$/);
  if (!match) throw Error("Invalid archive tile request.");
  const [z, x, y] = match.slice(1).map(Number);
  if (z < 0 || z > 22 || x >= 2 ** z || y >= 2 ** z) throw Error("Invalid archive tile coordinates.");
  if(raster&&(z<session.raster.header.minZoom||z>session.raster.header.maxZoom))throw Error('Overview zoom outside its review.');
  if(!raster&&session.raster&&z<session.raster.review.vector_min_zoom)throw Error('Vector detail is unavailable at overview zoom.');
  const tile = await (raster?session.raster.archive:session.pmtiles).getZxy(z, x, y, controller.signal);
  controller.signal.throwIfAborted();
  if (session.source.stats().closed) throw Error("Archive read session is closed.");
  return {data: raster ? (tile ? validateOverviewPng(tile.data) : null) : tile?.data ?? new Uint8Array()};
  } catch (error) {
    if (!controller.signal.aborted && !session.source.stats().closed) session.fail(error);
    throw error;
  }
}
