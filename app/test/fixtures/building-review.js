// Synthetic comparison evidence for review/persistence tests, not provider accuracy.
export const buildingReviewerId = "a3000000-0000-4000-8000-000000000003";
export function buildingReviewComparison() {
  const id = number => `97000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const row = (side, number, neighbors = []) => ({type: "Feature", id: `${side}:${id(number)}`,
    geometry: {type: "Polygon", coordinates: [[[85.5, 27.6], [85.501, 27.6], [85.501, 27.601], [85.5, 27.601], [85.5, 27.6]]]},
    properties: {input: {side, featureId: id(number), properties: {name: `${side} original ${number}`, confidence: null}},
      reconciliation: {status: neighbors.length ? "one-to-one-candidate" : "unmatched", reviewStatus: "unreviewed", neighbors}}});
  const neighbor = {featureId: id(1), intersectionOverUnion: .8, overlapCount: 1};
  return {type: "FeatureCollection", features: [row("source", 1, [{...neighbor}]), row("target", 1, [{...neighbor}]), row("source", 2)],
    "opengeo:analysis": {operation: "building-reconcile", version: "1.0.0",
      sourceDatasetId: "10000000-0000-4000-8000-000000000008", targetDatasetId: "96000000-0000-4000-8000-000000000001",
      source_generation: 3, target_generation: 7, source_count: 2, target_count: 1,
      persisted: false, crs: "CRS:84", allowed: true, building_polygon_inputs: true,
      buildingReconciliation: {minimumIntersectionOverUnion: .5,
        intersectionMethod: "PostGIS local projected geography overlay", areaMethod: "PostGIS spheroidal geography",
        candidateRule: "one positive-area neighbor on each side", ambiguityRule: "multiple positive-area neighbors on either side",
        unmatched: "retained on both sides", reviewStatus: "unreviewed", validatedCount: null,
        maximumSpanDegrees: 6, maximumAbsoluteLatitude: 80}}};
}
