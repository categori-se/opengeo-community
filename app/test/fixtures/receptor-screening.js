export const receptorScreeningIds = Object.freeze({receptors: "b1000000-0000-4000-8000-000000000001",
  footprint: "b2000000-0000-4000-8000-000000000002", influence: "b3000000-0000-4000-8000-000000000003"});
export const receptorFeatureId = number => `98000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const ring = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const feature = (number, geometry) => ({type: "Feature", id: receptorFeatureId(number), geometry,
  properties: {name: `Receptor ${number}`, confidence: null, source: {date: "2024", observations: [null, {verified: false}]}}});
function fixtures(scope) {
  return scope === "footprint" ? [
    feature(1, {type: "Point", coordinates: [85.001, 27.001]}),
    feature(2, {type: "LineString", coordinates: [[85, 27], [85.001, 27], [85.001, 27.002]]}),
    feature(3, {type: "Polygon", coordinates: [ring(85, 27, 85.003, 27.003), ring(85.001, 27.001, 85.002, 27.002)]})
  ] : [
    feature(1, {type: "MultiPoint", coordinates: [[85.001, 27.001], [85.004, 27.004]]}),
    feature(4, {type: "MultiLineString", coordinates: [[[85, 27], [85.001, 27]], [[85.002, 27.002], [85.003, 27.003]]]}),
    feature(5, {type: "MultiPolygon", coordinates: [[ring(85, 27, 85.001, 27.001)], [ring(85.002, 27.002, 85.003, 27.003)]]})
  ];
}
export function receptorClip({scope = "footprint", features = fixtures(scope), sourceCount = 5,
  sourceGeneration = 3, targetGeneration = scope === "footprint" ? 7 : 8,
  maskCount = 1, sourcePoints = 50, receipt = {}} = {}) {
  return {type: "FeatureCollection", features: structuredClone(features), "opengeo:analysis": {
    operation: "clip", version: "1.1.0", sourceDatasetId: receptorScreeningIds.receptors,
    targetDatasetId: receptorScreeningIds[scope], source_generation: sourceGeneration, target_generation: targetGeneration,
    source_count: sourceCount, target_count: maskCount, source_points: sourcePoints, target_points: maskCount ? 5 : 0,
    longitude_span: .01, allowed: true, distanceMeters: null, crs: "CRS:84", persisted: false,
    limits: {features: 1_000, coordinates: 50_000, bytes: 2_097_152, statementSeconds: 5, bufferLongitudeSpanDegrees: 6}, ...receipt
  }};
}
export function receptorScreeningFixture({profile = "mixed"} = {}) {
  const polygons = profile === "polygons";
  const footprint = polygons ? receptorClip({features: [feature(1, {type: "Polygon", coordinates: [ring(85, 27, 85.001, 27.001)]})],
    sourceCount: 2, sourcePoints: 10}) : receptorClip();
  const influence = polygons ? receptorClip({scope: "influence", features: [
    feature(1, {type: "Polygon", coordinates: [ring(85, 27, 85.002, 27.002)]}),
    feature(2, {type: "Polygon", coordinates: [ring(85.003, 27.003, 85.004, 27.004)]})
  ], sourceCount: 2, sourcePoints: 10}) : receptorClip({scope: "influence"});
  return {footprint, influence,
    question: "Which mapped receptors intersect the project footprint and stated influence area?",
    influenceBasis: "User supplied influence polygon representing the selected downstream screening extent."};
}
