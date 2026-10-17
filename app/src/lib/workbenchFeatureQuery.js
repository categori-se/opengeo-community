/** Query draft lifecycle, typed inputs and selection readiness for Workbench controls. */
import {FEATURE_QUERY_LIMITS} from "./featureQuery.js";

export function featureQueryDraft(state, layer, fields, fieldTypes = new Map()) {
  if (state.queryDraft?.datasetId === layer.datasetId) return state.queryDraft;
  state.queryResult = null;
  state.queryError = null;
  state.querySelectedFeatureId = null;
  state.selectedFeatureIndex = null;
  state.queryDraft = {
    datasetId: layer.datasetId,
    expectedGeneration: Number.isSafeInteger(layer.featureGeneration) ? layer.featureGeneration : null,
    limit: FEATURE_QUERY_LIMITS.maximumResults,
    offset: 0,
    steps: fields.length ? [defaultAttributeQueryStep(fields[0], fieldTypes.get(fields[0]))] : []
  };
  return state.queryDraft;
}

export function defaultAttributeQueryStep(field, valueType = "string") {
  return {
    kind: "attribute",
    field,
    operator: valueType === "string" ? "contains" : "equals",
    value: valueType === "boolean" ? false : valueType === "string" ? "" : 0,
    case_sensitive: false,
    valueType
  };
}

export function queryGeometryLabel(geometry) {
  return ({
    MultiPoint: "multiple points",
    LineString: "line",
    Polygon: "polygon or box",
    MultiPolygon: "multipolygon",
    GeometryCollection: "copied result"
  })[geometry?.type] ?? "point";
}

export function queryGeometryDrawingKind(geometry) {
  if (["Point", "MultiPoint", "LineString"].includes(geometry?.type)
    || (geometry?.type === "Polygon" && geometry.coordinates?.length === 1)) {
    return geometry.type;
  }
  return null;
}

export function cancelFeatureQueryRequest(state) {
  state.queryRequestRevision += 1;
  state.queryAbortController?.abort();
  state.queryAbortController = null;
  state.queryRunning = false;
}

export function queryInputValue(value, type) {
  if (type === "boolean") return value === "true";
  if (["integer", "number"].includes(type)) return value === "" ? null : Number(value);
  return value;
}

export function queryOperatorOptions(valueType) {
  if (valueType === "string") {
    return [
      ["contains", "contains"],
      ["starts_with", "starts with"],
      ["equals", "equals"],
      ["not_equals", "does not equal"],
      ["is_null", "is empty"]
    ];
  }
  if (valueType === "boolean") {
    return [
      ["equals", "equals"],
      ["not_equals", "does not equal"],
      ["is_null", "is empty"]
    ];
  }
  return [
    ["equals", "equals"],
    ["not_equals", "does not equal"],
    ["greater_than", "greater than"],
    ["greater_than_or_equal", "greater than or equal"],
    ["less_than", "less than"],
    ["less_than_or_equal", "less than or equal"],
    ["is_null", "is empty"]
  ];
}

export function queryDraftReady(draft) {
  return draft.steps.length >= 1 && draft.steps.every((step) => {
    if (step.kind === "spatial") {
      return Number.isFinite(step.buffer_meters)
        && step.buffer_meters >= 0
        && step.buffer_meters <= FEATURE_QUERY_LIMITS.maximumBufferMeters;
    }
    return step.operator === "is_null" || (
      step.value !== null
      && step.value !== ""
      && (typeof step.value !== "number" || Number.isFinite(step.value))
    );
  });
}

export function inferredFieldType(geojson, field) {
  const value = (geojson?.features ?? [])
    .map((feature) => feature.properties?.[field])
    .find((candidate) => candidate !== null && candidate !== undefined);
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "string";
}
