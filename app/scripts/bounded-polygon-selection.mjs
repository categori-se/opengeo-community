import assert from 'node:assert/strict';

export function polygonArea(geometry) {
  let area = 0;
  for (const ring of geometry) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return Math.abs(area);
}

// Retain the largest overview fragments in bounded memory, preserving source order
// in the result. Full-detail callers must reject overflow rather than use selection.
export class BoundedPolygonSelection {
  constructor(limit) { assert.ok(Number.isSafeInteger(limit) && limit > 0); this.limit = limit; this.heap = []; this.count = 0; }
  worse(a, b) { return a.area < b.area || (a.area === b.area && a.order > b.order); }
  add(feature) {
    const row = {feature, area: polygonArea(feature.loadGeometry()), order: this.count++};
    const h = this.heap;
    if (h.length < this.limit) {
      h.push(row); let i = h.length - 1;
      while (i) { const p = (i - 1) >> 1; if (!this.worse(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; }
    } else if (this.worse(h[0], row)) {
      h[0] = row; let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1; let next = i;
        if (left < h.length && this.worse(h[left], h[next])) next = left;
        if (right < h.length && this.worse(h[right], h[next])) next = right;
        if (next === i) break; [h[i], h[next]] = [h[next], h[i]]; i = next;
      }
    }
  }
  values() { return [...this.heap].sort((a, b) => a.order - b.order).map(row => row.feature); }
}
