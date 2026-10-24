import {normalizeContinuousScale} from "./continuousStyle.js";

export function continuousLegendRows(scale, title) {
  const normalized = normalizeContinuousScale(scale);
  const noData = {label: "Missing or nonnumeric", color: normalized.noDataColor};
  const note = "Linear interpolation; values outside the scale use its endpoint colors. Only numeric values use the scale. Scale colors are shown before map opacity and background blending.";
  return {rows: [
    ...normalized.stops.map(stop => ({label: `${title} · ${normalized.field} ${stop.value}`, color: stop.color})),
    {label: `${title} · ${noData.label}`, color: noData.color}, {label: note}
  ], noData, note};
}

// Shared by SVG and figure packs: expose only the bounded scale that actually
// matches its captured swatches, never arbitrary additions to a capture object.
export function continuousLegendGroups(capture) {
  const groups = capture.continuousLegends ?? [], result = new Map();
  if (!Array.isArray(groups) || groups.length > 20) throw Error("Invalid captured continuous legends.");
  const fields = ["start", "count", "layerId", "title", "field", "interpolation", "stops", "noData", "note"];
  let end = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)
      || Object.keys(group).length !== fields.length || !fields.every(key => Object.hasOwn(group, key))
      || !Number.isSafeInteger(group.start) || group.start < end || group.start < 0
      || !Number.isSafeInteger(group.count) || group.count < 4
      || !Array.isArray(capture.legend) || group.start + group.count > capture.legend.length
      || typeof group.layerId !== "string" || !group.layerId.length || group.layerId.length > 100
      || typeof group.title !== "string" || !group.title.length || group.title.length > 500
      || group.interpolation !== "linear" || !group.noData || typeof group.noData !== "object"
      || Array.isArray(group.noData) || Object.keys(group.noData).length !== 2
      || !Object.hasOwn(group.noData, "color") || !Object.hasOwn(group.noData, "label")) {
      throw Error("Invalid captured continuous legends.");
    }
    let scale;
    try {scale = normalizeContinuousScale({field: group.field, stops: group.stops, noDataColor: group.noData.color});}
    catch {throw Error("Invalid captured continuous scale.");}
    const expected = continuousLegendRows(scale, group.title);
    if (group.count !== expected.rows.length || group.note !== expected.note || group.noData.label !== expected.noData.label
      || expected.rows.some((row, index) => {
        const captured = capture.legend[group.start + index];
        return captured?.label !== row.label || captured?.color !== row.color;
      })) throw Error("The captured continuous scale differs from its legend.");
    const normalized = {start: group.start, count: group.count, layerId: group.layerId, title: group.title,
      field: scale.field, interpolation: "linear", stops: scale.stops, noData: expected.noData, note: expected.note};
    result.set(group.start, normalized);end = group.start + group.count;
  }
  return result;
}
