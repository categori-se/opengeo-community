/** Evaluate a normalized immutable field rule; missing controllers stay hidden. */
export function featureFieldVisible(condition, values) {
  if (condition == null) return true;
  const actual = values.get(condition.field);
  if (actual == null) return false;
  const expected = condition.value_field ? values.get(condition.value_field) : condition.equals;
  if (expected == null) return false;
  switch (condition.operator ?? "eq") {
    case "eq": return actual === expected;
    case "ne": return actual !== expected;
    case "gt": return typeof actual === "number" && actual > expected;
    case "gte": return typeof actual === "number" && actual >= expected;
    case "lt": return typeof actual === "number" && actual < expected;
    case "lte": return typeof actual === "number" && actual <= expected;
    default: return false;
  }
}
