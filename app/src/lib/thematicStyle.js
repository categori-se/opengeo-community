const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const UNSAFE_FIELD_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export const DEFAULT_GRADUATED_BREAKS = Object.freeze([20, 40, 60, 80]);

// Viridis is perceptually ordered and remains distinguishable for common
// forms of color-vision deficiency.
export const DEFAULT_GRADUATED_COLORS = Object.freeze([
  "#440154",
  "#3b528b",
  "#21918c",
  "#5ec962",
  "#fde725"
]);

export const DEFAULT_GRADUATED_NO_DATA_COLOR = "#9ca3af";
export const DEFAULT_GRADUATED_NO_DATA_LABEL = "No data";

/**
 * Return fields that can be classified numerically without coercion.
 * Missing and null values are treated as no-data. A field is omitted when any
 * of its populated values is non-numeric or non-finite.
 */
export function numericPropertyFields(geojson) {
  if (geojson === null || geojson === undefined) return [];
  if (!isRecord(geojson) || !Array.isArray(geojson.features)) {
    throw new TypeError("graduated style GeoJSON must contain a features array");
  }

  const fields = new Map();
  for (const feature of geojson.features) {
    if (!isRecord(feature)) {
      throw new TypeError("graduated style features must be objects");
    }
    if (!("properties" in feature)) {
      throw new TypeError("graduated style feature properties must be objects or null");
    }
    const properties = feature.properties;
    if (properties === null) continue;
    if (!isRecord(properties)) {
      throw new TypeError("graduated style feature properties must be objects or null");
    }

    for (const [field, value] of Object.entries(properties)) {
      if (!isSafeThematicFieldName(field)) continue;
      const state = fields.get(field) ?? {hasNumber: false, valid: true};
      if (value === null || value === undefined) {
        fields.set(field, state);
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        state.valid = false;
      } else {
        state.hasNumber = true;
      }
      fields.set(field, state);
    }
  }

  return [...fields.entries()]
    .filter(([, state]) => state.valid && state.hasNumber)
    .map(([field]) => field)
    .sort((left, right) => left.localeCompare(right));
}

export function isSafeThematicFieldName(value) {
  if (typeof value !== "string" || !FIELD_NAME.test(value)) return false;
  return !value
    .toLowerCase()
    .split(/[.:-]/)
    .some((segment) => UNSAFE_FIELD_SEGMENTS.has(segment));
}

/**
 * Normalize the persisted five-bin renderer contract. Breaks are inclusive
 * lower bounds for bins two through five and must be strictly increasing.
 */
export function normalizeGraduatedStyle(value) {
  if (!isRecord(value)) throw new TypeError("graduated style must be an object");

  const field = value.field;
  if (!isSafeThematicFieldName(field)) {
    throw new TypeError("graduated style field is invalid");
  }

  const breaks = value.breaks === undefined
    ? [...DEFAULT_GRADUATED_BREAKS]
    : normalizeBreaks(value.breaks);
  const colors = value.colors === undefined
    ? [...DEFAULT_GRADUATED_COLORS]
    : normalizeColors(value.colors);
  const noDataColor = normalizeColor(
    value.noDataColor ?? DEFAULT_GRADUATED_NO_DATA_COLOR,
    "graduated style no-data color"
  );
  const noDataLabel = value.noDataLabel ?? DEFAULT_GRADUATED_NO_DATA_LABEL;
  if (typeof noDataLabel !== "string" || noDataLabel.trim().length < 1 || noDataLabel.trim().length > 100) {
    throw new TypeError("graduated style no-data label is invalid");
  }

  return {
    field,
    breaks,
    colors,
    noDataColor,
    noDataLabel: noDataLabel.trim()
  };
}

/**
 * Produce a MapLibre expression with an explicit no-data branch. Numeric
 * strings are deliberately not coerced into data values.
 */
export function graduatedColorExpression(style, fallback = undefined) {
  const normalized = normalizeGraduatedStyle(style);
  const noDataColor = fallback === undefined
    ? normalized.noDataColor
    : normalizeColor(fallback, "graduated style fallback color");
  const [first, second, third, fourth, fifth] = normalized.colors;
  const [breakOne, breakTwo, breakThree, breakFour] = normalized.breaks;

  return [
    "case",
    [
      "all",
      ["has", normalized.field],
      ["==", ["typeof", ["get", normalized.field]], "number"]
    ],
    [
      "step",
      ["get", normalized.field],
      first,
      breakOne,
      second,
      breakTwo,
      third,
      breakThree,
      fourth,
      breakFour,
      fifth
    ],
    noDataColor
  ];
}

/**
 * Return ordered legend rows matching MapLibre step-expression semantics,
 * followed by a separate no-data row.
 */
export function graduatedLegendEntries(style) {
  const normalized = normalizeGraduatedStyle(style);
  const entries = normalized.colors.map((color, index) => {
    const minimum = index === 0 ? null : normalized.breaks[index - 1];
    const maximum = index === normalized.colors.length - 1 ? null : normalized.breaks[index];
    return {
      kind: "range",
      color,
      label: rangeLabel(minimum, maximum),
      minimum,
      maximum
    };
  });
  entries.push({
    kind: "no-data",
    color: normalized.noDataColor,
    label: normalized.noDataLabel,
    minimum: null,
    maximum: null
  });
  return entries;
}

function normalizeBreaks(value) {
  if (!Array.isArray(value) || value.length !== DEFAULT_GRADUATED_BREAKS.length) {
    throw new TypeError("graduated style requires four breaks");
  }
  const breaks = value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new TypeError("graduated style breaks must be finite numbers");
    }
    return Object.is(item, -0) ? 0 : item;
  });
  if (breaks.some((item, index) => index > 0 && item <= breaks[index - 1])) {
    throw new TypeError("graduated style breaks must be strictly increasing");
  }
  return breaks;
}

function normalizeColors(value) {
  if (!Array.isArray(value) || value.length !== DEFAULT_GRADUATED_COLORS.length) {
    throw new TypeError("graduated style requires five colors");
  }
  return value.map((item) => normalizeColor(item, "graduated style color"));
}

function normalizeColor(value, label) {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function rangeLabel(minimum, maximum) {
  if (minimum === null) return `< ${formatBreak(maximum)}`;
  if (maximum === null) return `\u2265 ${formatBreak(minimum)}`;
  return `${formatBreak(minimum)} \u2013 < ${formatBreak(maximum)}`;
}

function formatBreak(value) {
  return String(Object.is(value, -0) ? 0 : value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
