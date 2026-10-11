/** Numeric JsonLogic subset. Strict bounded numbers; never eval or external work. */
export function validateCalculation(expression, numericFields) {
  let count = 0;
  const visit = (node, depth) => {
    if (++count > 64 || depth > 8) throw new Error("Calculation exceeds 64 nodes or depth 8.");
    if (typeof node === "number") {
      if (!Number.isFinite(node) || Math.abs(node) > Number.MAX_SAFE_INTEGER) {
        throw new Error("Calculation constant is out of range.");
      }
      return node;
    }
    if (!node || Array.isArray(node) || typeof node !== "object" || Object.keys(node).length !== 1) {
      throw new Error("Calculation requires numeric JsonLogic expressions.");
    }
    const [operator, operands] = Object.entries(node)[0];
    if (operator === "var") {
      if (typeof operands !== "string" || !numericFields.has(operands)) {
        throw new Error("Calculation must reference an earlier numeric field.");
      }
      return {[operator]: operands};
    }
    if (!["+", "-", "*", "/", "min", "max"].includes(operator)) throw new Error("Unsupported calculation operator.");
    if (!Array.isArray(operands) || operands.length < 1 || operands.length > 16) {
      throw new Error("Calculation requires 1 to 16 operands.");
    }
    if (operator === "/" && operands.length !== 2) throw new Error("Division requires two operands.");
    if (operator === "-" && operands.length > 2) throw new Error("Subtraction requires one or two operands.");
    return {[operator]: operands.map(operand => visit(operand, depth + 1))};
  };
  return visit(expression, 0);
}

export function evaluateCalculation(expression, values) {
  if (typeof expression === "number") return expression;
  const [operator, operands] = Object.entries(expression)[0];
  if (operator === "var") {
    const value = values.get(operands);
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error("Calculation input is not a bounded number.");
    }
    return value;
  }
  const numbers = operands.map(operand => evaluateCalculation(operand, values));
  if (numbers.some(value => value === null)) return null;
  let result = numbers[0];
  if (operator === "+") result = numbers.slice(1).reduce((a, b) => a + b, result);
  if (operator === "*") result = numbers.slice(1).reduce((a, b) => a * b, result);
  if (operator === "-") result = numbers.length === 1 ? -result : result - numbers[1];
  if (operator === "/") {
    if (numbers[1] === 0) throw new Error("Calculation divides by zero.");
    result /= numbers[1];
  }
  if (operator === "min") result = Math.min(...numbers);
  if (operator === "max") result = Math.max(...numbers);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw new Error("Calculation result is out of range.");
  return result;
}
