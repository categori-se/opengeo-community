// Compare native MVT properties directly; OGR's decoded GeoJSON adds schema nulls
// and can round decimals, so it cannot establish exact tile attribute equality.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {compareTileProperties} from './compare-tile-properties.mjs';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
const allowOmittedNulls=process.argv.includes('--allow-omitted-null-properties');
const progress=process.argv.includes('--progress');
const maximumValueMiB=Number(process.argv.find(x=>x.startsWith('--maximum-value-mib='))?.split('=')[1]??64);
assert.ok(Number.isInteger(maximumValueMiB)&&maximumValueMiB>=64&&maximumValueMiB<=512);
const report=stage=>{if(progress)console.error(JSON.stringify({stage,at:new Date().toISOString(),memory:process.memoryUsage()}));};
report('starting');
const out=resolve(process.argv[2]),review=JSON.parse(await readFile(resolve(out,'receipt.json')));
assert.ok(['content-verified','content-review-failed','built-needs-content-verification','ordinary-detail-built-needs-complete-mixed-display'].includes(review.status));
const bytes=await readFile(resolve(out,review.geometryType?'display.pmtiles':'cadastral.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const root=resolve('..'),manifest=JSON.parse(await readFile(resolve(root,'.local-archives/bhutan-local-20260920/transfer-originals/restoration-manifest.json')));
const sourcePath=resolve(manifest.sourceRoot,review.original.path);
assert.equal(await capturedSha256(sourcePath),review.original.sha256);
const field=review.objectIdField,expected=new Map(),allIds=new Set();
const probePath=resolve(out,'tiny-polygon-probes.json');
const probeIds=new Set(existsSync(probePath)?JSON.parse(await readFile(probePath)).map(x=>x.id):[]),probeFeatures=[];
const shortPath=resolve(out,'short-line-probes.json');
const shortIds=new Set(existsSync(shortPath)?JSON.parse(await readFile(shortPath)).map(x=>x.id):[]),shortFeatures=[];
const pointProbePath=resolve(out,'point-probes.json');
const pointProbeIds=new Set(existsSync(pointProbePath)?JSON.parse(await readFile(pointProbePath)).map(x=>x.id):[]),pointProbeFeatures=[];
assert.ok(pointProbeIds.size<=32);
const markerIds=new Set(review.zeroLengthMarkerIds??[]),markerPositions=new Map();
let sourceCount=0,nullCoordinates=0,emptyLines=0,emptyPolygons=0,nonSpatial=0;
report('reading-original-properties');
for await(const feature of streamCapturedFeatures(sourcePath,{maximumValueMiB})){
 sourceCount++;if(progress&&sourceCount%50000===0)report('source-properties-'+sourceCount);const identity=feature.properties[field],geometry=feature.geometry;
 assert.ok(Number.isSafeInteger(identity)&&!allIds.has(identity),'Source identity must be unique and exact');allIds.add(identity);
 if(probeIds.has(identity))probeFeatures.push(feature);
 if(shortIds.has(identity)){assert.ok(['LineString','MultiLineString'].includes(geometry?.type));shortFeatures.push(feature);}
 if(pointProbeIds.has(identity)){assert.equal(geometry?.type,'Point');pointProbeFeatures.push(feature);}
 const nullCoordinate=geometry?.type==='LineString'&&Object.hasOwn(geometry,'coordinates')&&geometry.coordinates===null;
 const emptyLine=geometry?.type==='LineString'&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length===0;
 const emptyPolygon=geometry?.type==='Polygon'&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length===0;
 nullCoordinates+=Number(nullCoordinate);emptyLines+=Number(emptyLine);emptyPolygons+=Number(emptyPolygon);
 if(geometry===null||nullCoordinate||emptyLine||emptyPolygon){nonSpatial++;continue;}
 expected.set(identity,feature.properties);
 if(markerIds.has(identity)){
  const points=geometry.coordinates;assert.equal(geometry.type,'LineString');assert.ok(points.length>=2&&points.every(p=>JSON.stringify(p)===JSON.stringify(points[0])));
  markerPositions.set(identity,points[0]);
 }
}
report('source-properties-complete');
assert.equal(nullCoordinates,review.nonSpatialNullCoordinateRecords??0);
assert.equal(emptyLines,review.emptyLineRecords??0);
assert.equal(emptyPolygons,review.emptyCoordinateRecords??0);
assert.equal(nonSpatial,review.nonSpatialRecords??0);
if(review.originalSourceFeatures!==undefined)assert.equal(sourceCount,review.originalSourceFeatures);
assert.equal(expected.size,review.sourceFeatures);
assert.equal(markerPositions.size,markerIds.size);
if(probeIds.size){
 assert.equal(probeFeatures.length,probeIds.size);
 await writeFile(resolve(out,'tiny-polygon-source-features.json'),JSON.stringify({originalSha256:review.original.sha256,features:probeFeatures})+'\n');
}
if(shortIds.size){
 assert.equal(shortFeatures.length,shortIds.size);
 await writeFile(resolve(out,'short-line-source-features.json'),JSON.stringify({originalSha256:review.original.sha256,features:shortFeatures})+'\n');
}
if(pointProbeIds.size){
 assert.equal(pointProbeFeatures.length,pointProbeIds.size);
 await writeFile(resolve(out,'point-probe-source-features.json'),JSON.stringify({originalSha256:review.original.sha256,features:pointProbeFeatures})+'\n');
}
const layerNames=review.tileLayers?.map(x=>x.source_layer)??[review.geometryType?'data':'parcels'];
const layerSeen=new Map(layerNames.map(name=>[name,new Set()]));

const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();
const metadata=await archive.getMetadata();
const zoomByLayer=Object.fromEntries(layerNames.map(name=>[name,header.maxZoom]));
const precisionMembership=new Map();
if(review.layerZoomRanges){
 assert.deepEqual(metadata.opengeo_layer_zoom_ranges,review.layerZoomRanges);
 assert.equal(review.layerZoomRanges.version,1);
 assert.equal(review.layerZoomRanges.layers.length,layerNames.length);
 for(const range of review.layerZoomRanges.layers){
  assert.ok(layerNames.includes(range.source_layer)&&Number.isInteger(range.min_zoom)&&Number.isInteger(range.max_zoom));
  assert.ok(range.min_zoom>=header.minZoom&&range.min_zoom<=range.max_zoom&&range.max_zoom<=header.maxZoom);
  zoomByLayer[range.source_layer]=range.max_zoom;
 }
 assert.equal(new Set(review.layerZoomRanges.layers.map(r=>r.source_layer)).size,layerNames.length);
 for(const group of review.precisionGroups??[]){
  assert.ok(layerNames.includes(group.source_layer)&&group.source_layer!==layerNames[0]);
  for(const id of group.ids){assert.ok(expected.has(id)&&!precisionMembership.has(id));precisionMembership.set(id,group.source_layer);}
 }
}
const detailZooms=new Set(Object.values(zoomByLayer));
const positiveGeometryIds=new Set();
const mixedLines=!!review.layerZoomRanges&&['LineString','MultiLineString'].includes(review.geometryType);
const omittedNullFields={},omittedNullIds=new Set();
assert.equal(header.maxZoom,review.recipe.maxZoom);
const seen=new Set(),missingFields={},numericDifferences={},mismatches=new Set(),unknown=new Set(),offsets=new Set();let tiles=0,fragments=0;
async function walk(offset,length,depth=0){
 assert.ok(depth<=3);const entries=await archive.cache.getDirectory(archive.source,offset,length,header);
 for(const entry of entries){
  if(entry.runLength===0){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
  for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
   const [z,x,y]=tileIdToZxy(id),offsetKey=`${z}:${entry.offset}`;if(!detailZooms.has(z)||offsets.has(offsetKey))continue;
   offsets.add(offsetKey);const result=await archive.getZxy(z,x,y),tile=new VectorTile(new Pbf(new Uint8Array(result.data)));tiles++;if(progress&&tiles%5000===0)report('tiles-'+tiles);
   for(const [layerName,layer] of Object.entries(tile.layers)){
    assert.ok(layerNames.includes(layerName));
    if(z!==zoomByLayer[layerName])continue;
    for(let i=0;i<layer.length;i++){
    const feature=layer.feature(i),props=feature.properties,identity=props[field],original=expected.get(identity);fragments++;
    assert.equal(layerName,markerIds.has(identity)?'zero_length_locations':precisionMembership.get(identity)??layerNames[0]);
    layerSeen.get(layerName).add(identity);
    const type=markerIds.has(identity)?1:({Point:1,MultiPoint:1,LineString:2,MultiLineString:2,Polygon:3,MultiPolygon:3}[review.geometryType]??3);assert.equal(feature.type,type);
    if(review.layerZoomRanges){
     assert.equal(feature.type,mixedLines?2:3,'Mixed-detail acceptance covers polygon or line captures');
     const geometry=feature.loadGeometry();
     const positive=mixedLines?geometry.some(r=>r.some((p,i)=>i>0&&(p.x!==r[i-1].x||p.y!==r[i-1].y))):geometry.reduce((sum,r)=>sum+r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p.x*q.y-q.x*p.y;},0),0)!==0;
     if(positive)positiveGeometryIds.add(identity);
    }
    if(markerIds.has(identity)){
     assert.equal(feature.type,1);const position=feature.toGeoJSON(x,y,z).geometry.coordinates,expectedPosition=markerPositions.get(identity),tolerance=2*360/(2**z*layer.extent);
     assert.ok(Math.abs(position[0]-expectedPosition[0])<=tolerance&&Math.abs(position[1]-expectedPosition[1])<=tolerance);
    }

    if(!original){unknown.add(identity);continue;}seen.add(identity);
    const comparison=compareTileProperties(original,props,{allowOmittedNulls});
    for(const key of comparison.omittedNulls){omittedNullFields[key]=(omittedNullFields[key]||0)+1;omittedNullIds.add(identity);}
    for(const key of comparison.mismatches){
     mismatches.add(identity);
     if(!Object.hasOwn(props,key)||!Object.hasOwn(original,key))missingFields[key]=(missingFields[key]||0)+1;
     else if(typeof original[key]==='number'&&typeof props[key]==='number')numericDifferences[key]=Math.max(numericDifferences[key]||0,Math.abs(original[key]-props[key]));
    }
   }
   }
  }
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
for(const layer of review.tileLayers??[])assert.equal(layerSeen.get(layer.source_layer).size,layer.feature_count);

const receipt={status:seen.size===expected.size&&!mismatches.size&&!unknown.size?'passed':'rejected',outputSha256:review.outputSha256,sourceFeatures:expected.size,originalSourceFeatures:sourceCount,nonSpatialRecords:nonSpatial,nullCoordinateRecords:nullCoordinates,emptyLineRecords:emptyLines,emptyPolygonRecords:emptyPolygons,zeroLengthMarkersVerified:markerIds.size,layerCounts:Object.fromEntries([...layerSeen].map(([name,ids])=>[name,ids.size])),uniqueDecodedIds:seen.size,missingIds:expected.size-seen.size,missingIdentitySample:[...expected.keys()].filter(id=>!seen.has(id)).slice(0,1000),propertyMismatches:mismatches.size,unexpectedIds:unknown.size,tiles,fragments,missingOrAddedPropertyOccurrences:missingFields,numericDifferences,networkRequests:0,s3Requests:0,omittedNullPropertyOccurrences:omittedNullFields,featuresWithOmittedNulls:omittedNullIds.size,omittedNullsExplicitlyReviewed:allowOmittedNulls,exactPropertyEquality:seen.size===expected.size&&omittedNullIds.size===0&&!mismatches.size&&!unknown.size,scope:seen.size!==expected.size||mismatches.size||unknown.size?'Maximum-zoom review failed: the identity and property counts describe the observed subset, not complete source equality.':allowOmittedNulls?'All spatial identities and every non-null attribute verified at maximum zoom; explicitly counted source nulls are omitted because MVT has no null value. Originals preserve those nulls.':'Exact native MVT identities and properties at maximum zoom; no conversion via OGR GeoJSON.'};
receipt.maximumZoomByLayer=zoomByLayer;
if(review.layerZoomRanges){
 receipt[mixedLines?'positiveLengthIdsAtDeclaredDetail':'positiveAreaIdsAtDeclaredDetail']=positiveGeometryIds.size;
 if(positiveGeometryIds.size!==expected.size)receipt.status='rejected';
}
if(review.layerZoomRanges)receipt.scope=receipt.status==='passed'
 ?'Every spatial source identity and non-null property verified at its declared layer detail zoom, with exact layer membership. Overview generalization and positional accuracy require separate review.'
 :'Declared layer detail review failed; do not admit this display.';
await writeFile(resolve(out,'mvt-content-verification.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
if(receipt.status!=='passed')process.exitCode=1;
