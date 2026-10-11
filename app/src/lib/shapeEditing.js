export function shapeVertexGroups(geometry, path = []) {
  const coordinates = [...path, "coordinates"];
  switch (geometry.type) {
    case "Point": return [{path: coordinates, point: true, closed: false, points: [geometry.coordinates]}];
    case "MultiPoint": return geometry.coordinates.map((point, i) => ({path: [...coordinates, i], point: true, closed: false, points: [point]}));
    case "LineString": return [{path: coordinates, closed: false, points: geometry.coordinates}];
    case "MultiLineString": return geometry.coordinates.map((points, i) => ({path: [...coordinates, i], closed: false, points}));
    case "Polygon": return geometry.coordinates.map((points, i) => ({path: [...coordinates, i], closed: true, points: points.slice(0, -1)}));
    case "MultiPolygon": return geometry.coordinates.flatMap((rings, i) => rings.map((points, j) => ({path: [...coordinates, i, j], closed: true, points: points.slice(0, -1)})));
    case "GeometryCollection": return geometry.geometries.flatMap((child, i) => shapeVertexGroups(child, [...path, "geometries", i]));
    default: return [];
  }
}

export function editShapeVertex(geometry, groupIndex, vertexIndex, coordinate, operation = "move") {
  const result = structuredClone(geometry);
  const group = shapeVertexGroups(result)[groupIndex];
  if (!group || !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= group.points.length) throw new Error("Unknown vertex");
  if (operation !== "delete" && (!coordinate || !coordinate.slice(0, 2).every(Number.isFinite) || coordinate.length < 2 || Math.abs(coordinate[1]) > 90)) throw new Error("Invalid coordinate");
  const parent = group.path.slice(0, -1).reduce((value, key) => value[key], result);
  const key = group.path.at(-1);
  const points = group.points.map((point) => [...point]);
  if (operation === "move") points[vertexIndex] = [...coordinate.slice(0, 2), ...points[vertexIndex].slice(2)];
  else if (operation === "insert" && !group.point) points.splice(vertexIndex + 1, 0, [...coordinate.slice(0, 2), ...points[vertexIndex].slice(2)]);
  else if (operation === "delete" && !group.point && points.length > (group.closed ? 3 : 2)) points.splice(vertexIndex, 1);
  else throw new Error("The shape needs its remaining vertices");
  parent[key] = group.point ? points[0] : group.closed ? [...points, [...points[0]]] : points;
  return result;
}
