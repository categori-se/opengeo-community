// Artifact JSON: code-point key order and finite plain-decimal numbers.
// Matches the API json_canonical contract; not a claim of RFC 8785 conformance.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number") return canonicalNumber(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  throw new TypeError("value is not JSON serializable");
}

function compareCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
  if (value === 0) return "0";
  const rendered = String(value).toLowerCase();
  if (!rendered.includes("e")) return rendered;
  const [coefficient, exponentText] = rendered.split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + Number(exponentText);
  const plain = decimalIndex <= 0
    ? `0.${"0".repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return negative ? `-${plain}` : plain;
}
