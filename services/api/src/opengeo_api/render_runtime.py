"""Immutable renderer-package identity, configured by the deployment operator."""

import re
from dataclasses import dataclass
from typing import Any

RUNTIME_REFERENCE_SCHEMA = "opengeo.render-runtime-reference.1.0.0"
PINNED_GL_RENDERER = "opengeo.maplibre-gl-js.v2"


@dataclass(frozen=True, slots=True)
class RenderRuntimeReference:
    manifest_sha256: str
    architecture: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.manifest_sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", self.manifest_sha256)
            or self.architecture not in ("x86_64", "aarch64")
        ):
            raise ValueError("Use an exact renderer package checksum and supported architecture")

    def as_dict(self) -> dict[str, str]:
        return {
            "schemaVersion": RUNTIME_REFERENCE_SCHEMA,
            "manifestSha256": self.manifest_sha256,
            "architecture": self.architecture,
        }

    @classmethod
    def parse(cls, value: Any) -> "RenderRuntimeReference":
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "manifestSha256", "architecture"}
            or value["schemaVersion"] != RUNTIME_REFERENCE_SCHEMA
        ):
            raise ValueError("Use the closed renderer runtime reference")
        return cls(value["manifestSha256"], value["architecture"])
