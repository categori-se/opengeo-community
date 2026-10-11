"""Explicit immutable font identities; never resolve an authored URL or path."""

import re
from typing import Any

# Entries are reviewed packaged assets, not values supplied by a request. Keep
# historical identities when adding a new font edition so saved jobs stay exact.
RENDER_FONT_REGISTRY: dict[tuple[str, int], tuple[str, str]] = {
    ("opengeo-open-sans-v1", 1): (
        "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a",
        "OpenGeo Open Sans v1",
    )
}


def validate_render_font_reference(value: object) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"id", "version", "manifestChecksumSha256"}
        or not isinstance(value["id"], str)
        or re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value["id"]) is None
        or type(value["version"]) is not int
        or not 1 <= value["version"] <= 2_147_483_647
        or not isinstance(value["manifestChecksumSha256"], str)
        or re.fullmatch(r"[0-9a-f]{64}", value["manifestChecksumSha256"]) is None
    ):
        raise ValueError("fontRef must identify one exact versioned font manifest")


def resolve_render_font(value: dict[str, Any]) -> str:
    validate_render_font_reference(value)
    registered = RENDER_FONT_REGISTRY.get((value["id"], value["version"]))
    if registered is None or registered[0] != value["manifestChecksumSha256"]:
        raise ValueError("the exact saved font manifest is not installed")
    return registered[1]
