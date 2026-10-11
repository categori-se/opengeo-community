import assert from 'node:assert/strict';

// MVT polygon rings have opposite winding for holes. Keep larger visible areas
// when an overview exceeds its budget, without changing any retained geometry.
function area(feature) {
  let twiceArea = 0;
  for (const ring of feature.loadGeometry()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      twiceArea += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    }
  }
  return Math.abs(twiceArea);
}

export function fitOverviewTile(features, {zoom, fullDetailZoom, maximumFeatures, maximumBytes, encode, maximumDecodedBytes, decodedSize}) {
  assert.ok(features.length > 0);
  if(maximumDecodedBytes!==undefined)assert.ok(Number.isSafeInteger(maximumDecodedBytes)&&maximumDecodedBytes>0&&typeof decodedSize==='function');
  const fits=bytes=>bytes.length<=maximumBytes&&(maximumDecodedBytes===undefined||decodedSize(bytes)<=maximumDecodedBytes);
  const fullDetail = zoom === fullDetailZoom;
  if (fullDetail) assert.ok(features.length <= maximumFeatures, 'Full-detail feature budget exceeded');
  let selected = features;
  let bytes = features.length <= maximumFeatures ? encode(selected) : null;
  if (bytes && fits(bytes)) return {features: selected, bytes, omitted: 0};
  assert.ok(!fullDetail, 'Full-detail byte budget exceeded; never thin full-detail tiles');
  const ranked = features.map((feature, index) => ({index, area: area(feature), id: feature.id}));
  ranked.sort((a, b) => b.area - a.area || a.id - b.id || a.index - b.index);
  let count = Math.min(maximumFeatures, features.length);
  for (;;) {
    const indices = ranked.slice(0, count).map(row => row.index).sort((a, b) => a - b);
    selected = indices.map(index => features[index]);
    bytes = encode(selected);
    if (fits(bytes)) return {features: selected, bytes, omitted: features.length - selected.length};
    assert.ok(count > 1, 'One overview feature exceeds byte budget');
    count = Math.max(1, Math.floor(count * 0.75));
  }
}
