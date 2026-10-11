"""Byte validation for portable Artifact registration.

This boundary performs no I/O and grants no authorization. Callers must authorize
and load the saved composition and output independently before retaining an edition.
Browser-recorded provenance remains distinct from a server-compiled Project seal.
"""

import json
import re
from hashlib import sha256
from typing import Any
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes

MAX_MANIFEST_BYTES = 49_152
MAX_HTML_BYTES = 4_194_304


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("artifact_manifest_duplicate_key")
        result[key] = value
    return result


def _nonfinite(value: str) -> Any:
    raise ValueError("artifact_manifest_nonfinite_number")


def validate_portable_manifest(manifest_bytes: bytes) -> dict[str, Any]:
    """Validate bounded metadata before authorizing an upload; no byte attestation."""
    if not 0 < len(manifest_bytes) <= MAX_MANIFEST_BYTES:
        raise ValueError("artifact_manifest_size_invalid")
    try:
        manifest = json.loads(
            manifest_bytes.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_nonfinite,
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError("artifact_bytes_invalid") from error
    if not isinstance(manifest, dict):
        raise ValueError("artifact_manifest_invalid")
    if (
        manifest.get("schemaVersion") != "opengeo.project-artifact.1.0.0"
        or manifest.get("representation") != "portable-map-html"
        or manifest.get("canonicalization") != "opengeo-codepoint-decimal-v1"
    ):
        raise ValueError("artifact_manifest_encoding_unsupported")
    output = manifest.get("output")
    if (
        not isinstance(output, dict)
        or output.get("objectId") is not None
        or output.get("mediaType") != "text/html"
        or type(output.get("sizeBytes")) is not int
        or not 0 < output["sizeBytes"] <= MAX_HTML_BYTES
    ):
        raise ValueError("artifact_output_identity_invalid")
    checksum = output.get("checksumSha256")
    if (
        not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        or manifest.get("artifactId") != f"sha256:{checksum}"
    ):
        raise ValueError("artifact_output_checksum_mismatch")
    contents = {key: value for key, value in manifest.items() if key != "manifestChecksumSha256"}
    try:
        checksum = sha256(canonical_json_bytes(contents)).hexdigest()
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ValueError("artifact_manifest_invalid") from error
    if manifest.get("manifestChecksumSha256") != checksum:
        raise ValueError("artifact_manifest_checksum_mismatch")
    build = manifest.get("build")
    if (
        manifest.get("project") is not None
        or not isinstance(build, dict)
        or build.get("inputScope") != "reviewed-browser-snapshot"
    ):
        raise ValueError("artifact_snapshot_scope_invalid")
    return manifest


def validate_portable_bytes(html: bytes, manifest_bytes: bytes) -> dict[str, Any]:
    """Verify exact retained bytes after independently validating the sidecar."""
    if not 0 < len(html) <= MAX_HTML_BYTES:
        raise ValueError("artifact_output_size_invalid")
    manifest = validate_portable_manifest(manifest_bytes)
    try:
        html.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise ValueError("artifact_bytes_invalid") from error
    if manifest["output"]["sizeBytes"] != len(html):
        raise ValueError("artifact_output_identity_invalid")
    if manifest["output"]["checksumSha256"] != sha256(html).hexdigest():
        raise ValueError("artifact_output_checksum_mismatch")
    return manifest


def validate_portable_origin(
    manifest: dict[str, Any], *, map_id: UUID, map_version: int, definition: dict[str, Any]
) -> None:
    """Match provenance to an independently authorized, exact saved-version read.

    The caller must not pass a definition supplied by the browser. Matching an
    origin does not prove that the HTML implements that definition or pins its data.
    """
    provenance = manifest.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("artifact_saved_origin_required")
    if (
        provenance.get("authoritativeBuild") is not False
        or provenance.get("relationship") != "browser-snapshot-from-saved-project"
    ):
        raise ValueError("artifact_origin_scope_invalid")
    origin = provenance.get("originatingProject")
    if (
        not isinstance(origin, dict)
        or origin.get("id") != str(map_id)
        or type(origin.get("version")) is not int
        or origin["version"] != map_version
        or origin.get("definitionChecksumSha256")
        != sha256(canonical_json_bytes(definition)).hexdigest()
    ):
        raise ValueError("artifact_saved_origin_mismatch")
