export function canClosePolygon(draft, point, project, radius = 12, viewport = null) {
  const coordinates = draft?.coordinates;
  if (draft?.kind !== "Polygon" || !Array.isArray(coordinates) || coordinates.length < 3
    || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
  const distinct = new Set();
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return false;
    distinct.add(JSON.stringify(coordinate.slice(0, 2)));
  }
  if (distinct.size < 3) return false;
  try {
    const first = project(coordinates[0]);
    if (!Number.isFinite(first?.x) || !Number.isFinite(first?.y)) return false;
    if (viewport && !(first.x >= 0 && first.y >= 0 && first.x < viewport.width && first.y < viewport.height)) return false;
    const distance = Math.hypot(first.x - point.x, first.y - point.y);
    if (distance > radius) return false;
    // A nearby later vertex remains an ordinary vertex click, even at a low zoom.
    return !coordinates.slice(1).some(coordinate => {
      if (coordinate[0] === coordinates[0][0] && coordinate[1] === coordinates[0][1]) return false;
      const vertex = project(coordinate);
      return Number.isFinite(vertex?.x) && Number.isFinite(vertex?.y)
        && Math.hypot(vertex.x - point.x, vertex.y - point.y) <= distance;
    });
  } catch { return false; }
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
