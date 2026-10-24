import {isSafeThematicFieldName} from "./thematicStyle.js";

const color = value => typeof value === "string" && /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value);
const opaqueColor = value => typeof value === "string" && /^#[a-f\d]{6}$/i.test(value);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

// A closed, renderer-independent description of one linear sRGB color scale.
// Numeric strings and missing values remain outside its numeric domain.
export function normalizeContinuousScale(scale) {
  if (!closed(scale, ["field", "stops", "noDataColor"]) || !isSafeThematicFieldName(scale.field)
    || !color(scale.noDataColor) || !Array.isArray(scale.stops) || scale.stops.length < 2 || scale.stops.length > 22
    || !scale.stops.every((stop, index, stops) => closed(stop, ["value", "color"])
      && typeof stop.value === "number" && Number.isFinite(stop.value) && Math.abs(stop.value) <= 1e15
      && (index === 0 || stop.value > stops[index - 1].value) && opaqueColor(stop.color))) {
    throw Error("Invalid continuous color scale. Choose 2–22 increasing finite stops and opaque colors.");
  }
  return {field: scale.field, stops: scale.stops.map(stop => ({value: stop.value, color: stop.color})), noDataColor: scale.noDataColor};
}

export function continuousColorExpression(scale) {
  const normalized = normalizeContinuousScale(scale);
  return ["case", ["==", ["typeof", ["get", normalized.field]], "number"],
    ["interpolate", ["linear"], ["get", normalized.field], ...normalized.stops.flatMap(stop => [stop.value, stop.color])],
    normalized.noDataColor];
}

export function parseContinuousColorExpression(value) {
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== "case") return null;
  const guard = value[1], interpolation = value[2], field = guard?.[1]?.[1]?.[1];
  if (!Array.isArray(guard) || guard.length !== 3 || guard[0] !== "==" || guard[2] !== "number"
    || !Array.isArray(guard[1]) || guard[1].length !== 2 || guard[1][0] !== "typeof"
    || !Array.isArray(guard[1][1]) || guard[1][1].length !== 2 || guard[1][1][0] !== "get"
    || !Array.isArray(interpolation) || interpolation.length < 7 || interpolation.length > 47 || interpolation.length % 2 !== 1
    || interpolation[0] !== "interpolate" || !Array.isArray(interpolation[1]) || interpolation[1].length !== 1 || interpolation[1][0] !== "linear"
    || !Array.isArray(interpolation[2]) || interpolation[2].length !== 2 || interpolation[2][0] !== "get" || interpolation[2][1] !== field) return null;
  const stops = [];
  for (let index = 3; index < interpolation.length; index += 2) stops.push({value: interpolation[index], color: interpolation[index + 1]});
  try {return normalizeContinuousScale({field, stops, noDataColor: value[3]});} catch {return null;}
}

// Detached geometry passes reuse the same pinned Style identity and save path.
export function continuousStyleDefinition(preset, field, title) {
  if (!closed(preset, ["geometry", "stops", "opacity", "outlineColor", "outlineWidth", "nullColor"])
    || !["fill", "line"].includes(preset.geometry) || !color(preset.outlineColor)
    || typeof preset.opacity !== "number" || !Number.isFinite(preset.opacity) || preset.opacity < 0 || preset.opacity > 1
    || typeof preset.outlineWidth !== "number" || !Number.isFinite(preset.outlineWidth) || preset.outlineWidth < 0 || preset.outlineWidth > 8
    || typeof title !== "string" || !title.trim() || title.length > 300) throw Error("Invalid continuous Style.");
  const paintColor = continuousColorExpression({field, stops: preset.stops, noDataColor: preset.nullColor});
  const layers = preset.geometry === "line"
    ? [{id: "boundaries", type: "line", paint: {"line-color": paintColor, "line-width": preset.outlineWidth, "line-opacity": preset.opacity}}]
    : [{id: "areas", type: "fill", paint: {"fill-color": paintColor, "fill-opacity": preset.opacity, "fill-outline-color": preset.outlineColor}},
      {id: "boundaries", type: "line", paint: {"line-color": preset.outlineColor, "line-width": preset.outlineWidth, "line-opacity": preset.opacity}}];
  return JSON.stringify({version: 8, name: title.trim(), sources: {}, layers});
}
