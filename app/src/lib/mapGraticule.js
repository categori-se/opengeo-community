// A bounded latitude/longitude grid that remains useful at street and world scales.
export function mapGraticule(bounds = [-180, -80, 180, 80]) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds.some(value => Math.abs(value) > 1e7)) return mapGraticule();
  let [west, south, east, north] = bounds;
  const span = east - west;
  const width = Math.min(360, Math.max(0.000001, span < 0 ? ((span % 360) + 360) % 360 : span));
  west = ((west + 180) % 360 + 360) % 360 - 180;
  east = west + width;
  [south, north] = [south, north].map(lat => Math.max(-85, Math.min(85, lat))).sort((a, b) => a - b);
  const target = Math.max(width, north - south) / 8;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= target);
  const features = [];
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  for (let lon = Math.ceil(west / step) * step; lon <= east + step / 100; lon += step) {
    features.push({type: "Feature", properties: {kind: "meridian", value: wrap(lon)}, geometry: {type: "LineString", coordinates: [[wrap(lon), south], [wrap(lon), north]]}});
  }
  for (let lat = Math.ceil(south / step) * step; lat <= north + step / 100; lat += step) {
    // Split at the date line so a short visible parallel never crosses the whole map.
    const intervals = east > 180 ? [[west, 180], [-180, east - 360]] : [[west, east]];
    for (const [start, end] of intervals) {
      const segments = Math.max(1, Math.ceil((end - start) / 5));
      const coordinates = Array.from({length: segments + 1}, (_, i) => [start + (end - start) * i / segments, lat]);
      features.push({type: "Feature", properties: {kind: "parallel", value: lat}, geometry: {type: "LineString", coordinates}});
    }
  }
  return {type: "FeatureCollection", features};
}
