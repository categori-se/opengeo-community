import maplibregl from "../lib/mapRenderer.js";
import {canClosePolygon} from "../lib/mapAuthoringPreview.js";

const CANVAS_GEOMETRIES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]);
const FEATURE_SOURCE = "opengeo-authoritative-features";
const DRAFT_SOURCE = "opengeo-feature-draft";
const VERTEX_SOURCE = "opengeo-feature-vertices";
const VERTEX_HIT_LAYER = "opengeo-feature-vertex-hit";
const SEGMENT_SOURCE = "opengeo-feature-segments";
const SEGMENT_HIT_LAYER = "opengeo-feature-segment-hit";
const FEATURE_LAYERS = ["opengeo-feature-fill", "opengeo-feature-line", "opengeo-feature-point"];
const SNAP_TOLERANCE_PIXELS = 12;
const SNAP_MODES = Object.freeze(["off", "vertex", "segment", "intersection"]);
const SNAP_LABELS = Object.freeze({
  off: "off",
  vertex: "vertices",
  segment: "vertices + segments",
  intersection: "vertices + segments + intersections"
});
const MAX_NEARBY_SNAP_SEGMENTS = 128;
const MAX_POLYGON_RINGS = 64;
const MAX_MULTI_PARTS = 10000;
const MAX_EDITABLE_MULTI_PARTS = 256;
const MAX_GEOMETRY_POSITIONS = 10000;
const MAX_RING_VERTICES = MAX_GEOMETRY_POSITIONS;
const MAX_TOPOLOGY_VERTICES = 2048;
const TOPOLOGY_EPSILON = 1e-12;
const DRAG_ACTIVATION_PIXELS = 3;
export const EDIT_HISTORY_LIMIT = 50;
export const VERTEX_DRAG_HIT_DIAMETER = 44;

export function canvasEditingSupported(geometryType) {
  return CANVAS_GEOMETRIES.has(geometryType);
}

export function geometryFromCanvasClicks(geometryType, positions) {
  const coordinates = positions.map(validPosition);
  if (geometryType === "Point") return coordinates.length === 1
    ? {type: "Point", coordinates: coordinates[0]}
    : null;
  if (geometryType === "MultiPoint") return coordinates.length >= 1
    ? {type: "MultiPoint", coordinates}
    : null;
  if (geometryType === "LineString") return coordinates.length >= 2
    ? {type: "LineString", coordinates}
    : null;
  if (geometryType === "MultiLineString") return coordinates.length >= 2
    ? {type: "MultiLineString", coordinates: [coordinates]}
    : null;
  if (geometryType === "Polygon" && coordinates.length >= 3) {
    const ring = [...coordinates, [...coordinates[0]]];
    const geometry = {type: "Polygon", coordinates: [ring]};
    validatePolygonGeometry(geometry);
    return geometry;
  }
  if (geometryType === "MultiPolygon" && coordinates.length >= 3) {
    const ring = [...coordinates, [...coordinates[0]]];
    const geometry = {type: "MultiPolygon", coordinates: [[ring]]};
    validateMultiPolygonGeometry(geometry);
    return geometry;
  }
  return null;
}

export function geometryVertexHandles(geometry) {
  if (geometry?.type === "Point") return [{coordinates: validPosition(geometry.coordinates), partIndex: 0, ringIndex: 0, vertexIndex: 0}];
  if (geometry?.type === "MultiPoint") return validMultiPointPositions(geometry).map(
    (coordinates, partIndex) => ({coordinates, partIndex, ringIndex: 0, vertexIndex: 0})
  );
  if (geometry?.type === "LineString") return geometry.coordinates.map((coordinates, vertexIndex) => ({
    coordinates: validPosition(coordinates),
    partIndex: 0,
    ringIndex: 0,
    vertexIndex
  }));
  if (geometry?.type === "MultiLineString") return validMultiLineParts(geometry).flatMap(
    (part, partIndex) => part.map((coordinates, vertexIndex) => ({
      coordinates,
      partIndex,
      ringIndex: 0,
      vertexIndex
    }))
  );
  if (geometry?.type === "Polygon") {
    const rings = validClosedPolygonRings(geometry);
    return rings.flatMap((ring, ringIndex) => ring.slice(0, -1).map(
      (coordinates, vertexIndex) => ({
        coordinates: validPosition(coordinates),
        partIndex: 0,
        ringIndex,
        vertexIndex
      })
    ));
  }
  if (geometry?.type === "MultiPolygon") return validClosedMultiPolygonParts(geometry).flatMap(
    (rings, partIndex) => rings.flatMap((ring, ringIndex) => ring.slice(0, -1).map(
      (coordinates, vertexIndex) => ({
        coordinates,
        partIndex,
        ringIndex,
        vertexIndex
      })
    ))
  );
  throw new TypeError("canvas geometry is unsupported");
}

export function geometryVertices(geometry) {
  return geometryVertexHandles(geometry).map(({coordinates}) => [...coordinates]);
}

export function replaceGeometryVertex(geometry, vertexIndex, position, ringIndex = 0, partIndex = 0) {
  const next = structuredClone(geometry);
  const target = validPosition(position);
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw new RangeError("part index is outside the geometry");
  }
  if (!Number.isInteger(ringIndex) || ringIndex < 0) {
    throw new RangeError("ring index is outside the geometry");
  }
  const vertices = geometryVertexHandles(next).filter((handle) => (
    handle.partIndex === partIndex && handle.ringIndex === ringIndex
  ));
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertices.length) {
    throw new RangeError("vertex index is outside the geometry");
  }
  if (next.type === "Point") next.coordinates = target;
  if (next.type === "MultiPoint") next.coordinates[partIndex] = target;
  if (next.type === "LineString") next.coordinates[vertexIndex] = target;
  if (next.type === "MultiLineString") next.coordinates[partIndex][vertexIndex] = target;
  if (next.type === "Polygon") {
    const ring = next.coordinates[ringIndex];
    if (!ring) throw new RangeError("ring index is outside the geometry");
    ring[vertexIndex] = target;
    if (vertexIndex === 0) ring[ring.length - 1] = [...target];
    validatePolygonGeometry(next);
  }
  if (next.type === "MultiPolygon") {
    const ring = next.coordinates[partIndex]?.[ringIndex];
    if (!ring) throw new RangeError("part or ring index is outside the geometry");
    ring[vertexIndex] = target;
    if (vertexIndex === 0) ring[ring.length - 1] = [...target];
    validateMultiPolygonGeometry(next);
  }
  return next;
}

export function addPolygonHole(geometry, positions, partIndex = 0) {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw new RangeError("part index is outside the geometry");
  }
  if (geometry?.type === "MultiPolygon") {
    validateMultiPolygonGeometry(geometry);
    const part = geometry.coordinates[partIndex];
    if (!part) throw new RangeError("part index is outside the geometry");
    const changedPart = addPolygonHole({type: "Polygon", coordinates: part}, positions);
    const next = structuredClone(geometry);
    next.coordinates[partIndex] = changedPart.coordinates;
    validateMultiPolygonGeometry(next);
    return next;
  }
  if (partIndex !== 0) throw new RangeError("part index is outside the geometry");
  validatePolygonGeometry(geometry);
  if (!Array.isArray(positions) || positions.length < 3) {
    throw new TypeError("a polygon hole needs at least three vertices");
  }
  if (geometry.coordinates.length >= MAX_POLYGON_RINGS) {
    throw new RangeError(`a polygon may contain at most ${MAX_POLYGON_RINGS} rings`);
  }
  const vertices = positions.map(validPosition);
  const next = structuredClone(geometry);
  next.coordinates.push([...vertices, [...vertices[0]]]);
  validatePolygonGeometry(next);
  return next;
}

export function addGeometryPart(geometry, positions) {
  if (!Array.isArray(positions)) throw new TypeError("part positions must be an array");
  const next = structuredClone(geometry);
  if (!["MultiPoint", "MultiLineString", "MultiPolygon"].includes(next?.type)) {
    throw new TypeError("only multipart geometry can add a part");
  }
  if (!Array.isArray(next.coordinates) || next.coordinates.length >= MAX_EDITABLE_MULTI_PARTS) {
    throw new RangeError(`canvas authoring supports at most ${MAX_EDITABLE_MULTI_PARTS} parts`);
  }
  const coordinates = positions.map(validPosition);
  if (next.type === "MultiPoint") {
    if (coordinates.length !== 1) throw new TypeError("a MultiPoint part is one position");
    validMultiPointPositions(next);
    next.coordinates.push(coordinates[0]);
    return next;
  }
  if (next.type === "MultiLineString") {
    if (coordinates.length < 2) throw new TypeError("a line part needs at least two vertices");
    validMultiLineParts(next);
    next.coordinates.push(coordinates);
    return next;
  }
  if (coordinates.length < 3) throw new TypeError("a polygon part needs at least three vertices");
  validateMultiPolygonGeometry(next);
  next.coordinates.push([[...coordinates, [...coordinates[0]]]]);
  validateMultiPolygonGeometry(next);
  return next;
}

export function reorderGeometryPart(geometry, partIndex, targetIndex) {
  const count = geometryPartCount(geometry);
  if (!["MultiPoint", "MultiLineString", "MultiPolygon"].includes(geometry?.type)) {
    throw new TypeError("only multipart geometry can reorder parts");
  }
  for (const [label, index] of [["part", partIndex], ["target", targetIndex]]) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`${label} index is outside the geometry`);
    }
  }
  const next = structuredClone(geometry);
  const [part] = next.coordinates.splice(partIndex, 1);
  next.coordinates.splice(targetIndex, 0, part);
  validateMultipartGeometry(next);
  return next;
}

export function removeGeometryPart(geometry, partIndex) {
  const count = geometryPartCount(geometry);
  if (!["MultiPoint", "MultiLineString", "MultiPolygon"].includes(geometry?.type)) {
    throw new TypeError("only multipart geometry can remove a part");
  }
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= count) {
    throw new RangeError("part index is outside the geometry");
  }
  if (count === 1) throw new RangeError("multipart geometry must retain at least one part");
  const next = structuredClone(geometry);
  next.coordinates.splice(partIndex, 1);
  validateMultipartGeometry(next);
  return next;
}

export function removePolygonRing(geometry, ringIndex, partIndex = 0) {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw new RangeError("part index is outside the geometry");
  }
  if (!Number.isInteger(ringIndex) || ringIndex < 0) {
    throw new RangeError("ring index is outside the geometry");
  }
  if (!["Polygon", "MultiPolygon"].includes(geometry?.type)) {
    throw new TypeError("only polygon geometry can remove a ring");
  }
  if (geometry.type === "Polygon") {
    if (partIndex !== 0) throw new RangeError("part index is outside the geometry");
    validatePolygonGeometry(geometry);
  } else {
    validateMultiPolygonGeometry(geometry);
  }
  const rings = geometry.type === "Polygon"
    ? geometry.coordinates
    : geometry.coordinates[partIndex];
  if (!rings || ringIndex >= rings.length) {
    throw new RangeError("part or ring index is outside the geometry");
  }
  if (ringIndex === 0) throw new RangeError("the polygon exterior ring cannot be removed");
  const next = structuredClone(geometry);
  const nextRings = next.type === "Polygon"
    ? next.coordinates
    : next.coordinates[partIndex];
  nextRings.splice(ringIndex, 1);
  if (next.type === "Polygon") validatePolygonGeometry(next);
  else validateMultiPolygonGeometry(next);
  return next;
}

export function splitMultiLinePart(geometry, partIndex, vertexIndex) {
  if (geometry?.type !== "MultiLineString") {
    throw new TypeError("only MultiLineString geometry can split a line part");
  }
  const parts = validMultiLineParts(geometry);
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) {
    throw new RangeError("part index is outside the geometry");
  }
  if (parts.length >= MAX_EDITABLE_MULTI_PARTS) {
    throw new RangeError(`canvas authoring supports at most ${MAX_EDITABLE_MULTI_PARTS} parts`);
  }
  const part = parts[partIndex];
  if (!Number.isInteger(vertexIndex) || vertexIndex <= 0 || vertexIndex >= part.length - 1) {
    throw new RangeError("a line part can split only at an interior vertex");
  }
  const next = structuredClone(geometry);
  next.coordinates.splice(
    partIndex,
    1,
    part.slice(0, vertexIndex + 1),
    part.slice(vertexIndex)
  );
  validMultiLineParts(next);
  return next;
}

export function mergeTouchingLineParts(geometry, firstPartIndex, secondPartIndex) {
  if (geometry?.type !== "MultiLineString") {
    throw new TypeError("only MultiLineString geometry can merge line parts");
  }
  const parts = validMultiLineParts(geometry);
  for (const index of [firstPartIndex, secondPartIndex]) {
    if (!Number.isInteger(index) || index < 0 || index >= parts.length) {
      throw new RangeError("part index is outside the geometry");
    }
  }
  if (firstPartIndex === secondPartIndex) {
    throw new RangeError("two distinct line parts are required for a merge");
  }
  const joins = joinedLineParts(parts[firstPartIndex], parts[secondPartIndex]);
  if (joins.length !== 1) {
    throw new TypeError("line parts must share exactly one endpoint to merge");
  }
  const insertIndex = Math.min(firstPartIndex, secondPartIndex);
  const next = structuredClone(geometry);
  next.coordinates = next.coordinates.filter((_, index) => (
    index !== firstPartIndex && index !== secondPartIndex
  ));
  next.coordinates.splice(insertIndex, 0, joins[0]);
  validMultiLineParts(next);
  return next;
}

export function insertGeometryVertex(
  geometry,
  segmentStartVertexIndex,
  position,
  ringIndex = 0,
  partIndex = 0
) {
  const next = structuredClone(geometry);
  const target = validPosition(position);
  const segment = selectedGeometrySegment(next, segmentStartVertexIndex, ringIndex, partIndex);
  if (samePosition(segment.start, target) || samePosition(segment.end, target)) {
    throw new TypeError("a new vertex must differ from both segment endpoints");
  }
  if (next.type === "LineString") {
    if (next.coordinates.length >= MAX_GEOMETRY_POSITIONS) {
      throw new RangeError(`geometry may contain at most ${MAX_GEOMETRY_POSITIONS} positions`);
    }
    next.coordinates.splice(segmentStartVertexIndex + 1, 0, target);
    geometrySegments(next);
    return next;
  }
  if (next.type === "MultiLineString") {
    next.coordinates[partIndex].splice(segmentStartVertexIndex + 1, 0, target);
    validMultiLineParts(next);
    return next;
  }
  const ring = next.type === "Polygon"
    ? next.coordinates[ringIndex]
    : next.coordinates[partIndex][ringIndex];
  ring.splice(segmentStartVertexIndex + 1, 0, target);
  if (next.type === "Polygon") validatePolygonGeometry(next);
  else validateMultiPolygonGeometry(next);
  return next;
}

export function removeGeometryVertex(geometry, vertexIndex, ringIndex = 0, partIndex = 0) {
  if (geometry?.type === "Point") throw new RangeError("a Point must retain its position");
  if (geometry?.type === "MultiPoint") {
    if (ringIndex !== 0 || vertexIndex !== 0) {
      throw new RangeError("vertex index is outside the geometry");
    }
    return removeGeometryPart(geometry, partIndex);
  }
  const next = structuredClone(geometry);
  const handles = geometryVertexHandles(next).filter((handle) => (
    handle.partIndex === partIndex && handle.ringIndex === ringIndex
  ));
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= handles.length) {
    throw new RangeError("vertex index is outside the geometry");
  }
  if (next.type === "LineString" || next.type === "MultiLineString") {
    if (ringIndex !== 0) throw new RangeError("ring index is outside the geometry");
    const line = next.type === "LineString" ? next.coordinates : next.coordinates[partIndex];
    if (line.length <= 2) throw new RangeError("a line part must retain at least two vertices");
    line.splice(vertexIndex, 1);
    if (next.type === "LineString") geometrySegments(next);
    else validMultiLineParts(next);
    return next;
  }
  const ring = next.type === "Polygon"
    ? next.coordinates[ringIndex]
    : next.coordinates[partIndex]?.[ringIndex];
  if (!ring) throw new RangeError("part or ring index is outside the geometry");
  const vertices = ring.slice(0, -1);
  if (vertices.length <= 3) {
    throw new RangeError("a polygon ring must retain at least three vertices");
  }
  vertices.splice(vertexIndex, 1);
  const closed = [...vertices, [...vertices[0]]];
  if (next.type === "Polygon") next.coordinates[ringIndex] = closed;
  else next.coordinates[partIndex][ringIndex] = closed;
  if (next.type === "Polygon") validatePolygonGeometry(next);
  else validateMultiPolygonGeometry(next);
  return next;
}

export function validatePolygonGeometry(geometry) {
  if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates)) {
    throw new TypeError("invalid polygon");
  }
  if (!geometry.coordinates.length || geometry.coordinates.length > MAX_POLYGON_RINGS) {
    throw new TypeError(`a polygon must contain 1 to ${MAX_POLYGON_RINGS} rings`);
  }
  const rings = geometry.coordinates.map((ring, ringIndex) => validSimpleRing(ring, ringIndex));
  const vertexCount = rings.reduce((count, ring) => count + ring.length - 1, 0);
  if (vertexCount > MAX_TOPOLOGY_VERTICES) {
    throw new RangeError(`canvas topology editing supports at most ${MAX_TOPOLOGY_VERTICES} polygon vertices`);
  }
  const outer = rings[0];
  for (let holeIndex = 1; holeIndex < rings.length; holeIndex += 1) {
    const hole = rings[holeIndex];
    if (!hole.slice(0, -1).every((position) => pointInRingStrict(position, outer))) {
      throw new TypeError(`polygon hole ${holeIndex} must be strictly inside the outer ring`);
    }
    if (ringsIntersect(hole, outer)) {
      throw new TypeError(`polygon hole ${holeIndex} may not touch or cross the outer ring`);
    }
    for (let priorIndex = 1; priorIndex < holeIndex; priorIndex += 1) {
      const prior = rings[priorIndex];
      if (
        ringsIntersect(hole, prior)
        || pointInRingStrict(hole[0], prior)
        || pointInRingStrict(prior[0], hole)
      ) {
        throw new TypeError("polygon holes may not touch, overlap, or contain one another");
      }
    }
  }
  return true;
}

export function validateMultiPolygonGeometry(geometry) {
  if (geometry?.type !== "MultiPolygon") throw new TypeError("invalid multipolygon");
  const parts = validClosedMultiPolygonParts(geometry);
  const vertexCount = parts.reduce((total, rings) => (
    total + rings.reduce((partTotal, ring) => partTotal + ring.length - 1, 0)
  ), 0);
  if (vertexCount > MAX_TOPOLOGY_VERTICES) {
    throw new RangeError(`canvas topology editing supports at most ${MAX_TOPOLOGY_VERTICES} polygon vertices`);
  }
  const polygons = parts.map((coordinates) => {
    const polygon = {type: "Polygon", coordinates};
    validatePolygonGeometry(polygon);
    return coordinates;
  });
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < polygons.length; secondIndex += 1) {
      const first = polygons[firstIndex];
      const second = polygons[secondIndex];
      const boundariesMeet = first.some((firstRing) => second.some(
        (secondRing) => ringsIntersect(firstRing, secondRing)
      ));
      if (
        boundariesMeet
        || pointInPolygonStrict(first[0][0], second)
        || pointInPolygonStrict(second[0][0], first)
      ) {
        throw new TypeError("multipolygon parts may not touch, overlap, or contain one another");
      }
    }
  }
  return true;
}

export function geometryPartCount(geometry) {
  if (["Point", "LineString", "Polygon"].includes(geometry?.type)) return 1;
  if (geometry?.type === "MultiPoint") return validMultiPointPositions(geometry).length;
  if (geometry?.type === "MultiLineString") return validMultiLineParts(geometry).length;
  if (geometry?.type === "MultiPolygon") return validClosedMultiPolygonParts(geometry).length;
  throw new TypeError("canvas geometry is unsupported");
}

export function multiPolygonPartAtPosition(geometry, position) {
  const target = validPosition(position);
  const parts = validClosedMultiPolygonParts(geometry);
  const index = parts.findIndex((rings) => pointInPolygonStrict(target, rings));
  return index < 0 ? null : index;
}

export function geometryPartAtPosition(geometry, position, project = defaultProject) {
  const target = validPosition(position);
  if (typeof project !== "function") throw new TypeError("part selection projection is required");
  if (["Point", "LineString", "Polygon"].includes(geometry?.type)) return 0;
  if (geometry?.type === "MultiPolygon") return multiPolygonPartAtPosition(geometry, target);
  const targetPixel = validPixel(project(target));
  if (geometry?.type === "MultiPoint") {
    const handles = geometryVertexHandles(geometry);
    return handles.reduce((best, handle) => {
      const pixel = validPixel(project(handle.coordinates));
      const distance = Math.hypot(pixel.x - targetPixel.x, pixel.y - targetPixel.y);
      return best === null || distance < best.distance
        ? {partIndex: handle.partIndex, distance}
        : best;
    }, null)?.partIndex ?? null;
  }
  if (geometry?.type === "MultiLineString") {
    return geometrySegments(geometry).reduce((best, segment) => {
      const closest = closestPointOnPixelSegment(
        targetPixel,
        validPixel(project(segment.start)),
        validPixel(project(segment.end))
      );
      return best === null || closest.distancePixels < best.distance
        ? {partIndex: segment.partIndex, distance: closest.distancePixels}
        : best;
    }, null)?.partIndex ?? null;
  }
  throw new TypeError("canvas geometry is unsupported");
}

export function snapToNearestVertex(position, candidates, project, tolerancePixels = SNAP_TOLERANCE_PIXELS) {
  const target = validPosition(position);
  if (!Array.isArray(candidates)) throw new TypeError("snap candidates must be an array");
  if (typeof project !== "function") throw new TypeError("snap projection is required");
  if (!Number.isFinite(tolerancePixels) || tolerancePixels <= 0 || tolerancePixels > 64) {
    throw new RangeError("snap tolerance is outside the supported range");
  }
  const targetPixel = validPixel(project(target));
  let nearest = null;
  let nearestDistance = tolerancePixels;
  for (const candidate of candidates) {
    const coordinates = validPosition(candidate);
    const pixel = validPixel(project(coordinates));
    const distance = Math.hypot(pixel.x - targetPixel.x, pixel.y - targetPixel.y);
    if (distance > nearestDistance) continue;
    nearest = coordinates;
    nearestDistance = distance;
  }
  return nearest === null ? null : [...nearest];
}

export function dragActivationExceeded(start, current, thresholdPixels = DRAG_ACTIVATION_PIXELS) {
  const startPixel = validPixel(start);
  const currentPixel = validPixel(current);
  if (
    !Number.isFinite(thresholdPixels)
    || thresholdPixels < 1
    || thresholdPixels > 24
  ) throw new RangeError("drag activation threshold is outside the supported range");
  return Math.hypot(
    currentPixel.x - startPixel.x,
    currentPixel.y - startPixel.y
  ) >= thresholdPixels;
}

export function geometrySegments(geometry) {
  if (geometry?.type === "Point" || geometry?.type === "MultiPoint") {
    if (geometry.type === "MultiPoint") validMultiPointPositions(geometry);
    return [];
  }
  if (geometry?.type === "LineString") {
    const coordinates = geometry.coordinates?.map(validPosition);
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new TypeError("invalid line string");
    }
    return openLineSegments(coordinates, 0);
  }
  if (geometry?.type === "MultiLineString") return validMultiLineParts(geometry).flatMap(
    (part, partIndex) => openLineSegments(part, partIndex)
  );
  if (geometry?.type === "Polygon") {
    const rings = validClosedPolygonRings(geometry);
    return rings.flatMap((ring, ringIndex) => ring.slice(0, -1).map(
      (start, index) => ({
        start: [...start],
        end: [...ring[index + 1]],
        partIndex: 0,
        ringIndex,
        startVertexIndex: index,
        endVertexIndex: index + 1 === ring.length - 1 ? 0 : index + 1
      })
    ));
  }
  if (geometry?.type === "MultiPolygon") return validClosedMultiPolygonParts(geometry).flatMap(
    (rings, partIndex) => rings.flatMap((ring, ringIndex) => ring.slice(0, -1).map(
      (start, index) => ({
        start: [...start],
        end: [...ring[index + 1]],
        partIndex,
        ringIndex,
        startVertexIndex: index,
        endVertexIndex: index + 1 === ring.length - 1 ? 0 : index + 1
      })
    ))
  );
  throw new TypeError("canvas geometry is unsupported");
}

export function snapToGeometry(
  position,
  candidates,
  project,
  unproject,
  {
    mode = "intersection",
    tolerancePixels = SNAP_TOLERANCE_PIXELS,
    excludedFeatureId = null,
    excludedPartIndex = 0,
    excludedRingIndex = 0,
    excludedVertexIndex = null
  } = {}
) {
  const target = validPosition(position);
  if (!Array.isArray(candidates)) throw new TypeError("snap candidates must be an array");
  if (!SNAP_MODES.includes(mode)) throw new TypeError("snap mode is unsupported");
  if (mode === "off") return null;
  if (typeof project !== "function") throw new TypeError("snap projection is required");
  if (mode !== "vertex" && typeof unproject !== "function") {
    throw new TypeError("snap inverse projection is required");
  }
  if (!Number.isFinite(tolerancePixels) || tolerancePixels <= 0 || tolerancePixels > 64) {
    throw new RangeError("snap tolerance is outside the supported range");
  }
  if (
    excludedPartIndex !== null
    && (!Number.isInteger(excludedPartIndex) || excludedPartIndex < 0)
  ) throw new RangeError("excluded part index is invalid");
  if (
    excludedRingIndex !== null
    && (!Number.isInteger(excludedRingIndex) || excludedRingIndex < 0)
  ) throw new RangeError("excluded ring index is invalid");
  if (
    excludedVertexIndex !== null
    && (!Number.isInteger(excludedVertexIndex) || excludedVertexIndex < 0)
  ) throw new RangeError("excluded vertex index is invalid");

  const targetPixel = validPixel(project(target));
  const featureCandidates = candidates.map((candidate) => {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError("snap feature candidate is invalid");
    }
    return {
      id: String(candidate.id),
      geometry: candidate.geometry,
      vertices: geometryVertexHandles(candidate.geometry),
      segments: geometrySegments(candidate.geometry)
    };
  });
  const best = {vertex: null, segment: null, intersection: null};
  const consider = (kind, coordinates, distancePixels) => {
    if (distancePixels > tolerancePixels) return;
    if (best[kind] === null || distancePixels < best[kind].distancePixels - 1e-9) {
      best[kind] = {
        kind,
        position: [...validPosition(coordinates)],
        distancePixels
      };
    }
  };

  for (const feature of featureCandidates) {
    for (const handle of feature.vertices) {
      if (
        excludedFeatureId !== null
        && feature.id === String(excludedFeatureId)
        && handle.partIndex === excludedPartIndex
        && handle.ringIndex === excludedRingIndex
        && handle.vertexIndex === excludedVertexIndex
      ) continue;
      const pixel = validPixel(project(handle.coordinates));
      consider(
        "vertex",
        handle.coordinates,
        Math.hypot(pixel.x - targetPixel.x, pixel.y - targetPixel.y)
      );
    }
  }
  if (mode === "vertex") return publicSnapResult(best.vertex);

  const projectedSegments = [];
  for (const feature of featureCandidates) {
    for (const segment of feature.segments) {
      if (
        excludedFeatureId !== null
        && feature.id === String(excludedFeatureId)
        && (segment.partIndex ?? 0) === excludedPartIndex
        && (segment.ringIndex ?? 0) === excludedRingIndex
        && (
          segment.startVertexIndex === excludedVertexIndex
          || segment.endVertexIndex === excludedVertexIndex
        )
      ) continue;
      const startPixel = validPixel(project(segment.start));
      const endPixel = validPixel(project(segment.end));
      const closest = closestPointOnPixelSegment(targetPixel, startPixel, endPixel);
      if (closest.distancePixels > tolerancePixels) continue;
      const projected = {
        ...segment,
        featureId: feature.id,
        startPixel,
        endPixel,
        closestDistancePixels: closest.distancePixels
      };
      projectedSegments.push(projected);
      consider(
        "segment",
        inverseProjectedPosition(unproject, closest.pixel),
        closest.distancePixels
      );
    }
  }
  if (mode === "intersection") {
    const nearby = projectedSegments
      .sort((left, right) => left.closestDistancePixels - right.closestDistancePixels)
      .slice(0, MAX_NEARBY_SNAP_SEGMENTS);
    for (let firstIndex = 0; firstIndex < nearby.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < nearby.length; secondIndex += 1) {
        const intersection = pixelSegmentIntersection(nearby[firstIndex], nearby[secondIndex]);
        if (intersection === null) continue;
        const distancePixels = Math.hypot(
          intersection.x - targetPixel.x,
          intersection.y - targetPixel.y
        );
        consider(
          "intersection",
          inverseProjectedPosition(unproject, intersection),
          distancePixels
        );
      }
    }
  }
  return publicSnapResult(best.vertex ?? best.intersection ?? best.segment);
}

export function createDraftHistory(value, limit = EDIT_HISTORY_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("draft history limit is outside the supported range");
  }
  return {limit, past: [], present: structuredClone(value), future: []};
}

export function commitDraftHistory(history, value) {
  const current = validDraftHistory(history);
  return {
    limit: current.limit,
    past: [...current.past, structuredClone(current.present)].slice(-current.limit),
    present: structuredClone(value),
    future: []
  };
}

export function undoDraftHistory(history) {
  const current = validDraftHistory(history);
  if (!current.past.length) return history;
  return {
    limit: current.limit,
    past: current.past.slice(0, -1).map((value) => structuredClone(value)),
    present: structuredClone(current.past.at(-1)),
    future: [structuredClone(current.present), ...current.future]
      .slice(0, current.limit)
      .map((value) => structuredClone(value))
  };
}

export function redoDraftHistory(history) {
  const current = validDraftHistory(history);
  if (!current.future.length) return history;
  return {
    limit: current.limit,
    past: [...current.past, structuredClone(current.present)]
      .slice(-current.limit)
      .map((value) => structuredClone(value)),
    present: structuredClone(current.future[0]),
    future: current.future.slice(1).map((value) => structuredClone(value))
  };
}

export function createVertexDragSession(geometry, vertexIndex, ringIndex = 0, partIndex = 0) {
  const handle = geometryVertexHandles(geometry).find((candidate) => (
    candidate.partIndex === partIndex
    && candidate.ringIndex === ringIndex
    && candidate.vertexIndex === vertexIndex
  ));
  if (!handle) throw new RangeError("drag vertex is outside the geometry");
  return {
    partIndex,
    ringIndex,
    vertexIndex,
    originalPosition: [...handle.coordinates],
    originalGeometry: structuredClone(geometry),
    geometry: structuredClone(geometry),
    changed: false
  };
}

export function previewVertexDrag(session, position) {
  const current = validVertexDragSession(session);
  const geometry = replaceGeometryVertex(
    current.originalGeometry,
    current.vertexIndex,
    position,
    current.ringIndex,
    current.partIndex
  );
  const handle = geometryVertexHandles(geometry).find((candidate) => (
    candidate.partIndex === current.partIndex
    && candidate.ringIndex === current.ringIndex
    && candidate.vertexIndex === current.vertexIndex
  ));
  return {
    partIndex: current.partIndex,
    ringIndex: current.ringIndex,
    vertexIndex: current.vertexIndex,
    originalPosition: [...current.originalPosition],
    originalGeometry: structuredClone(current.originalGeometry),
    geometry: structuredClone(geometry),
    changed: !samePosition(handle.coordinates, current.originalPosition)
  };
}

export function commitVertexDragHistory(history, session, featureId) {
  const current = validVertexDragSession(session);
  if (!current.changed) return history;
  if (typeof featureId !== "string" || featureId.length < 1 || featureId.length > 128) {
    throw new TypeError("drag feature identity is invalid");
  }
  return commitDraftHistory(history, {
    kind: "selected",
    featureId,
    geometry: structuredClone(current.geometry)
  });
}

export function FeatureCanvas({collection, features, initialGeometry, onGeometryChange, onSelectFeature, mapEngine = maplibregl}) {
  const root = document.createElement("section");
  root.className = "project-feature-canvas";
  root.append(
    text("h5", "Map-canvas capture"),
    text(
      "p",
      "Draw and structurally edit single or multipart CRS84 geometry. Add, reorder, split, merge, or remove parts; insert, move, or delete vertices; and add or remove polygon holes without bypassing the version-checked Save.",
      "project-catalog-feedback"
    )
  );
  if (!canvasEditingSupported(collection.geometryType)) {
    root.append(text(
      "p",
      `${collection.geometryType} remains editable as exact GeoJSON; this map canvas does not support its geometry family.`,
      "project-catalog-error"
    ));
    return root;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "project-feature-canvas-toolbar";
  const draw = button("Draw new");
  const select = button("Select feature");
  const move = button("Move vertex");
  const insertsVertices = !["Point", "MultiPoint"].includes(collection.geometryType);
  const insertVertex = insertsVertices ? button("Insert vertex") : null;
  const removeVertex = insertsVertices ? button("Delete vertex") : null;
  const addPart = collection.geometryType.startsWith("Multi") ? button("Add part") : null;
  const addHole = ["Polygon", "MultiPolygon"].includes(collection.geometryType)
    ? button("Add hole")
    : null;
  const removeHole = addHole ? button("Delete hole") : null;
  const splitPart = collection.geometryType === "MultiLineString"
    ? button("Split line")
    : null;
  const mergePart = collection.geometryType === "MultiLineString"
    ? button("Merge touching")
    : null;
  if (splitPart) {
    splitPart.title = "Split one multiline component at an interior vertex";
    mergePart.title = "Merge the selected component with its one unambiguous endpoint neighbor";
  }
  if (removeHole) {
    removeHole.title = "Remove one selected polygon interior ring from the draft";
  }
  const targetPart = collection.geometryType.startsWith("Multi") ? button("Part 1/1") : null;
  const partEarlier = targetPart ? button("Part ↑") : null;
  const partLater = targetPart ? button("Part ↓") : null;
  const removePart = targetPart ? button("Delete part") : null;
  if (partEarlier) {
    partEarlier.title = "Move the selected multipart component earlier";
    partEarlier.setAttribute("aria-label", "Move selected part earlier");
    partLater.title = "Move the selected multipart component later";
    partLater.setAttribute("aria-label", "Move selected part later");
    removePart.title = "Remove the selected multipart component from the draft";
  }
  const snap = button("Snap: off");
  snap.setAttribute("aria-pressed", "false");
  const undo = button("Undo");
  undo.disabled = true;
  undo.title = "Undo draft edit (Ctrl/Command+Z)";
  const redo = button("Redo");
  redo.disabled = true;
  redo.title = "Redo draft edit (Ctrl/Command+Shift+Z or Ctrl/Command+Y)";
  const finish = button("Finish geometry");
  const cancel = button("Cancel canvas edit");
  toolbar.append(draw, select, move);
  const structureControls = document.createElement("details");
  structureControls.className = "project-feature-structure-controls";
  const structureSummary = text("summary", "Edit structure");
  const structureToolbar = document.createElement("div");
  structureToolbar.className = "project-feature-structure-toolbar";
  if (insertVertex) structureToolbar.append(insertVertex);
  if (removeVertex) structureToolbar.append(removeVertex);
  if (splitPart) structureToolbar.append(splitPart, mergePart);
  if (addPart) structureToolbar.append(addPart);
  if (addHole) structureToolbar.append(addHole, removeHole);
  if (targetPart) structureToolbar.append(targetPart, partEarlier, partLater, removePart);
  if (structureToolbar.childElementCount) {
    structureControls.append(structureSummary, structureToolbar);
    toolbar.append(structureControls);
  }
  toolbar.append(snap, undo, redo, finish, cancel);
  const mapContainer = document.createElement("div");
  mapContainer.className = "project-feature-map";
  mapContainer.role = "application";
  mapContainer.ariaLabel = `${collection.geometryType} feature editing map`;
  mapContainer.tabIndex = 0;
  const status = text("p", "Choose Draw new or Select feature.", "project-feature-canvas-status");
  status.ariaLive = "polite";
  root.append(toolbar, mapContainer, status);

  const displayFeatures = new Map(features.map((feature) => [feature.id, structuredClone(feature)]));
  const state = {
    geometryType: collection.geometryType,
    mode: "inspect",
    clicks: [],
    draftGeometry: structuredClone(initialGeometry),
    selectedFeature: null,
    selectedGeometry: null,
    selectedVertex: null,
    selectedPartIndex: 0,
    holeBaseGeometry: null,
    partBaseGeometry: null,
    dragSession: null,
    dragStartPixel: null,
    dragActivated: false,
    dragRejected: false,
    gestureRestore: null,
    suppressClickUntil: 0,
    snapMode: "off",
    history: createDraftHistory({kind: "idle"}),
    loaded: false
  };
  updatePartTargetControl();
  const map = new mapEngine.Map({
    container: mapContainer,
    style: {
      version: 8,
      sources: {},
      layers: [{id: "background", type: "background", paint: {"background-color": "#102333"}}]
    },
    center: initialCenter(features),
    zoom: features.length ? 10 : 1,
    attributionControl: false,
    transformRequest: (url) => ({url, credentials: "omit"})
  });
  map.addControl(new mapEngine.NavigationControl({showCompass: false}), "top-right");
  map.on("load", () => {
    state.loaded = true;
    addSourcesAndLayers(map);
    syncMap(map, displayFeatures, state);
    fitFeatureBounds(map, features);
    map.on("mousedown", VERTEX_HIT_LAYER, beginVertexDrag);
    map.on("touchstart", VERTEX_HIT_LAYER, beginVertexDrag);
    map.on("mousemove", previewActiveVertexDrag);
    map.on("touchmove", previewActiveVertexDrag);
    map.on("mouseup", finishActiveVertexDrag);
    map.on("touchend", finishActiveVertexDrag);
    map.on("mouseenter", VERTEX_HIT_LAYER, () => {
      if (["move", "delete", "split", "ring-delete"].includes(state.mode) && !state.dragSession) {
        map.getCanvas().style.cursor = state.mode === "move" ? "grab" : "pointer";
      }
    });
    map.on("mouseleave", VERTEX_HIT_LAYER, () => {
      if (!state.dragSession) map.getCanvas().style.cursor = "";
    });
    map.on("mouseenter", SEGMENT_HIT_LAYER, () => {
      if (state.mode === "insert") map.getCanvas().style.cursor = "crosshair";
    });
    map.on("mouseleave", SEGMENT_HIT_LAYER, () => {
      if (!state.dragSession) map.getCanvas().style.cursor = "";
    });
  });
  map.on("click", (event) => handleMapClick(event));

  draw.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    state.mode = "draw";
    state.clicks = [];
    state.selectedFeature = null;
    state.selectedGeometry = null;
    state.selectedVertex = null;
    state.selectedPartIndex = 0;
    state.holeBaseGeometry = null;
    state.partBaseGeometry = null;
    state.history = createDraftHistory({kind: "draw", clicks: []});
    updateHistoryControls();
    status.textContent = drawInstruction(collection.geometryType);
    syncMap(map, displayFeatures, state);
  });
  insertVertex?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    if (!state.selectedFeature || !state.selectedGeometry) {
      status.textContent = "Select an existing line or polygon before inserting a vertex.";
      return;
    }
    state.mode = "insert";
    state.selectedVertex = null;
    status.textContent = "Click a highlighted segment to insert a vertex at that position.";
    syncMap(map, displayFeatures, state);
  });
  removeVertex?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    if (!state.selectedFeature || !state.selectedGeometry) {
      status.textContent = "Select an existing feature before deleting a vertex.";
      return;
    }
    if (state.selectedVertex) {
      deleteSelectedVertex(state.selectedVertex);
      return;
    }
    state.mode = "delete";
    status.textContent = "Click a highlighted vertex to remove it. Minimum geometry sizes still apply.";
    syncMap(map, displayFeatures, state);
  });
  splitPart?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    if (!state.selectedFeature || state.selectedGeometry?.type !== "MultiLineString") {
      status.textContent = "Select an existing multiline feature before splitting a component.";
      return;
    }
    state.mode = "split";
    state.selectedVertex = null;
    status.textContent = "Click an interior vertex to split its line component into two components.";
    syncMap(map, displayFeatures, state);
  });
  mergePart?.addEventListener("click", () => mergeSelectedLinePart());
  addPart?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    try {
      if (geometry?.type !== collection.geometryType) throw new TypeError("multipart draft unavailable");
      geometryPartCount(geometry);
    } catch (error) {
      status.textContent = `Draw or select a valid ${collection.geometryType} before adding a part: ${error.message}`;
      return;
    }
    if (geometryPartCount(geometry) >= MAX_EDITABLE_MULTI_PARTS) {
      status.textContent = `This geometry already has the ${MAX_EDITABLE_MULTI_PARTS}-part canvas maximum.`;
      return;
    }
    state.mode = "part";
    state.clicks = [];
    state.selectedVertex = null;
    state.partBaseGeometry = structuredClone(geometry);
    state.holeBaseGeometry = null;
    state.history = createDraftHistory({
      kind: "part",
      clicks: [],
      geometry: structuredClone(geometry),
      featureId: state.selectedFeature ? String(state.selectedFeature.id) : null
    });
    updateHistoryControls();
    status.textContent = partInstruction(collection.geometryType);
    syncMap(map, displayFeatures, state);
  });
  addHole?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    try {
      if (geometry?.type === "MultiPolygon") validateMultiPolygonGeometry(geometry);
      else validatePolygonGeometry(geometry);
    } catch (error) {
      status.textContent = ["Polygon", "MultiPolygon"].includes(geometry?.type)
        ? `This polygon cannot enter bounded hole editing: ${error.message}`
        : "Draw a polygon or select an existing polygon before adding a hole.";
      return;
    }
    state.selectedPartIndex = Math.min(
      state.selectedPartIndex,
      geometryPartCount(geometry) - 1
    );
    state.mode = "hole";
    state.clicks = [];
    state.selectedVertex = null;
    state.holeBaseGeometry = structuredClone(geometry);
    state.partBaseGeometry = null;
    state.history = createDraftHistory({
      kind: "hole",
      clicks: [],
      geometry: structuredClone(geometry),
      featureId: state.selectedFeature ? String(state.selectedFeature.id) : null
    });
    updateHistoryControls();
    status.textContent = `Click at least three vertices strictly inside polygon part ${state.selectedPartIndex + 1}, then choose Finish geometry.`;
    syncMap(map, displayFeatures, state);
  });
  removeHole?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    if (
      !state.selectedFeature
      || !["Polygon", "MultiPolygon"].includes(state.selectedGeometry?.type)
    ) {
      status.textContent = "Select an existing polygon with an interior ring before deleting a hole.";
      return;
    }
    state.mode = "ring-delete";
    state.selectedVertex = null;
    status.textContent = "Click any highlighted vertex on the interior ring you want to remove.";
    syncMap(map, displayFeatures, state);
  });
  targetPart?.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    if (!geometry?.type?.startsWith("Multi")) {
      status.textContent = "Draw or select multipart geometry before choosing a target part.";
      return;
    }
    const count = geometryPartCount(geometry);
    state.selectedPartIndex = (state.selectedPartIndex + 1) % count;
    updatePartTargetControl();
    status.textContent = `Multipart component ${state.selectedPartIndex + 1} is selected for structure commands${geometry.type === "MultiPolygon" ? " and Add hole" : ""}.`;
  });
  partEarlier?.addEventListener("click", () => moveSelectedPart(-1));
  partLater?.addEventListener("click", () => moveSelectedPart(1));
  removePart?.addEventListener("click", () => deleteSelectedPart());
  select.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    state.mode = "select";
    state.clicks = [];
    state.selectedVertex = null;
    state.holeBaseGeometry = null;
    state.partBaseGeometry = null;
    state.history = createDraftHistory({kind: "idle"});
    updateHistoryControls();
    status.textContent = "Click an existing feature on the map.";
    syncMap(map, displayFeatures, state);
  });
  move.addEventListener("click", () => {
    cancelActiveVertexDrag({announce: false});
    if (!state.selectedFeature) {
      status.textContent = "Select an existing feature before moving a vertex.";
      return;
    }
    state.mode = "move";
    state.selectedVertex = null;
    status.textContent = "Drag a highlighted vertex, or click a handle and then its new location.";
    syncMap(map, displayFeatures, state);
  });
  snap.addEventListener("click", () => {
    const current = SNAP_MODES.indexOf(state.snapMode);
    state.snapMode = SNAP_MODES[(current + 1) % SNAP_MODES.length];
    snap.setAttribute("aria-pressed", String(state.snapMode !== "off"));
    snap.textContent = `Snap: ${SNAP_LABELS[state.snapMode]}`;
    status.textContent = state.snapMode === "off"
      ? "Screen-space snapping is off."
      : `Snapping to ${SNAP_LABELS[state.snapMode]} within ${SNAP_TOLERANCE_PIXELS} screen pixels.`;
  });
  undo.addEventListener("click", () => moveThroughHistory("undo"));
  redo.addEventListener("click", () => moveThroughHistory("redo"));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.dragSession) {
      event.preventDefault();
      cancelActiveVertexDrag();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      moveThroughHistory(event.shiftKey ? "redo" : "undo");
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      moveThroughHistory("redo");
    }
  });
  finish.addEventListener("click", () => finishDraw());
  cancel.addEventListener("click", () => resetCanvas(initialGeometry));

  root.selectFeature = (feature) => selectExisting(feature);
  root.resetGeometry = (geometry) => resetCanvas(geometry);
  root.__resize = () => map.resize();
  let disposed = false;
  root.__destroy = () => {
    if (disposed) return;
    disposed = true;
    delete root.__resize;
    restoreMapGestures();
    map.remove();
  };
  return root;

  function handleMapClick(event) {
    if (Date.now() <= state.suppressClickUntil) return;
    const rawPosition = roundedPosition([event.lngLat.lng, event.lngLat.lat]);
    if (["draw", "hole", "part"].includes(state.mode)) {
      const drawingHole = state.mode === "hole";
      const drawingPart = state.mode === "part";
      const polygon = drawingHole || componentGeometryType(collection.geometryType) === "Polygon";
      if (polygon && !map.isMoving?.() && canClosePolygon({kind: "Polygon", coordinates: state.clicks}, event.point,
        coordinate => map.project(coordinate), SNAP_TOLERANCE_PIXELS,
        {width: mapContainer.clientWidth, height: mapContainer.clientHeight})) {
        finishDraw();
        return;
      }
      const snapped = snappedPosition(rawPosition, drawingHole && state.selectedFeature
        ? {featureId: state.selectedFeature.id, featureOnly: true}
        : null);
      state.clicks.push(snapped.position);
      state.history = commitDraftHistory(state.history, {
        kind: drawingHole ? "hole" : drawingPart ? "part" : "draw",
        clicks: structuredClone(state.clicks),
        ...(drawingHole ? {
          geometry: structuredClone(state.holeBaseGeometry),
          featureId: state.selectedFeature ? String(state.selectedFeature.id) : null
        } : drawingPart ? {
          geometry: structuredClone(state.partBaseGeometry),
          featureId: state.selectedFeature ? String(state.selectedFeature.id) : null
        } : {})
      });
      updateHistoryControls();
      if (
        (!drawingHole && !drawingPart && ["Point", "MultiPoint"].includes(collection.geometryType))
        || (drawingPart && collection.geometryType === "MultiPoint")
      ) finishDraw();
      else {
        status.textContent = `${state.clicks.length} ${drawingHole ? "hole " : drawingPart ? "part " : ""}vertices captured${snapped.kind ? ` · snapped to ${snapped.kind}` : ""}. Finish when the geometry is complete.`;
        syncMap(map, displayFeatures, state);
      }
      return;
    }
    if (state.mode === "select") {
      const hit = map.queryRenderedFeatures(event.point, {layers: FEATURE_LAYERS})[0];
      const feature = hit ? displayFeatures.get(String(hit.id)) : null;
      if (feature) selectExisting(feature, rawPosition);
      else status.textContent = "No governed feature was found at that location.";
      return;
    }
    if (state.mode === "insert" && state.selectedFeature) {
      const hit = map.queryRenderedFeatures(event.point, {layers: [SEGMENT_HIT_LAYER]})[0];
      const partIndex = Number(hit?.properties?.partIndex ?? 0);
      const ringIndex = Number(hit?.properties?.ringIndex ?? 0);
      const startVertexIndex = Number(hit?.properties?.startVertexIndex);
      if (
        !Number.isInteger(partIndex)
        || !Number.isInteger(ringIndex)
        || !Number.isInteger(startVertexIndex)
      ) {
        status.textContent = "No editable segment was found at that location.";
        return;
      }
      try {
        const segment = selectedGeometrySegment(
          state.selectedGeometry,
          startVertexIndex,
          ringIndex,
          partIndex
        );
        const closest = closestPointOnPixelSegment(
          validPixel(event.point),
          validPixel(map.project(segment.start)),
          validPixel(map.project(segment.end))
        );
        const location = map.unproject([closest.pixel.x, closest.pixel.y]);
        const geometry = insertGeometryVertex(
          state.selectedGeometry,
          startVertexIndex,
          roundedPosition([location.lng, location.lat]),
          ringIndex,
          partIndex
        );
        state.selectedPartIndex = partIndex;
        stageCompletedGeometry(
          geometry,
          state.selectedGeometry,
          "vertex-insert",
          `Inserted a vertex in component ${partIndex + 1}, ring ${ringIndex + 1}.`
        );
      } catch (error) {
        status.textContent = `That vertex insertion is not valid: ${error.message}`;
      }
      return;
    }
    if (["delete", "split", "ring-delete"].includes(state.mode) && state.selectedFeature) {
      const hit = map.queryRenderedFeatures(event.point, {layers: [VERTEX_HIT_LAYER]})[0];
      const vertexIndex = Number(hit?.properties?.vertexIndex);
      const ringIndex = Number(hit?.properties?.ringIndex ?? 0);
      const partIndex = Number(hit?.properties?.partIndex ?? 0);
      if (
        !Number.isInteger(vertexIndex)
        || !Number.isInteger(ringIndex)
        || !Number.isInteger(partIndex)
      ) {
        status.textContent = "No editable vertex was found at that location.";
        return;
      }
      if (state.mode === "split") {
        splitSelectedLinePart({partIndex, vertexIndex});
      } else if (state.mode === "ring-delete") {
        deleteSelectedRing({partIndex, ringIndex});
      } else {
        deleteSelectedVertex({partIndex, ringIndex, vertexIndex});
      }
      return;
    }
    if (state.mode !== "move" || !state.selectedFeature) return;
    if (state.selectedVertex === null) {
      const hit = map.queryRenderedFeatures(event.point, {layers: [VERTEX_HIT_LAYER]})[0];
      const index = Number(hit?.properties?.vertexIndex);
      const ringIndex = Number(hit?.properties?.ringIndex ?? 0);
      const partIndex = Number(hit?.properties?.partIndex ?? 0);
      if (!Number.isInteger(index) || !Number.isInteger(ringIndex) || !Number.isInteger(partIndex)) {
        status.textContent = "Click one of the highlighted vertex handles first.";
        return;
      }
      state.selectedPartIndex = partIndex;
      state.selectedVertex = {partIndex, ringIndex, vertexIndex: index};
      updatePartTargetControl();
      status.textContent = `Part ${partIndex + 1}, ring ${ringIndex + 1}, vertex ${index + 1} selected. Click its new location.`;
      return;
    }
    const snapped = snappedPosition(rawPosition, {
      featureId: state.selectedFeature.id,
      partIndex: state.selectedVertex.partIndex,
      ringIndex: state.selectedVertex.ringIndex,
      vertexIndex: state.selectedVertex.vertexIndex
    });
    try {
      state.selectedGeometry = replaceGeometryVertex(
        state.selectedGeometry,
        state.selectedVertex.vertexIndex,
        snapped.position,
        state.selectedVertex.ringIndex,
        state.selectedVertex.partIndex
      );
    } catch (error) {
      status.textContent = `That vertex move is not valid: ${error.message}`;
      return;
    }
    state.history = commitDraftHistory(state.history, {
      kind: "selected",
      featureId: String(state.selectedFeature.id),
      geometry: structuredClone(state.selectedGeometry)
    });
    displayFeatures.set(state.selectedFeature.id, {
      ...state.selectedFeature,
      geometry: structuredClone(state.selectedGeometry)
    });
    onGeometryChange(structuredClone(state.selectedGeometry));
    state.selectedVertex = null;
    status.textContent = `Vertex moved${snapped.kind ? ` and snapped to ${snapped.kind}` : ""} in the draft. Save the version-checked form to persist it.`;
    updateHistoryControls();
    syncMap(map, displayFeatures, state);
  }

  function beginVertexDrag(event) {
    if (state.mode !== "move" || !state.selectedFeature || state.dragSession) return;
    if (activeTouchCount(event) > 1) {
      status.textContent = "Use one touch contact to drag a vertex; two-finger map gestures remain separate.";
      return;
    }
    const hit = event.features?.[0];
    const vertexIndex = Number(hit?.properties?.vertexIndex);
    const ringIndex = Number(hit?.properties?.ringIndex ?? 0);
    const partIndex = Number(hit?.properties?.partIndex ?? 0);
    if (!Number.isInteger(vertexIndex) || !Number.isInteger(ringIndex) || !Number.isInteger(partIndex)) return;
    try {
      state.dragSession = createVertexDragSession(
        state.selectedGeometry,
        vertexIndex,
        ringIndex,
        partIndex
      );
    } catch (error) {
      status.textContent = `That vertex cannot be dragged: ${error.message}`;
      return;
    }
    event.preventDefault?.();
    if (event.originalEvent?.cancelable) event.originalEvent.preventDefault();
    state.selectedPartIndex = partIndex;
    state.selectedVertex = {partIndex, ringIndex, vertexIndex};
    updatePartTargetControl();
    state.dragStartPixel = validPixel(event.point);
    state.dragActivated = false;
    state.dragRejected = false;
    state.suppressClickUntil = Date.now() + 250;
    suspendMapGestures();
    map.getCanvas().style.cursor = "grabbing";
    status.textContent = `Dragging part ${partIndex + 1}, ring ${ringIndex + 1}, vertex ${vertexIndex + 1}. Release to create one undoable draft change; press Escape to cancel.`;
  }

  function previewActiveVertexDrag(event) {
    if (!state.dragSession || !event?.lngLat) return false;
    if (activeTouchCount(event) > 1) {
      cancelActiveVertexDrag({announce: false});
      status.textContent = "Vertex drag canceled when a second touch contact was detected.";
      return false;
    }
    if (!state.dragActivated) {
      if (!event.point) return false;
      if (!dragActivationExceeded(state.dragStartPixel, event.point)) return false;
      state.dragActivated = true;
    }
    event.preventDefault?.();
    if (event.originalEvent?.cancelable) event.originalEvent.preventDefault();
    const selected = state.selectedVertex;
    const rawPosition = roundedPosition([event.lngLat.lng, event.lngLat.lat]);
    const snapped = snappedPosition(rawPosition, {
      featureId: state.selectedFeature.id,
      partIndex: selected.partIndex,
      ringIndex: selected.ringIndex,
      vertexIndex: selected.vertexIndex
    });
    try {
      state.dragSession = previewVertexDrag(state.dragSession, snapped.position);
    } catch (error) {
      state.dragRejected = true;
      status.textContent = `Drag preview rejected safely: ${error.message}. Return to a valid location or press Escape.`;
      return false;
    }
    state.dragRejected = false;
    state.selectedGeometry = structuredClone(state.dragSession.geometry);
    displayFeatures.set(state.selectedFeature.id, {
      ...state.selectedFeature,
      geometry: structuredClone(state.selectedGeometry)
    });
    status.textContent = `Previewing part ${selected.partIndex + 1}, ring ${selected.ringIndex + 1}, vertex ${selected.vertexIndex + 1}${snapped.kind ? ` · snapped to ${snapped.kind}` : ""}. Release to accept.`;
    syncMap(map, displayFeatures, state);
    return true;
  }

  function finishActiveVertexDrag(event) {
    if (!state.dragSession) return;
    if (state.dragActivated && event?.lngLat && event.type !== "touchend") {
      previewActiveVertexDrag(event);
    }
    state.suppressClickUntil = Date.now() + 250;
    if (state.dragRejected) {
      cancelActiveVertexDrag({announce: false});
      status.textContent = "The drag ended at an invalid location, so no draft change was made.";
      return;
    }
    const session = state.dragSession;
    restoreMapGestures();
    state.dragSession = null;
    state.dragStartPixel = null;
    state.dragActivated = false;
    map.getCanvas().style.cursor = "grab";
    if (!session.changed) {
      status.textContent = `Part ${session.partIndex + 1}, ring ${session.ringIndex + 1}, vertex ${session.vertexIndex + 1} selected. Click its new location or drag it.`;
      return;
    }
    state.history = commitVertexDragHistory(
      state.history,
      session,
      String(state.selectedFeature.id)
    );
    state.selectedGeometry = structuredClone(session.geometry);
    displayFeatures.set(state.selectedFeature.id, {
      ...state.selectedFeature,
      geometry: structuredClone(state.selectedGeometry)
    });
    onGeometryChange(structuredClone(state.selectedGeometry));
    state.selectedVertex = null;
    status.textContent = "Vertex drag added as one draft edit. Save the version-checked form to persist it.";
    updateHistoryControls();
    syncMap(map, displayFeatures, state);
  }

  function cancelActiveVertexDrag({announce = true} = {}) {
    if (!state.dragSession) {
      restoreMapGestures();
      return;
    }
    const original = structuredClone(state.dragSession.originalGeometry);
    state.selectedGeometry = original;
    if (state.selectedFeature) {
      displayFeatures.set(state.selectedFeature.id, {
        ...state.selectedFeature,
        geometry: structuredClone(original)
      });
    }
    state.dragSession = null;
    state.dragStartPixel = null;
    state.dragActivated = false;
    state.dragRejected = false;
    state.selectedVertex = null;
    state.suppressClickUntil = Date.now() + 250;
    restoreMapGestures();
    map.getCanvas().style.cursor = state.mode === "move" ? "grab" : "";
    if (announce) status.textContent = "Vertex drag canceled. The draft was restored.";
    syncMap(map, displayFeatures, state);
  }

  function suspendMapGestures() {
    if (state.gestureRestore) return;
    state.gestureRestore = {};
    for (const name of ["dragPan", "touchZoomRotate"]) {
      const handler = map[name];
      const enabled = Boolean(handler?.isEnabled?.());
      state.gestureRestore[name] = enabled;
      if (enabled) handler.disable();
    }
  }

  function restoreMapGestures() {
    if (!state.gestureRestore) return;
    for (const [name, enabled] of Object.entries(state.gestureRestore)) {
      if (enabled) map[name]?.enable?.();
    }
    state.gestureRestore = null;
  }

  function activeTouchCount(event) {
    if (Array.isArray(event?.points)) return event.points.length;
    return Number(event?.originalEvent?.touches?.length ?? 0);
  }

  function snappedPosition(position, excluded = null) {
    const result = snapToGeometry(
      position,
      [...displayFeatures.values()].filter((feature) => !(
        excluded?.featureOnly && String(feature.id) === String(excluded.featureId)
      )).map((feature) => ({
        id: feature.id,
        geometry: feature.geometry
      })),
      (coordinates) => map.project(coordinates),
      (pixel) => {
        const coordinates = map.unproject([pixel.x, pixel.y]);
        return [coordinates.lng, coordinates.lat];
      },
      {
        mode: state.snapMode,
        tolerancePixels: SNAP_TOLERANCE_PIXELS,
        excludedFeatureId: excluded?.featureId ?? null,
        excludedPartIndex: excluded?.partIndex ?? 0,
        excludedRingIndex: excluded?.ringIndex ?? 0,
        excludedVertexIndex: excluded?.vertexIndex ?? null
      }
    );
    return result === null
      ? {position, kind: null}
      : {position: roundedPosition(result.position), kind: result.kind};
  }

  function finishDraw() {
    if (state.mode === "hole") {
      finishHole();
      return;
    }
    if (state.mode === "part") {
      finishPart();
      return;
    }
    let geometry;
    try {
      geometry = geometryFromCanvasClicks(collection.geometryType, state.clicks);
    } catch (error) {
      status.textContent = `The geometry is not valid: ${error.message}`;
      return;
    }
    if (!geometry) {
      status.textContent = componentGeometryType(collection.geometryType) === "Polygon"
        ? "A polygon part needs at least three vertices."
        : componentGeometryType(collection.geometryType) === "LineString"
          ? "A line part needs at least two vertices."
          : "A point part needs one position.";
      return;
    }
    state.draftGeometry = geometry;
    state.mode = "inspect";
    onGeometryChange(structuredClone(geometry));
    status.textContent = "Geometry captured in the form. Complete the fields, then save.";
    state.history = createDraftHistory({kind: "idle"});
    updatePartTargetControl();
    updateHistoryControls();
    syncMap(map, displayFeatures, state);
  }

  function moveSelectedPart(offset) {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    const targetIndex = state.selectedPartIndex + offset;
    try {
      if (!geometry?.type?.startsWith("Multi")) throw new TypeError("multipart draft unavailable");
      const count = geometryPartCount(geometry);
      if (targetIndex < 0 || targetIndex >= count) {
        status.textContent = `Component ${state.selectedPartIndex + 1} is already at that end of the multipart order.`;
        return;
      }
      const changed = reorderGeometryPart(geometry, state.selectedPartIndex, targetIndex);
      const priorIndex = state.selectedPartIndex;
      state.selectedPartIndex = targetIndex;
      stageCompletedGeometry(
        changed,
        geometry,
        "part-reorder",
        `Moved multipart component ${priorIndex + 1} to position ${targetIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `That component cannot be reordered: ${error.message}`;
    }
  }

  function deleteSelectedPart() {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    try {
      const removedIndex = state.selectedPartIndex;
      const changed = removeGeometryPart(geometry, removedIndex);
      state.selectedPartIndex = Math.min(removedIndex, geometryPartCount(changed) - 1);
      stageCompletedGeometry(
        changed,
        geometry,
        "part-delete",
        `Removed multipart component ${removedIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `That component cannot be removed: ${error.message}`;
    }
  }

  function mergeSelectedLinePart() {
    cancelActiveVertexDrag({announce: false});
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    try {
      if (geometry?.type !== "MultiLineString") {
        throw new TypeError("multiline draft unavailable");
      }
      const candidates = touchingLinePartCandidates(geometry, state.selectedPartIndex);
      if (candidates.length !== 1) {
        throw new TypeError(
          candidates.length
            ? "the selected component touches more than one component; choose an unambiguous pair"
            : "the selected component does not share an endpoint with another component"
        );
      }
      const otherPartIndex = candidates[0];
      const changed = mergeTouchingLineParts(
        geometry,
        state.selectedPartIndex,
        otherPartIndex
      );
      const mergedPartIndex = Math.min(state.selectedPartIndex, otherPartIndex);
      state.selectedPartIndex = mergedPartIndex;
      stageCompletedGeometry(
        changed,
        geometry,
        "part-merge",
        `Merged touching line components into component ${mergedPartIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `Those line components cannot be merged: ${error.message}`;
    }
  }

  function splitSelectedLinePart({partIndex, vertexIndex}) {
    cancelActiveVertexDrag({announce: false});
    try {
      const before = state.selectedGeometry;
      const changed = splitMultiLinePart(before, partIndex, vertexIndex);
      state.selectedPartIndex = partIndex + 1;
      stageCompletedGeometry(
        changed,
        before,
        "part-split",
        `Split line component ${partIndex + 1} at vertex ${vertexIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `That line component cannot be split: ${error.message}`;
    }
  }

  function deleteSelectedRing({partIndex, ringIndex}) {
    cancelActiveVertexDrag({announce: false});
    try {
      const before = state.selectedGeometry;
      const changed = removePolygonRing(before, ringIndex, partIndex);
      state.selectedPartIndex = partIndex;
      stageCompletedGeometry(
        changed,
        before,
        "ring-delete",
        `Removed interior ring ${ringIndex} from polygon component ${partIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `That polygon ring cannot be removed: ${error.message}`;
    }
  }

  function deleteSelectedVertex({partIndex, ringIndex, vertexIndex}) {
    cancelActiveVertexDrag({announce: false});
    try {
      const before = state.selectedGeometry;
      const changed = removeGeometryVertex(before, vertexIndex, ringIndex, partIndex);
      state.selectedPartIndex = Math.min(partIndex, geometryPartCount(changed) - 1);
      stageCompletedGeometry(
        changed,
        before,
        before.type === "MultiPoint" ? "part-delete" : "vertex-delete",
        before.type === "MultiPoint"
          ? `Removed point component ${partIndex + 1}.`
          : `Removed vertex ${vertexIndex + 1} from component ${partIndex + 1}, ring ${ringIndex + 1}.`
      );
    } catch (error) {
      status.textContent = `That vertex cannot be removed: ${error.message}`;
    }
  }

  function finishPart() {
    let geometry;
    try {
      geometry = addGeometryPart(state.partBaseGeometry, state.clicks);
    } catch (error) {
      status.textContent = `The new part is not valid: ${error.message}`;
      return;
    }
    state.selectedPartIndex = geometryPartCount(geometry) - 1;
    stageCompletedGeometry(
      geometry,
      state.partBaseGeometry,
      "part",
      `Multipart geometry part ${state.selectedPartIndex + 1} added to the draft.`
    );
  }

  function finishHole() {
    let geometry;
    try {
      geometry = addPolygonHole(
        state.holeBaseGeometry,
        state.clicks,
        state.selectedPartIndex
      );
    } catch (error) {
      status.textContent = `The hole is not valid: ${error.message}`;
      return;
    }
    stageCompletedGeometry(
      geometry,
      state.holeBaseGeometry,
      "hole",
      `Polygon hole added to part ${state.selectedPartIndex + 1} of the draft.`
    );
  }

  function stageCompletedGeometry(geometry, beforeGeometry, operation, message) {
    const featureId = state.selectedFeature ? String(state.selectedFeature.id) : null;
    const before = {
      kind: "geometry",
      featureId,
      operation,
      geometry: structuredClone(beforeGeometry)
    };
    if (state.selectedFeature) {
      state.selectedGeometry = structuredClone(geometry);
      displayFeatures.set(state.selectedFeature.id, {
        ...state.selectedFeature,
        geometry: structuredClone(geometry)
      });
    } else {
      state.draftGeometry = structuredClone(geometry);
    }
    state.mode = "inspect";
    state.clicks = [];
    state.holeBaseGeometry = null;
    state.partBaseGeometry = null;
    state.selectedVertex = null;
    state.history = commitDraftHistory(createDraftHistory(before), {
      kind: "geometry",
      featureId,
      operation,
      geometry: structuredClone(geometry)
    });
    onGeometryChange(structuredClone(geometry));
    status.textContent = `${message} Save the version-checked form to persist it.`;
    updatePartTargetControl();
    updateHistoryControls();
    syncMap(map, displayFeatures, state);
  }

  function selectExisting(feature, position = null) {
    cancelActiveVertexDrag({announce: false});
    state.mode = "inspect";
    state.selectedFeature = feature;
    state.selectedGeometry = structuredClone(feature.geometry);
    state.selectedVertex = null;
    state.selectedPartIndex = feature.geometry?.type?.startsWith("Multi") && position
      ? geometryPartAtPosition(
          feature.geometry,
          position,
          (coordinates) => map.project(coordinates)
        ) ?? 0
      : 0;
    state.holeBaseGeometry = null;
    state.partBaseGeometry = null;
    state.history = createDraftHistory({
      kind: "selected",
      featureId: String(feature.id),
      geometry: structuredClone(feature.geometry)
    });
    updateHistoryControls();
    updatePartTargetControl();
    onSelectFeature(feature);
    status.textContent = `Selected ${feature.id} at v${feature.version}${feature.geometry?.type?.startsWith("Multi") ? ` · component ${state.selectedPartIndex + 1}` : ""}.`;
    syncMap(map, displayFeatures, state);
  }

  function resetCanvas(geometry) {
    cancelActiveVertexDrag({announce: false});
    state.mode = "inspect";
    state.clicks = [];
    state.draftGeometry = structuredClone(geometry);
    state.selectedFeature = null;
    state.selectedGeometry = null;
    state.selectedVertex = null;
    state.selectedPartIndex = 0;
    state.holeBaseGeometry = null;
    state.partBaseGeometry = null;
    state.history = createDraftHistory({kind: "idle"});
    updateHistoryControls();
    updatePartTargetControl();
    status.textContent = "Canvas edit cancelled. The form is ready for a new feature.";
    syncMap(map, displayFeatures, state);
  }

  function moveThroughHistory(direction) {
    cancelActiveVertexDrag({announce: false});
    const next = direction === "undo"
      ? undoDraftHistory(state.history)
      : redoDraftHistory(state.history);
    if (next === state.history) {
      status.textContent = `There is no draft edit to ${direction}.`;
      return;
    }
    state.history = next;
    const snapshot = structuredClone(state.history.present);
    if (snapshot.kind === "draw") {
      state.mode = "draw";
      state.clicks = snapshot.clicks.map(validPosition);
      state.holeBaseGeometry = null;
      state.partBaseGeometry = null;
      state.selectedVertex = null;
      status.textContent = `${direction === "undo" ? "Undid" : "Redid"} a draft vertex · ${state.clicks.length} captured.`;
    } else if (snapshot.kind === "hole") {
      state.mode = "hole";
      state.clicks = snapshot.clicks.map(validPosition);
      state.holeBaseGeometry = structuredClone(snapshot.geometry);
      state.partBaseGeometry = null;
      state.selectedVertex = null;
      status.textContent = `${direction === "undo" ? "Undid" : "Redid"} a hole vertex · ${state.clicks.length} captured.`;
    } else if (snapshot.kind === "part") {
      state.mode = "part";
      state.clicks = snapshot.clicks.map(validPosition);
      state.holeBaseGeometry = null;
      state.partBaseGeometry = structuredClone(snapshot.geometry);
      state.selectedVertex = null;
      status.textContent = `${direction === "undo" ? "Undid" : "Redid"} a part vertex · ${state.clicks.length} captured.`;
    } else if (
      snapshot.kind === "geometry"
      && (
        (snapshot.featureId === null && !state.selectedFeature)
        || snapshot.featureId === String(state.selectedFeature?.id)
      )
    ) {
      state.mode = "inspect";
      state.clicks = [];
      state.holeBaseGeometry = null;
      state.partBaseGeometry = null;
      state.selectedVertex = null;
      if (state.selectedFeature) {
        state.selectedGeometry = structuredClone(snapshot.geometry);
        displayFeatures.set(state.selectedFeature.id, {
          ...state.selectedFeature,
          geometry: structuredClone(snapshot.geometry)
        });
      } else {
        state.draftGeometry = structuredClone(snapshot.geometry);
      }
      onGeometryChange(structuredClone(snapshot.geometry));
      state.selectedPartIndex = Math.min(
        state.selectedPartIndex,
        geometryPartCount(snapshot.geometry) - 1
      );
      status.textContent = `${direction === "undo" ? "Undid" : "Redid"} a ${geometryOperationLabel(snapshot.operation)} in the draft.`;
    } else if (
      snapshot.kind === "selected"
      && state.selectedFeature
      && snapshot.featureId === String(state.selectedFeature.id)
    ) {
      state.selectedGeometry = structuredClone(snapshot.geometry);
      displayFeatures.set(state.selectedFeature.id, {
        ...state.selectedFeature,
        geometry: structuredClone(state.selectedGeometry)
      });
      onGeometryChange(structuredClone(state.selectedGeometry));
      state.selectedVertex = null;
      status.textContent = `${direction === "undo" ? "Undid" : "Redid"} a vertex move in the draft.`;
    } else {
      state.history = createDraftHistory({kind: "idle"});
      status.textContent = "The prior draft history no longer matches this edit.";
    }
    updateHistoryControls();
    updatePartTargetControl();
    syncMap(map, displayFeatures, state);
  }

  function updateHistoryControls() {
    undo.disabled = state.history.past.length === 0;
    redo.disabled = state.history.future.length === 0;
  }

  function updatePartTargetControl() {
    if (!targetPart) return;
    const geometry = state.selectedGeometry ?? state.draftGeometry;
    if (!geometry?.type?.startsWith("Multi")) {
      targetPart.disabled = true;
      targetPart.textContent = "Part —";
      partEarlier.disabled = true;
      partLater.disabled = true;
      removePart.disabled = true;
      if (splitPart) splitPart.disabled = true;
      if (mergePart) mergePart.disabled = true;
      return;
    }
    let count;
    try {
      count = geometryPartCount(geometry);
    } catch {
      targetPart.disabled = true;
      targetPart.textContent = "Part invalid";
      partEarlier.disabled = true;
      partLater.disabled = true;
      removePart.disabled = true;
      if (splitPart) splitPart.disabled = true;
      if (mergePart) mergePart.disabled = true;
      return;
    }
    state.selectedPartIndex = Math.min(state.selectedPartIndex, count - 1);
    targetPart.disabled = false;
    targetPart.textContent = `Part ${state.selectedPartIndex + 1}/${count}`;
    targetPart.title = "Choose the multipart component used by structure commands";
    partEarlier.disabled = state.selectedPartIndex === 0;
    partLater.disabled = state.selectedPartIndex === count - 1;
    removePart.disabled = count === 1;
    if (splitPart) {
      splitPart.disabled = geometry.coordinates[state.selectedPartIndex].length < 3;
      splitPart.title = splitPart.disabled
        ? "This line component needs an interior vertex before it can split"
        : "Split this line component at an interior vertex";
    }
    if (mergePart) mergePart.disabled = count < 2;
  }
}

function addSourcesAndLayers(map) {
  map.addSource(FEATURE_SOURCE, {type: "geojson", data: featureCollection([])});
  map.addSource(DRAFT_SOURCE, {type: "geojson", data: featureCollection([])});
  map.addSource(VERTEX_SOURCE, {type: "geojson", data: featureCollection([])});
  map.addSource(SEGMENT_SOURCE, {type: "geojson", data: featureCollection([])});
  map.addLayer({
    id: "opengeo-feature-fill",
    type: "fill",
    source: FEATURE_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {"fill-color": "#42b7a8", "fill-opacity": 0.28}
  });
  map.addLayer({
    id: "opengeo-feature-line",
    type: "line",
    source: FEATURE_SOURCE,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {"line-color": "#7ee3d3", "line-width": 4}
  });
  map.addLayer({
    id: "opengeo-feature-point",
    type: "circle",
    source: FEATURE_SOURCE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": "#7ee3d3",
      "circle-radius": 7,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2
    }
  });
  map.addLayer({
    id: "opengeo-feature-draft-fill",
    type: "fill",
    source: DRAFT_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {"fill-color": "#f5b642", "fill-opacity": 0.32}
  });
  map.addLayer({
    id: "opengeo-feature-draft-line",
    type: "line",
    source: DRAFT_SOURCE,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {"line-color": "#f5b642", "line-width": 4, "line-dasharray": [1.5, 1.5]}
  });
  map.addLayer({
    id: "opengeo-feature-draft-point",
    type: "circle",
    source: DRAFT_SOURCE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {"circle-color": "#f5b642", "circle-radius": 7}
  });
  map.addLayer({
    id: SEGMENT_HIT_LAYER,
    type: "line",
    source: SEGMENT_SOURCE,
    paint: {
      "line-color": "#f5b642",
      "line-width": 12,
      "line-opacity": 0.48,
      "line-dasharray": [0.5, 1]
    }
  });
  map.addLayer({
    id: VERTEX_HIT_LAYER,
    type: "circle",
    source: VERTEX_SOURCE,
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": VERTEX_DRAG_HIT_DIAMETER / 2,
      "circle-opacity": 0
    }
  });
  map.addLayer({
    id: "opengeo-feature-vertex",
    type: "circle",
    source: VERTEX_SOURCE,
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": 6,
      "circle-stroke-color": "#b44c16",
      "circle-stroke-width": 3
    }
  });
}

function syncMap(map, displayFeatures, state) {
  if (!state.loaded) return;
  source(map, FEATURE_SOURCE).setData(featureCollection([...displayFeatures.values()].map(
    (feature) => ({
      type: "Feature",
      id: feature.id,
      geometry: feature.geometry,
      properties: {...feature.properties, "opengeo:version": feature.version}
    })
  )));
  const drafts = draftPreviews(state);
  source(map, DRAFT_SOURCE).setData(featureCollection(drafts.map((geometry) => ({
    type: "Feature", geometry, properties: {}
  }))));
  const segments = state.mode === "insert" && state.selectedGeometry
    ? geometrySegments(state.selectedGeometry)
    : [];
  source(map, SEGMENT_SOURCE).setData(featureCollection(segments.map((segment, index) => ({
    type: "Feature",
    id: index,
    geometry: {type: "LineString", coordinates: [segment.start, segment.end]},
    properties: {
      partIndex: segment.partIndex,
      ringIndex: segment.ringIndex,
      startVertexIndex: segment.startVertexIndex
    }
  }))));
  const capturing = ["draw", "hole", "part"].includes(state.mode);
  const capturePartIndex = state.mode === "part"
    ? geometryPartCount(state.partBaseGeometry)
    : state.mode === "hole" ? state.selectedPartIndex : 0;
  const vertexHandles = capturing
    ? state.clicks.map((coordinates, vertexIndex) => ({
        coordinates,
        partIndex: capturePartIndex,
        ringIndex: 0,
        vertexIndex
      }))
    : state.selectedGeometry ? geometryVertexHandles(state.selectedGeometry) : [];
  source(map, VERTEX_SOURCE).setData(featureCollection(vertexHandles.map(
    ({coordinates, partIndex, ringIndex, vertexIndex}) => ({
        type: "Feature",
        geometry: {type: "Point", coordinates},
        properties: {partIndex, ringIndex, vertexIndex}
      })
  )));
}

function draftPreviews(state) {
  if (state.mode === "hole" || state.mode === "part") {
    const baseGeometry = state.mode === "hole" ? state.holeBaseGeometry : state.partBaseGeometry;
    const base = state.selectedFeature ? [] : [baseGeometry];
    const preview = clickPreview(componentGeometryType(state.geometryType), state.clicks);
    return [...base, ...(preview ? [preview] : [])].filter(Boolean);
  }
  if (state.mode !== "draw") return state.selectedFeature || !state.draftGeometry
    ? []
    : [state.draftGeometry];
  const preview = clickPreview(componentGeometryType(state.geometryType), state.clicks);
  return preview ? [preview] : [];
}

function clickPreview(geometryType, clicks) {
  if (!clicks.length) return null;
  if (clicks.length === 1) return {type: "Point", coordinates: clicks[0]};
  if (geometryType === "LineString" || clicks.length === 2) {
    return {type: "LineString", coordinates: clicks};
  }
  return {type: "Polygon", coordinates: [[...clicks, clicks[0]]]};
}

function componentGeometryType(geometryType) {
  return {
    Point: "Point",
    MultiPoint: "Point",
    LineString: "LineString",
    MultiLineString: "LineString",
    Polygon: "Polygon",
    MultiPolygon: "Polygon"
  }[geometryType] ?? null;
}

function drawInstruction(geometryType) {
  const component = componentGeometryType(geometryType);
  if (component === "Point") return geometryType === "MultiPoint"
    ? "Click the first point; use Add part for more points."
    : "Click the new point location.";
  if (component === "LineString") return geometryType === "MultiLineString"
    ? "Click the first line's vertices, choose Finish geometry, then use Add part for more lines."
    : "Click each line vertex, then choose Finish geometry.";
  return geometryType === "MultiPolygon"
    ? "Click the first polygon shell, choose Finish geometry, then use Add part or Add hole."
    : "Click each polygon vertex, then choose Finish geometry.";
}

function partInstruction(geometryType) {
  const component = componentGeometryType(geometryType);
  if (component === "Point") return "Click the new point part.";
  if (component === "LineString") {
    return "Click at least two vertices for the new line part, then choose Finish geometry.";
  }
  return "Click at least three vertices for the new polygon part, then choose Finish geometry.";
}

function geometryOperationLabel(operation) {
  return {
    part: "multipart addition",
    hole: "polygon hole",
    "part-reorder": "multipart reorder",
    "part-delete": "multipart deletion",
    "part-split": "line-part split",
    "part-merge": "line-part merge",
    "ring-delete": "polygon-hole removal",
    "vertex-insert": "vertex insertion",
    "vertex-delete": "vertex deletion"
  }[operation] ?? "geometry change";
}

function fitFeatureBounds(map, features) {
  const values = features.flatMap((feature) => feature.bbox ?? []);
  if (!values.length) return;
  const west = Math.min(...features.map((feature) => feature.bbox[0]));
  const south = Math.min(...features.map((feature) => feature.bbox[1]));
  const east = Math.max(...features.map((feature) => feature.bbox[2]));
  const north = Math.max(...features.map((feature) => feature.bbox[3]));
  const padded = west === east || south === north
    ? [[west - 0.01, south - 0.01], [east + 0.01, north + 0.01]]
    : [[west, south], [east, north]];
  map.fitBounds(padded, {padding: 40, maxZoom: 15, duration: 0});
}

function initialCenter(features) {
  if (!features.length) return [0, 0];
  const west = Math.min(...features.map((feature) => feature.bbox[0]));
  const south = Math.min(...features.map((feature) => feature.bbox[1]));
  const east = Math.max(...features.map((feature) => feature.bbox[2]));
  const north = Math.max(...features.map((feature) => feature.bbox[3]));
  return [(west + east) / 2, (south + north) / 2];
}

function closestPointOnPixelSegment(target, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
  const fraction = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (
      ((target.x - start.x) * deltaX) + ((target.y - start.y) * deltaY)
    ) / lengthSquared));
  const pixel = {
    x: start.x + (fraction * deltaX),
    y: start.y + (fraction * deltaY)
  };
  return {
    pixel,
    distancePixels: Math.hypot(pixel.x - target.x, pixel.y - target.y)
  };
}

function selectedGeometrySegment(geometry, startVertexIndex, ringIndex, partIndex) {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw new RangeError("part index is outside the geometry");
  }
  if (!Number.isInteger(ringIndex) || ringIndex < 0) {
    throw new RangeError("ring index is outside the geometry");
  }
  if (!Number.isInteger(startVertexIndex) || startVertexIndex < 0) {
    throw new RangeError("segment index is outside the geometry");
  }
  const segment = geometrySegments(geometry).find((candidate) => (
    candidate.partIndex === partIndex
    && candidate.ringIndex === ringIndex
    && candidate.startVertexIndex === startVertexIndex
  ));
  if (!segment) throw new RangeError("segment index is outside the geometry");
  return segment;
}

function pixelSegmentIntersection(first, second) {
  const firstDelta = {
    x: first.endPixel.x - first.startPixel.x,
    y: first.endPixel.y - first.startPixel.y
  };
  const secondDelta = {
    x: second.endPixel.x - second.startPixel.x,
    y: second.endPixel.y - second.startPixel.y
  };
  const denominator = cross(firstDelta, secondDelta);
  if (Math.abs(denominator) <= 1e-9) return null;
  const offset = {
    x: second.startPixel.x - first.startPixel.x,
    y: second.startPixel.y - first.startPixel.y
  };
  const firstFraction = cross(offset, secondDelta) / denominator;
  const secondFraction = cross(offset, firstDelta) / denominator;
  const endpointEpsilon = 1e-9;
  if (
    firstFraction <= endpointEpsilon
    || firstFraction >= 1 - endpointEpsilon
    || secondFraction <= endpointEpsilon
    || secondFraction >= 1 - endpointEpsilon
  ) return null;
  return {
    x: first.startPixel.x + (firstFraction * firstDelta.x),
    y: first.startPixel.y + (firstFraction * firstDelta.y)
  };
}

function cross(first, second) {
  return (first.x * second.y) - (first.y * second.x);
}

function inverseProjectedPosition(unproject, pixel) {
  const value = unproject({x: pixel.x, y: pixel.y});
  if (Array.isArray(value)) return validPosition(value);
  if (value !== null && typeof value === "object") {
    if (Number.isFinite(value.lng) && Number.isFinite(value.lat)) {
      return validPosition([value.lng, value.lat]);
    }
    if (Number.isFinite(value.longitude) && Number.isFinite(value.latitude)) {
      return validPosition([value.longitude, value.latitude]);
    }
  }
  throw new TypeError("invalid inverse projected snap position");
}

function publicSnapResult(result) {
  return result === null ? null : {
    kind: result.kind,
    position: [...result.position],
    distancePixels: result.distancePixels
  };
}

function validDraftHistory(history) {
  if (
    history === null
    || typeof history !== "object"
    || !Number.isInteger(history.limit)
    || history.limit < 1
    || history.limit > 100
    || !Array.isArray(history.past)
    || !Array.isArray(history.future)
    || !Object.hasOwn(history, "present")
    || history.past.length > history.limit
    || history.future.length > history.limit
  ) throw new TypeError("draft history is invalid");
  return history;
}

function validVertexDragSession(session) {
  if (
    session === null
    || typeof session !== "object"
    || !Number.isInteger(session.partIndex)
    || session.partIndex < 0
    || !Number.isInteger(session.ringIndex)
    || session.ringIndex < 0
    || !Number.isInteger(session.vertexIndex)
    || session.vertexIndex < 0
    || typeof session.changed !== "boolean"
  ) throw new TypeError("vertex drag session is invalid");
  const originalPosition = validPosition(session.originalPosition);
  const originalHandle = geometryVertexHandles(session.originalGeometry).find((candidate) => (
    candidate.partIndex === session.partIndex
    && candidate.ringIndex === session.ringIndex
    && candidate.vertexIndex === session.vertexIndex
  ));
  const previewHandle = geometryVertexHandles(session.geometry).find((candidate) => (
    candidate.partIndex === session.partIndex
    && candidate.ringIndex === session.ringIndex
    && candidate.vertexIndex === session.vertexIndex
  ));
  if (
    !originalHandle
    || !previewHandle
    || !samePosition(originalHandle.coordinates, originalPosition)
    || session.changed === samePosition(previewHandle.coordinates, originalPosition)
  ) throw new TypeError("vertex drag session is invalid");
  return session;
}

function validPosition(value) {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    || value[0] < -180
    || value[0] > 180
    || value[1] < -90
    || value[1] > 90
  ) throw new TypeError("invalid WGS84 position");
  return [value[0], value[1]];
}

function roundedPosition(value) {
  return validPosition(value).map((coordinate) => Number(coordinate.toFixed(7)));
}

function validPixel(value) {
  if (
    value === null
    || typeof value !== "object"
    || !Number.isFinite(value.x)
    || !Number.isFinite(value.y)
  ) throw new TypeError("invalid projected snap position");
  return {x: value.x, y: value.y};
}

function samePosition(first, second) {
  return first[0] === second[0] && first[1] === second[1];
}

function joinedLineParts(first, second) {
  const left = first.map(validPosition);
  const right = second.map(validPosition);
  const reversedLeft = [...left].reverse();
  const reversedRight = [...right].reverse();
  const joins = [];
  if (samePosition(left.at(-1), right[0])) joins.push([...left, ...right.slice(1)]);
  if (samePosition(left.at(-1), right.at(-1))) joins.push([...left, ...reversedRight.slice(1)]);
  if (samePosition(left[0], right.at(-1))) joins.push([...right, ...left.slice(1)]);
  if (samePosition(left[0], right[0])) joins.push([...reversedRight, ...left.slice(1)]);
  return joins.map((part) => part.map((position) => [...position]));
}

function touchingLinePartCandidates(geometry, partIndex) {
  if (geometry?.type !== "MultiLineString") {
    throw new TypeError("only MultiLineString geometry has touching line parts");
  }
  const parts = validMultiLineParts(geometry);
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) {
    throw new RangeError("part index is outside the geometry");
  }
  return parts.flatMap((part, index) => (
    index !== partIndex && joinedLineParts(parts[partIndex], part).length === 1 ? [index] : []
  ));
}

function defaultProject([x, y]) {
  return {x, y};
}

function validateMultipartGeometry(geometry) {
  if (geometry?.type === "MultiPoint") validMultiPointPositions(geometry);
  else if (geometry?.type === "MultiLineString") validMultiLineParts(geometry);
  else if (geometry?.type === "MultiPolygon") validateMultiPolygonGeometry(geometry);
  else throw new TypeError("invalid multipart geometry");
  return true;
}

function validMultiPointPositions(geometry) {
  if (
    geometry?.type !== "MultiPoint"
    || !Array.isArray(geometry.coordinates)
    || !geometry.coordinates.length
    || geometry.coordinates.length > MAX_MULTI_PARTS
  ) throw new TypeError("invalid multipoint");
  return geometry.coordinates.map(validPosition);
}

function validMultiLineParts(geometry) {
  if (
    geometry?.type !== "MultiLineString"
    || !Array.isArray(geometry.coordinates)
    || !geometry.coordinates.length
    || geometry.coordinates.length > MAX_MULTI_PARTS
  ) throw new TypeError("invalid multilinestring");
  const parts = geometry.coordinates.map((part, partIndex) => {
    if (!Array.isArray(part) || part.length < 2 || part.length > MAX_RING_VERTICES) {
      throw new TypeError(`line part ${partIndex} must contain 2 to ${MAX_RING_VERTICES} vertices`);
    }
    return part.map(validPosition);
  });
  if (parts.reduce((total, part) => total + part.length, 0) > MAX_GEOMETRY_POSITIONS) {
    throw new RangeError(`multipart geometry may contain at most ${MAX_GEOMETRY_POSITIONS} positions`);
  }
  return parts;
}

function validClosedMultiPolygonParts(geometry) {
  if (
    geometry?.type !== "MultiPolygon"
    || !Array.isArray(geometry.coordinates)
    || !geometry.coordinates.length
    || geometry.coordinates.length > MAX_MULTI_PARTS
  ) throw new TypeError("invalid multipolygon");
  const parts = geometry.coordinates.map((coordinates) => validClosedPolygonRings({
    type: "Polygon",
    coordinates
  }));
  const positionCount = parts.reduce((total, rings) => (
    total + rings.reduce((partTotal, ring) => partTotal + ring.length - 1, 0)
  ), 0);
  if (positionCount > MAX_GEOMETRY_POSITIONS) {
    throw new RangeError(`multipart geometry may contain at most ${MAX_GEOMETRY_POSITIONS} positions`);
  }
  return parts;
}

function openLineSegments(coordinates, partIndex) {
  return coordinates.slice(0, -1).map((start, index) => ({
    start: [...start],
    end: [...coordinates[index + 1]],
    partIndex,
    ringIndex: 0,
    startVertexIndex: index,
    endVertexIndex: index + 1
  }));
}

function validClosedPolygonRings(geometry) {
  if (
    geometry?.type !== "Polygon"
    || !Array.isArray(geometry.coordinates)
    || !geometry.coordinates.length
    || geometry.coordinates.length > MAX_POLYGON_RINGS
  ) throw new TypeError("invalid polygon");
  return geometry.coordinates.map((ring, ringIndex) => validClosedRing(ring, ringIndex));
}

function validClosedRing(value, ringIndex) {
  if (!Array.isArray(value) || value.length < 4 || value.length > MAX_RING_VERTICES + 1) {
    throw new TypeError(`polygon ring ${ringIndex} must contain 3 to ${MAX_RING_VERTICES} vertices`);
  }
  const ring = value.map(validPosition);
  if (!samePosition(ring[0], ring.at(-1))) {
    throw new TypeError(`polygon ring ${ringIndex} must be closed`);
  }
  return ring;
}

function validSimpleRing(value, ringIndex) {
  const ring = validClosedRing(value, ringIndex);
  const vertices = ring.slice(0, -1);
  for (let index = 0; index < vertices.length; index += 1) {
    if (samePosition(vertices[index], ring[index + 1])) {
      throw new TypeError(`polygon ring ${ringIndex} contains a zero-length edge`);
    }
  }
  const twiceArea = vertices.reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + (position[0] * next[1]) - (next[0] * position[1]);
  }, 0);
  if (Math.abs(twiceArea) <= TOPOLOGY_EPSILON) {
    throw new TypeError(`polygon ring ${ringIndex} has no area`);
  }
  const segments = ringSegments(ring);
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
      const adjacent = secondIndex === firstIndex + 1
        || (firstIndex === 0 && secondIndex === segments.length - 1);
      if (!adjacent && segmentsIntersect(segments[firstIndex], segments[secondIndex])) {
        throw new TypeError(`polygon ring ${ringIndex} crosses or touches itself`);
      }
    }
  }
  return ring;
}

function ringSegments(ring) {
  return ring.slice(0, -1).map((start, index) => ({start, end: ring[index + 1]}));
}

function ringsIntersect(first, second) {
  return ringSegments(first).some((firstSegment) => ringSegments(second).some(
    (secondSegment) => segmentsIntersect(firstSegment, secondSegment)
  ));
}

function segmentsIntersect(first, second) {
  const firstStart = orientation(first.start, first.end, second.start);
  const firstEnd = orientation(first.start, first.end, second.end);
  const secondStart = orientation(second.start, second.end, first.start);
  const secondEnd = orientation(second.start, second.end, first.end);
  if (
    Math.sign(firstStart) !== Math.sign(firstEnd)
    && Math.sign(secondStart) !== Math.sign(secondEnd)
    && Math.abs(firstStart) > TOPOLOGY_EPSILON
    && Math.abs(firstEnd) > TOPOLOGY_EPSILON
    && Math.abs(secondStart) > TOPOLOGY_EPSILON
    && Math.abs(secondEnd) > TOPOLOGY_EPSILON
  ) return true;
  return (
    (Math.abs(firstStart) <= TOPOLOGY_EPSILON && positionOnSegment(second.start, first))
    || (Math.abs(firstEnd) <= TOPOLOGY_EPSILON && positionOnSegment(second.end, first))
    || (Math.abs(secondStart) <= TOPOLOGY_EPSILON && positionOnSegment(first.start, second))
    || (Math.abs(secondEnd) <= TOPOLOGY_EPSILON && positionOnSegment(first.end, second))
  );
}

function orientation(start, end, position) {
  return ((end[0] - start[0]) * (position[1] - start[1]))
    - ((end[1] - start[1]) * (position[0] - start[0]));
}

function positionOnSegment(position, segment) {
  return position[0] >= Math.min(segment.start[0], segment.end[0]) - TOPOLOGY_EPSILON
    && position[0] <= Math.max(segment.start[0], segment.end[0]) + TOPOLOGY_EPSILON
    && position[1] >= Math.min(segment.start[1], segment.end[1]) - TOPOLOGY_EPSILON
    && position[1] <= Math.max(segment.start[1], segment.end[1]) + TOPOLOGY_EPSILON;
}

function pointInRingStrict(position, ring) {
  if (pointOnRingBoundary(position, ring)) return false;
  let inside = false;
  for (let index = 0, prior = ring.length - 2; index < ring.length - 1; prior = index, index += 1) {
    const current = ring[index];
    const previous = ring[prior];
    const crosses = (current[1] > position[1]) !== (previous[1] > position[1]);
    if (
      crosses
      && position[0] < (
        ((previous[0] - current[0]) * (position[1] - current[1]))
        / (previous[1] - current[1])
      ) + current[0]
    ) inside = !inside;
  }
  return inside;
}

function pointInPolygonStrict(position, rings) {
  return pointInRingStrict(position, rings[0])
    && !rings.slice(1).some((hole) => (
      pointInRingStrict(position, hole) || pointOnRingBoundary(position, hole)
    ));
}

function pointOnRingBoundary(position, ring) {
  return ringSegments(ring).some((segment) => (
    Math.abs(orientation(segment.start, segment.end, position)) <= TOPOLOGY_EPSILON
    && positionOnSegment(position, segment)
  ));
}

function featureCollection(features) {
  return {type: "FeatureCollection", features};
}

function source(map, id) {
  return map.getSource(id);
}

function button(label) {
  const control = text("button", label, "platform-button secondary");
  control.type = "button";
  return control;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
