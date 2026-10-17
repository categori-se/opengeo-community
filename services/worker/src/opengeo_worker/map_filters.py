"""Bounded persisted MapLibre feature predicates; never evaluate provider data."""

import json
from typing import Any, cast


def validate_map_filter(value: list[Any] | None) -> list[Any] | None:
    if value is None:
        return value
    count = 0

    def field(v: object) -> bool:
        return (
            isinstance(v, list)
            and len(v) == 2
            and v[0] == "get"
            and isinstance(v[1], str)
            and 0 < len(v[1]) <= 128
        )

    def scalar(v: object) -> bool:
        return (
            v is None
            or type(v) is bool
            or (isinstance(v, str) and len(v) <= 1024)
            or (
                type(v) in (int, float)
                and -1.7976931348623157e308 <= cast(float, v) <= 1.7976931348623157e308
            )
        )

    def check(v: object, depth: int) -> None:
        nonlocal count
        count += 1
        if count > 64 or depth > 8 or not isinstance(v, list) or not v:
            raise ValueError("unsupported map filter")
        op, *args = v
        if op in ("all", "any") and 1 <= len(args) <= 16:
            for arg in args:
                check(arg, depth + 1)
        elif op == "!" and len(args) == 1:
            check(args[0], depth + 1)
        elif op == "in" and len(args) == 2 and field(args[0]):
            literal = args[1]
            if not (
                isinstance(literal, list)
                and len(literal) == 2
                and literal[0] == "literal"
                and isinstance(literal[1], list)
                and 1 <= len(literal[1]) <= 64
            ):
                raise ValueError("unsupported map filter")
            values = literal[1]
            kind = (
                "number"
                if type(values[0]) in (int, float)
                else "string"
                if isinstance(values[0], str)
                else None
            )
            if kind is None or not all(
                scalar(v) and (type(v) in (int, float) if kind == "number" else isinstance(v, str))
                for v in values
            ):
                raise ValueError("unsupported map filter")
        elif (op == "has" and len(args) == 1 and field(["get", args[0]])) or (
            op in ("==", "!=", "<", "<=", ">", ">=")
            and len(args) == 2
            and (field(args[0]) or field(["get", args[0]]))
            and scalar(args[1])
            and (op in ("==", "!=") or type(args[1]) in (str, int, float))
        ):
            pass
        else:
            raise ValueError("unsupported map filter")

    check(value, 0)
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) > 8192:
        raise ValueError("map filter too large")
    return value
