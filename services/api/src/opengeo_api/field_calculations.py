"""Bounded numeric JsonLogic syntax; strict numbers, no coercion or external calls."""

import math
from typing import Any

LIMIT = 9_007_199_254_740_991


def validate_calculation(expression: Any, numeric_fields: set[str]) -> Any:
    count = 0

    def visit(node: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if count > 64 or depth > 8:
            raise ValueError("calculation exceeds 64 nodes or depth 8")
        if type(node) in (int, float):
            if abs(node) > LIMIT or not math.isfinite(node):
                raise ValueError("calculation numeric constant is out of range")
            return node
        if not isinstance(node, dict) or len(node) != 1:
            raise ValueError("calculation requires numeric JsonLogic expressions")
        operator, operands = next(iter(node.items()))
        if operator == "var":
            if not isinstance(operands, str) or operands not in numeric_fields:
                raise ValueError("calculation must reference an earlier numeric field")
            return {operator: operands}
        if operator not in ("+", "-", "*", "/", "min", "max"):
            raise ValueError("unsupported calculation operator")
        if not isinstance(operands, list) or not 1 <= len(operands) <= 16:
            raise ValueError("calculation requires 1 to 16 operands")
        if operator == "/" and len(operands) != 2:
            raise ValueError("division requires two operands")
        if operator == "-" and len(operands) not in (1, 2):
            raise ValueError("subtraction requires one or two operands")
        return {operator: [visit(operand, depth + 1) for operand in operands]}

    return visit(expression, 0)


def evaluate_calculation(expression: Any, values: dict[str, Any]) -> float | None:
    """Evaluate a previously validated expression with IEEE-754 arithmetic."""
    if type(expression) in (int, float):
        return float(expression)
    operator, operands = next(iter(expression.items()))
    if operator == "var":
        value = values.get(operands)
        if value is None:
            return None
        if type(value) not in (int, float) or abs(value) > LIMIT or not math.isfinite(value):
            raise ValueError("calculation input is not a bounded number")
        return float(value)
    evaluated = [evaluate_calculation(operand, values) for operand in operands]
    if any(value is None for value in evaluated):
        return None
    numbers = [float(value) for value in evaluated if value is not None]
    result = numbers[0]
    if operator == "+":
        for value in numbers[1:]:
            result += value
    elif operator == "*":
        for value in numbers[1:]:
            result *= value
    elif operator == "-":
        result = -result if len(numbers) == 1 else result - numbers[1]
    elif operator == "/":
        if numbers[1] == 0:
            raise ValueError("calculation divides by zero")
        result /= numbers[1]
    elif operator == "min":
        result = min(numbers)
    elif operator == "max":
        result = max(numbers)
    if not math.isfinite(result) or abs(result) > LIMIT:
        raise ValueError("calculation result is out of range")
    return result
