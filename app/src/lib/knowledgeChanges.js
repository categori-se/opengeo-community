/** Compare retained JSON knowledge without treating null as missing or rewriting it. */
export function knowledgeChanges(before, after) {
  const changes = [];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === "object";
  function visit(left, right, path, hasLeft = true, hasRight = true) {
    if (!hasLeft || !hasRight) {
      changes.push({path: path || "/", kind: hasLeft ? "removed" : "added",
        ...(hasLeft ? {before: left} : {}), ...(hasRight ? {after: right} : {})});
      return;
    }
    if (Object.is(left, right)) return;
    if (object(left) && object(right) && Array.isArray(left) === Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        visit(left[key], right[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          own(left, key), own(right, key));
      }
    } else changes.push({path: path || "/", kind: "changed", before: left, after: right});
  }
  visit(before, after, "");
  return changes;
}
