import json
import math
from decimal import Decimal
from typing import Any


def canonical_json_bytes(value: Any) -> bytes:
    """Return deterministic JSON with code-point key order and plain-decimal numbers."""
    return _canonical_json(value).encode("utf-8")


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical JSON numbers must be finite")
        if value == 0:
            return "0"
        rendered = format(Decimal(repr(value)), "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return rendered
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("canonical JSON object keys must be strings")
        return (
            "{"
            + ",".join(
                f"{_canonical_json(key)}:{_canonical_json(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    raise TypeError("value is not JSON serializable")
