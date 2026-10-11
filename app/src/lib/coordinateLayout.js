/** Describe retained GDAL declarations; never infer Z/M from ordinate count. */
export function declaredCoordinateLayouts(schema) {
  const layers = schema?.layers;
  if (!Array.isArray(layers) || !layers.length) return null;
  const layouts = new Set();
  for (const layer of layers) {
    const declared = layer?.coordinate_layouts;
    if (!Array.isArray(declared) || !declared.length
      || declared.some(value => !["XY", "XYZ", "XYM", "XYZM"].includes(value))) return null;
    for (const value of declared) layouts.add(value);
  }
  return [...layouts].sort().join(", ");
}

export function coordinateLayoutNotice(before, after) {
  const left = declaredCoordinateLayouts(before), right = declaredCoordinateLayouts(after);
  if (left === null || right === null) return "Coordinate layout is not established for both versions. Ordinate count alone does not distinguish elevation (Z) from measure (M).";
  if (left !== right) return `Declared coordinate layout changed from ${left} to ${right}. Review elevation (Z) and measure (M) preservation; declarations do not verify every coordinate.`;
  return "Coordinate layouts are recorded declarations; they do not verify every coordinate or preservation in derived displays.";
}
