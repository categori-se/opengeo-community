// Coordinates are screen pixels, ordered top-left, top-right, bottom-right,
// bottom-left. Geographic conversion belongs to the map, including its bearing.
export function fitImageOverlay(width, height, imageWidth, imageHeight) {
  if (![width, height, imageWidth, imageHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid image or viewport dimensions");
  }
  const scale = Math.min(width * 0.6 / imageWidth, height * 0.6 / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return [[-w, -h], [w, -h], [w, h], [-w, h]]
    .map(([x, y]) => [width / 2 + x / 2, height / 2 + y / 2]);
}

export function overlayHandlePoint(points, handle) {
  const corners = {nw: 0, ne: 1, se: 2, sw: 3};
  if (handle in corners) return [...points[corners[handle]]];
  const sides = {n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0]};
  if (handle in sides) return midpoint(...sides[handle].map((index) => points[index]));
  const center = midpoint(points[0], points[2]);
  if (handle === "rotate") {
    const top = midpoint(points[0], points[1]);
    const length = Math.hypot(top[0] - center[0], top[1] - center[1]) || 1;
    return top.map((value, axis) => value + (value - center[axis]) * 38 / length);
  }
  return center;
}

export function transformImageOverlay(points, handle, start, end, {lockAspect = false, snapRotation = false} = {}) {
  if (points.length !== 4 || ![...points, start, end].every((point) => point.length === 2 && point.every(Number.isFinite))) {
    throw new Error("Invalid overlay coordinates");
  }
  const delta = end.map((value, axis) => value - start[axis]);
  if (handle === "move") return points.map((point) => point.map((value, axis) => value + delta[axis]));
  const center = overlayHandlePoint(points, "move");
  if (handle === "rotate") {
    let angle = Math.atan2(end[1] - center[1], end[0] - center[0])
      - Math.atan2(start[1] - center[1], start[0] - center[0]);
    if (snapRotation) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
    return points.map(([x, y]) => [
      center[0] + (x - center[0]) * Math.cos(angle) - (y - center[1]) * Math.sin(angle),
      center[1] + (x - center[0]) * Math.sin(angle) + (y - center[1]) * Math.cos(angle)
    ]);
  }
  const opposite = {nw: "se", ne: "sw", se: "nw", sw: "ne", n: "s", s: "n", e: "w", w: "e"}[handle];
  if (!opposite) throw new Error("Unknown overlay handle");
  const anchor = overlayHandlePoint(points, opposite);
  const x = points[1].map((value, axis) => value - points[0][axis]);
  const y = points[3].map((value, axis) => value - points[0][axis]);
  const determinant = x[0] * y[1] - x[1] * y[0];
  if (Math.abs(determinant) < 1) throw new Error("Overlay is too small to resize");
  const local = (point) => {
    const dx = point[0] - anchor[0];
    const dy = point[1] - anchor[1];
    return [(dx * y[1] - dy * y[0]) / determinant, (dy * x[0] - dx * x[1]) / determinant];
  };
  const initial = local(overlayHandlePoint(points, handle));
  const target = local(overlayHandlePoint(points, handle).map((value, axis) => value + delta[axis]));
  let sx = /[ew]/.test(handle) ? clamp(target[0] / initial[0]) : 1;
  let sy = /[ns]/.test(handle) ? clamp(target[1] / initial[1]) : 1;
  if (lockAspect) {
    const scale = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = scale;
    sy = scale;
  }
  return points.map((point) => {
    const [u, v] = local(point);
    return [anchor[0] + x[0] * u * sx + y[0] * v * sy, anchor[1] + x[1] * u * sx + y[1] * v * sy];
  });
}

export function pointInImageOverlay(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x, y] = points[i];
    const [px, py] = points[j];
    if ((y > point[1]) !== (py > point[1]) && point[0] < (px - x) * (point[1] - y) / (py - y) + x) inside = !inside;
  }
  return inside;
}

const midpoint = (a, b) => a.map((value, axis) => (value + b[axis]) / 2);
const clamp = (value) => Math.max(0.05, Math.min(20, value));
