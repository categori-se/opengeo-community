"""Read an exact package identity from a sealed renderer configuration."""

import re
from typing import Any

from opengeo_worker.models import ValidationFailure

PINNED_GL_RENDERER = "opengeo.maplibre-gl-js.v2"
RUNTIME_REFERENCE_SCHEMA = "opengeo.render-runtime-reference.1.0.0"


def runtime_reference(value: Any) -> dict[str, str]:
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "manifestSha256", "architecture"}
        or value["schemaVersion"] != RUNTIME_REFERENCE_SCHEMA
        or not isinstance(value["manifestSha256"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["manifestSha256"])
        or value["architecture"] not in ("x86_64", "aarch64")
    ):
        raise ValidationFailure("saved_map_gl_runtime_reference_invalid")
    return {key: value[key] for key in ("schemaVersion", "manifestSha256", "architecture")}


# Capabilities are attached to reviewed fixed-script bytes, not a mutable runtime name.
# Register a new script digest when a release changes its supported presentation.
PATTERN_SCRIPT_HASHES = frozenset(
    {"64ebcc4cdd1d6f863bff6a804bf829a22d84f7a88b8cde8d49018f60b15a47eb"}
)
LABEL_ORDER_SCRIPT_HASHES = PATTERN_SCRIPT_HASHES | frozenset(
    {"e3d902e4f43f6b02d213ed6a824242929ac8866549a6994e8c482840e18ab5e0"}
)


def require_render_capabilities(request: dict[str, Any], runtime: dict[str, Any]) -> None:
    if (
        any(
            occurrence["style"].get("metadata", {}).get("opengeo:patterns")
            for occurrence in request["occurrences"]
        )
        and runtime.get("scriptChecksumSha256") not in PATTERN_SCRIPT_HASHES
    ):
        raise ValidationFailure("saved_map_gl_pattern_runtime_unsupported")
    composite = any(
        key.endswith("-layer-opacity")
        for occurrence in request["occurrences"]
        for part in occurrence["style"]["layers"]
        for key in part.get("paint", {})
    )
    if composite and runtime.get("maplibreVersion") != "6.0.0":
        raise ValidationFailure("saved_map_gl_composite_opacity_runtime_unsupported")
    raised = any(
        part.get("metadata", {}).get("opengeo:drawOrder") == "above-data"
        for occurrence in request["occurrences"]
        for part in occurrence["style"]["layers"]
    )
    if raised and runtime.get("scriptChecksumSha256") not in LABEL_ORDER_SCRIPT_HASHES:
        raise ValidationFailure("saved_map_gl_label_order_runtime_unsupported")


SUPPORTED_MAPLIBRE_VERSIONS = frozenset({"5.24.0", "6.0.0"})


def bound_engine_version(request: dict[str, Any], runtime: dict[str, Any]) -> str:
    """Use the verified package identity; legacy requests remain pinned to v5."""
    version: str | None = runtime.get("maplibreVersion")
    expected = request.get("maplibreVersion")
    if expected is None and "runtimeReference" not in request:
        expected = "5.24.0"
    if (
        version is None
        or version not in SUPPORTED_MAPLIBRE_VERSIONS
        or (expected is not None and expected != version)
    ):
        raise ValidationFailure("saved_map_gl_engine_identity_mismatch")
    return version
