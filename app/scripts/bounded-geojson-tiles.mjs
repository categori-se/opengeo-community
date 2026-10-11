import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GeoJSONVT} from '@maplibre/geojson-vt';

const dependency=JSON.parse(readFileSync(new URL('../node_modules/@maplibre/geojson-vt/package.json',import.meta.url),'utf8'));
assert.equal(dependency.version,'6.1.0','Review the bounded tile-cache adapter before using another geojson-vt version');

// Offline, version-reviewed adapter for @maplibre/geojson-vt 6.1.0.
// Complete each branch before discarding its cached tiles. No geometry simplification.
export async function visitGeojsonTiles(collection, {minZoom, maxZoom, extent=8192, buffer=160}, visit) {
  assert.ok(Number.isInteger(minZoom)&&Number.isInteger(maxZoom)&&minZoom>=0&&maxZoom>=minZoom&&maxZoom<=22);
  const index=new GeoJSONVT(collection,{maxZoom,extent,buffer,tolerance:0,indexMaxZoom:0,indexMaxPoints:0});
  const cache=index.tileIndex;
  assert.ok(cache?.tiles&&Array.isArray(cache.tileCoords));
  let visited=0,maximumCachedTiles=0;
  const id=(z,x,y)=>32*((2**z)*y+x)+z;
  async function walk(z,x,y){
    const tile=index.getTile(z,x,y);
    // tileCoords is diagnostic bookkeeping, not used by getTile. Keep it bounded too.
    cache.tileCoords.length=0;
    maximumCachedTiles=Math.max(maximumCachedTiles,Object.keys(cache.tiles).length);
    if(tile?.numFeatures){
      visited++;
      if(z>=minZoom)await visit(tile,{z,x,y});
      if(z<maxZoom)for(const [dx,dy] of [[0,0],[0,1],[1,0],[1,1]])await walk(z+1,2*x+dx,2*y+dy);
    }
    delete cache.tiles[id(z,x,y)];
  }
  await walk(0,0,0);
  assert.equal(Object.keys(cache.tiles).length,0);
  return {visited,maximumCachedTiles,retainedCachedTiles:0};
}
