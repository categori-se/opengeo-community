// MVT cannot encode null values. Accept their omission only in an explicit review.
export function compareTileProperties(original, actual, {allowOmittedNulls = false} = {}) {
  const mismatches = [], omittedNulls = [];
  for (const key of new Set([...Object.keys(original), ...Object.keys(actual)])) {
    const sourceHas = Object.hasOwn(original, key), tileHas = Object.hasOwn(actual, key);
    if (sourceHas === tileHas && original[key] === actual[key]) continue;
    if (allowOmittedNulls && sourceHas && original[key] === null && !tileHas) omittedNulls.push(key);
    else mismatches.push(key);
  }
  return {mismatches, omittedNulls};
}
