export function canClosePolygon(draft, point, project, radius = 12) {
  if (draft?.kind !== "Polygon" || draft.coordinates.length < 3 || !point) return false;
  const first = project(draft.coordinates[0]);
  return Math.hypot(first.x - point.x, first.y - point.y) <= radius;
}

export function mapAuthoringPreview(draft) {
  const coordinates = draft?.coordinates ?? [];
  const features = coordinates.map((coordinate, index) => ({
    type: "Feature", properties: {kind: "vertex", close: index === 0 && Boolean(draft.canClose)},
    geometry: {type: "Point", coordinates: coordinate}
  }));
  const path = draft?.hover && coordinates.length && !draft.canClose
    ? [...coordinates, draft.hover] : coordinates;
  if (path.length >= 2) features.push({type: "Feature", properties: {kind: "edge"}, geometry: {type: "LineString", coordinates: path}});
  if (draft?.kind === "Polygon" && path.length >= 3) features.push({
    type: "Feature", properties: {kind: "area"}, geometry: {type: "Polygon", coordinates: [[...path, path[0]]]}
  });
  if (draft?.kind === "image-overlay" && path.length >= 2) {
    const [[x1, y1], [x2, y2]] = path;
    features.push({type: "Feature", properties: {kind: "area"}, geometry: {type: "Polygon", coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]}});
  }
  return {type: "FeatureCollection", features};
}
