"""Credential-free publication planning and resumable, separately authorized promotion.

No project code executes here. Storage/edge adapters must implement conditional
writes and exact reads; repository checkpoints must fence the active origin job.
"""

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID, uuid4


class PublicationConflict(RuntimeError):
    pass


def checksum(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _path(path: str, *, directory: bool = False) -> str:
    if not isinstance(path, str) or len(path) > 1024:
        raise PublicationConflict("publication_path_invalid")
    candidate = path[:-1] if directory and path.endswith("/") else path
    if not re.fullmatch(
        r"[A-Za-z0-9_@][A-Za-z0-9._@,-]{0,99}(?:/[A-Za-z0-9_@][A-Za-z0-9._@,-]{0,99}){0,15}",
        candidate,
    ):
        raise PublicationConflict("publication_path_invalid")
    return path


def _owner(path: str, mounts: tuple[str, ...]) -> str:
    for mount in sorted(mounts, key=len, reverse=True):
        stem = mount.strip("/")
        if not stem or path.startswith(stem + "/") or path in {stem, stem + ".html"}:
            return mount
    raise PublicationConflict("publication_path_has_no_owner")


def _jsonb_text(value: Any) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ", ".join(_jsonb_text(item) for item in value) + "]"
    if isinstance(value, Mapping) and all(isinstance(key, str) for key in value):
        keys = sorted(value, key=lambda key: (len(key.encode()), key.encode()))
        return (
            "{" + ", ".join(_jsonb_text(key) + ": " + _jsonb_text(value[key]) for key in keys) + "}"
        )
    raise PublicationConflict("publication_localized_proof_invalid")


def _jsonb_checksum(value: Any) -> str:
    return hashlib.sha256(_jsonb_text(value).encode()).hexdigest()


def localized_output_proof(value: Any, file: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the unchanged compiler seal against an exact HTML byte pin."""
    invalid = "publication_localized_proof_invalid"
    if not isinstance(value, dict) or set(value) != {"manifest", "manifestChecksumSha256"}:
        raise PublicationConflict(invalid)
    manifest = value["manifest"]
    if (
        not isinstance(manifest, dict)
        or set(manifest)
        != {
            "assets",
            "entryPath",
            "fontFallback",
            "inputFiles",
            "output",
            "outputBytes",
            "publicationAuthorized",
            "schemaVersion",
            "sourceOutputTreeChecksumSha256",
            "unsupportedLazyImports",
        }
        or len(_jsonb_text(value).encode()) > 262_144
        or value["manifestChecksumSha256"] != _jsonb_checksum(manifest)
        or manifest["schemaVersion"] != "opengeo.framework-localized-output.1.0.0"
        or manifest["entryPath"] != "dist/index.html"
        or manifest["publicationAuthorized"] is not False
        or manifest["fontFallback"] not in (None, "system-fonts")
        or not isinstance(manifest["inputFiles"], list)
        or not 1 <= len(manifest["inputFiles"]) <= 512
        or not isinstance(manifest["assets"], list)
        or len(manifest["assets"]) > len(manifest["inputFiles"])
        or not isinstance(manifest["unsupportedLazyImports"], list)
        or len(manifest["unsupportedLazyImports"]) > 512
        or not isinstance(manifest["sourceOutputTreeChecksumSha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", manifest["sourceOutputTreeChecksumSha256"])
    ):
        raise PublicationConflict(invalid)
    output = manifest["output"]
    if (
        not isinstance(output, dict)
        or set(output) != {"path", "sizeBytes", "contentType", "checksumSha256"}
        or output["path"] != "dist/index.html"
        or output["contentType"] != "text/html"
        or type(output["sizeBytes"]) is not int
        or not 1 <= output["sizeBytes"] <= 100_663_296
        or type(manifest["outputBytes"]) is not int
        or manifest["outputBytes"] != output["sizeBytes"]
        or not isinstance(output["checksumSha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", output["checksumSha256"])
        or any(
            file.get(key) != output[key] for key in ("sizeBytes", "contentType", "checksumSha256")
        )
    ):
        raise PublicationConflict(invalid)
    return value


def retained_localized_files(plan: Any, prefix: str, bucket: str) -> dict[str, dict[str, Any]]:
    """Only the current origin's SQL-selected deployed plan supplies retained proof."""
    if plan is None:
        return {}
    if (
        not isinstance(plan, Mapping)
        or plan.get("schema") != "opengeo.framework-publication-plan.1.0.0"
        or plan.get("targetPrefix") != prefix
        or plan.get("bucket") != bucket
        or not isinstance(plan.get("files"), list)
        or not 1 <= len(plan["files"]) <= 2048
        or len(json.dumps(plan).encode()) > 750_000
    ):
        raise PublicationConflict("publication_retained_plan_invalid")
    retained = {}
    paths = set()
    for entry in plan["files"]:
        path = _path(entry.get("path"), directory=True)
        if path.casefold() in paths:
            raise PublicationConflict("publication_retained_plan_invalid")
        paths.add(path.casefold())
        source = entry.get("source", {})
        if entry.get("kind") == "copy" and "localizedOutput" in source:
            localized_output_proof(source["localizedOutput"], source)
            retained[path] = dict(source)
    return retained


def _referenced_publication_pins(
    request: Mapping[str, Any],
    revision: Mapping[str, Any],
    approval: Mapping[str, Any],
    result: Mapping[str, Any],
    source_id: UUID,
    organization_id: UUID,
    project_id: UUID,
) -> list[dict[str, Any]]:
    """Bind exact approved inputs; repository.authorize retains current authority."""
    invalid = "publication_referenced_authority_invalid"
    data = revision.get("dataAttachments")
    references = revision.get("referencedFiles")
    approved = approval.get("manifest", {})
    if (
        revision.get("schemaVersion") != "opengeo.observable-source-revision.3.0.0"
        or not isinstance(data, list)
        or not isinstance(references, list)
        or not 1 <= len(references) <= 128
        or len(data) + len(references) > 128
        or any(not isinstance(pin, Mapping) for pin in data + references)
        or request.get("schemaVersion")
        not in {"opengeo.observable-build-request.3.0.0", "opengeo.observable-build-request.4.0.0"}
        or request.get("purpose") != "release_candidate"
        or "artifactInputsChecksumSha256" in request
        or request.get("sourceProjectId") != str(source_id)
        or revision.get("sourceProjectId") != str(source_id)
        or revision.get("revisionId") != request.get("sourceRevisionId")
        or revision.get("revisionNumber") != request.get("sourceRevisionNumber")
        or request.get("sourceManifestChecksumSha256") != _jsonb_checksum(revision)
        or result.get("inputManifestChecksumSha256") != request.get("sourceManifestChecksumSha256")
        or result.get("requestChecksumSha256") != _jsonb_checksum(request)
        or result.get("compilerImageDigest") != request.get("compilerImageDigest")
        or result.get("validationReport", {}).get("publicationAuthorized") is not False
        or request.get("outputProfile") not in {"default-32m", "archive-96m"}
        or request.get("sizeAcknowledgment")
        != ("allow-up-to-96-mib-output" if request.get("outputProfile") == "archive-96m" else None)
        or not isinstance(approved, Mapping)
        or set(approved)
        != {
            "schemaVersion",
            "organizationId",
            "projectId",
            "sourceProjectId",
            "sourceRevisionId",
            "sourceManifestChecksumSha256",
            "compilerImageDigest",
            "outputProfile",
            "artifactInputsChecksumSha256",
            "dataAttachments",
            "archiveRights",
            "artifacts",
            "referencedFiles",
            "referenceRights",
        }
        or approved.get("schemaVersion") != "opengeo.observable-input-distribution-approval.2.0.0"
        or approved.get("organizationId") != str(organization_id)
        or approved.get("projectId") != str(project_id)
        or approved.get("sourceProjectId") != str(source_id)
        or approved.get("sourceRevisionId") != request.get("sourceRevisionId")
        or approved.get("outputProfile") != request.get("outputProfile")
        or approved.get("compilerImageDigest") != request.get("compilerImageDigest")
        or approved.get("sourceManifestChecksumSha256")
        != request.get("sourceManifestChecksumSha256")
        or approved.get("artifactInputsChecksumSha256") is not None
        or approved.get("artifacts") != []
        or approved.get("dataAttachments") != data
        or approved.get("referencedFiles") != references
        or approval.get("manifest_checksum_sha256") != _jsonb_checksum(approved)
        or not isinstance(approval.get("id"), str)
        or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", approval["id"])
        or request.get("distributionApprovalId") != approval["id"]
        or request.get("distributionApprovalChecksumSha256") != approval["manifest_checksum_sha256"]
    ):
        raise PublicationConflict(invalid)
    # The SQL predicate rechecks these editions and RESOURCE_PUBLISH permissions
    # around every write. Keep the reviewed rights bound to their respective pins.
    for pins, rights, keys, acknowledgment in (
        (
            data,
            approved.get("archiveRights"),
            ("path", "attachmentId"),
            "publish-exact-archive-file",
        ),
        (
            references,
            approved.get("referenceRights"),
            ("referenceId", "path", "resourceId", "distributionId"),
            "publish-exact-referenced-file",
        ),
    ):
        if not isinstance(rights, list) or len(rights) != len(pins):
            raise PublicationConflict(invalid)
        for pin, terms in zip(pins, rights, strict=True):
            if (
                not isinstance(terms, Mapping)
                or set(terms)
                != set(keys)
                | {"resourceId", "resourceVersionId", "license", "attribution", "acknowledgment"}
                or any(terms.get(key) != pin.get(key) for key in keys)
                or any(
                    not isinstance(terms.get(key), str)
                    or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", terms[key])
                    for key in ("resourceId", "resourceVersionId")
                )
                or terms.get("acknowledgment") != acknowledgment
                or terms.get("license") not in {"CC0-1.0", "CC-BY-4.0", "PDDL-1.0"}
                or not isinstance(terms.get("attribution"), str)
                or not 1 <= len(terms["attribution"].strip()) <= 2000
            ):
                raise PublicationConflict(invalid)
    return data + references


def _native_publication_proof(
    request: Mapping[str, Any],
    revision: Mapping[str, Any],
    approval: Mapping[str, Any],
    result: Mapping[str, Any],
    outputs: list[dict[str, Any]],
    source_id: UUID,
    organization_id: UUID,
    project_id: UUID,
) -> tuple[dict[str, Any], int]:
    invalid = "publication_localized_authority_invalid"
    if (
        request.get("schemaVersion") != "opengeo.observable-build-request.4.0.0"
        or request.get("outputRepresentation") != "single-html"
        or result.get("schemaVersion") != "opengeo.observable-build-result.2.0.0"
        or result.get("outputRepresentation") != "single-html"
        or "artifactInputsChecksumSha256" in request
        or request.get("sourceProjectId") != str(source_id)
        or request.get("purpose") not in {"preview", "release_candidate"}
        or revision.get("schemaVersion")
        not in {
            "opengeo.observable-source-revision.1.0.0",
            "opengeo.observable-source-revision.2.0.0",
            "opengeo.observable-source-revision.3.0.0",
        }
        or revision.get("sourceProjectId") != str(source_id)
        or revision.get("revisionId") != request.get("sourceRevisionId")
        or revision.get("revisionNumber") != request.get("sourceRevisionNumber")
        or revision.get("entryPath") not in {"index.md", "src/index.md"}
        or request.get("sourceManifestChecksumSha256") != _jsonb_checksum(revision)
        or result.get("inputManifestChecksumSha256") != request.get("sourceManifestChecksumSha256")
        or result.get("requestChecksumSha256") != _jsonb_checksum(request)
        or result.get("compilerImageDigest") != request.get("compilerImageDigest")
        or result.get("validationReport", {}).get("publicationAuthorized") is not False
        or len(outputs) != 1
        or outputs[0].get("path") != "dist/index.html"
        or result.get("routeManifest") != [{"path": "/", "file": "dist/index.html"}]
    ):
        raise PublicationConflict(invalid)
    proof = localized_output_proof(result.get("localizedOutput"), outputs[0])
    data = revision.get("dataAttachments", [])
    referenced = revision.get("schemaVersion") == "opengeo.observable-source-revision.3.0.0"
    if referenced:
        data = _referenced_publication_pins(
            request, revision, approval, result, source_id, organization_id, project_id
        )
    expanded = request.get("outputProfile") == "archive-96m"
    maximum = request.get("resourceLimits", {}).get("maxOutputBytes")
    if (
        not isinstance(data, list)
        or request.get("outputProfile") not in {"default-32m", "archive-96m"}
        or request.get("sizeAcknowledgment") != ("allow-up-to-96-mib-output" if expanded else None)
        or (expanded and not data)
        or type(maximum) is not int
        or not 1 <= maximum <= 33_554_432
        or (request.get("distributionApprovalId") is None)
        != (request.get("distributionApprovalChecksumSha256") is None)
        or (not data and request.get("outputProfile") != "default-32m")
    ):
        raise PublicationConflict(invalid)
    if data and not referenced:
        approved = approval.get("manifest", {})
        if (
            approved.get("schemaVersion") != "opengeo.observable-input-distribution-approval.1.0.0"
            or approved.get("organizationId") != str(organization_id)
            or approved.get("projectId") != str(project_id)
            or approved.get("sourceProjectId") != str(source_id)
            or approved.get("sourceRevisionId") != request.get("sourceRevisionId")
            or approved.get("outputProfile") != request.get("outputProfile")
            or approved.get("compilerImageDigest") != request.get("compilerImageDigest")
            or approved.get("sourceManifestChecksumSha256")
            != request.get("sourceManifestChecksumSha256")
            or approved.get("artifactInputsChecksumSha256") is not None
            or approved.get("artifacts") != []
            or approved.get("dataAttachments") != data
            or approval.get("manifest_checksum_sha256") != _jsonb_checksum(approved)
            or (
                request.get("distributionApprovalId") is not None
                and (
                    request["distributionApprovalId"] != approval.get("id")
                    or request["distributionApprovalChecksumSha256"]
                    != approval["manifest_checksum_sha256"]
                )
            )
            or (
                request.get("purpose") != "preview"
                and request.get("distributionApprovalId") is None
            )
        ):
            raise PublicationConflict(invalid)
    elif not referenced and (approval or request.get("distributionApprovalId") is not None):
        raise PublicationConflict(invalid)
    return proof, 100_663_296 if expanded else maximum


def plan_publication(
    *,
    review_id: UUID,
    build_id: UUID,
    source_project_id: UUID,
    organization_id: UUID,
    project_id: UUID,
    source_bucket: str,
    public_bucket: str,
    previous_prefix: str,
    mount_path: str,
    reserved_mounts: tuple[str, ...],
    build_result: Mapping[str, Any],
    current_files: list[dict[str, Any]],
    private_origin: bool = False,
    build_request: Mapping[str, Any] | None = None,
    source_manifest: Mapping[str, Any] | None = None,
    input_distribution: Mapping[str, Any] | None = None,
    previous_release_plan: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Replace only this mount, retaining all root/sibling files in a fresh release.

    Inventory entries must have been verified by the storage adapter and include
    an exact version or ETag, content checksum, size, and delivery metadata.
    Redirect objects work with the explicitly reviewed S3 website origin.
    """
    if not re.fullmatch(r"releases/[A-Za-z0-9_-]+", previous_prefix):
        raise PublicationConflict("publication_previous_release_invalid")
    if (
        source_bucket == public_bucket
        or "/" not in reserved_mounts
        or mount_path not in reserved_mounts
        or len(set(reserved_mounts)) != len(reserved_mounts)
    ):
        raise PublicationConflict("publication_mount_registry_invalid")
    for mount in reserved_mounts:
        if mount != "/" and not re.fullmatch(
            r"/[a-z0-9][a-z0-9-]{0,79}(?:/[a-z0-9][a-z0-9-]{0,79}){0,7}/", mount
        ):
            raise PublicationConflict("publication_mount_registry_invalid")
    prefix = (
        f"organizations/{organization_id}/projects/{project_id}/"
        f"source-projects/{source_project_id}/builds/{build_id}/output/"
    )
    if (
        build_result.get("buildJobId") != str(build_id)
        or build_result.get("outputPrefix") != prefix
    ):
        raise PublicationConflict("publication_build_identity_invalid")
    outputs = build_result.get("outputManifest", {}).get("files")
    routes = build_result.get("routeManifest")
    if (
        not isinstance(outputs, list)
        or not 1 <= len(outputs) <= 512
        or not isinstance(routes, list)
        or len(routes) > 128
        or len(current_files) > 2048
    ):
        raise PublicationConflict("publication_manifest_limit")
    result: dict[str, dict[str, Any]] = {}
    current: dict[str, dict[str, Any]] = {}
    retained = retained_localized_files(previous_release_plan, previous_prefix, public_bucket)
    original_names: set[str] = set()
    for file in current_files:
        path = _path(file["path"], directory=True)
        if path.lower() in original_names:
            raise PublicationConflict("publication_duplicate_inventory_path")
        original_names.add(path.lower())
        if (
            file.get("bucket") != public_bucket
            or file.get("objectKey") != previous_prefix + "/" + path
        ):
            raise PublicationConflict("publication_inventory_scope_invalid")
        file = dict(file)
        if path in retained:
            localized_output_proof(retained[path]["localizedOutput"], file)
            file["localizedOutput"] = retained[path]["localizedOutput"]
        elif "localizedOutput" in file:
            raise PublicationConflict("publication_retained_plan_required")
        _pin(file, maximum_bytes=100_663_296 if path in retained else 67_108_864)
        current[path] = file
        if _owner(path, reserved_mounts) != mount_path:
            result[path] = {"path": path, "kind": "copy", "source": dict(file)}
            if file["sizeBytes"] > 33_554_432:
                result[path]["maximumBytes"] = 100_663_296 if path in retained else 67_108_864
    built: dict[str, dict[str, Any]] = {}
    mounted = mount_path.lstrip("/")

    def add(path: str, entry: dict[str, Any]) -> None:
        _path(path, directory=True)
        if _owner(path, reserved_mounts) != mount_path:
            raise PublicationConflict("publication_sibling_path_collision")
        if path in result and result[path] != entry:
            raise PublicationConflict("publication_route_collision")
        result[path] = entry

    def output_copy(path: str, file: dict[str, Any]) -> dict[str, Any]:
        previous = current.get(path)
        entry: dict[str, Any]
        # Reuse only verified bytes at this exact destination, with the same
        # browser delivery semantics. A filename or ETag is not content proof.
        # Keep a fresh release: activation and rollback remain origin-atomic.
        delivery = file.get(
            "delivery", {"content-type": file["contentType"], "cache-control": "no-cache"}
        )
        if previous is not None and (
            all(
                previous.get(key) == file[key]
                for key in ("checksumSha256", "sizeBytes", "contentType")
            )
            and previous.get("delivery") == delivery
        ):
            entry = {"path": path, "kind": "copy", "source": dict(previous)}
        else:
            entry = {"path": path, "kind": "copy", "source": dict(file)}
        if native_proof is not None:
            entry["source"]["localizedOutput"] = native_proof
        if file["sizeBytes"] > 33_554_432:
            entry["maximumBytes"] = 100_663_296 if native_proof is not None else 67_108_864
        return entry

    request = build_request or {}
    revision = source_manifest or {}
    approval = input_distribution or {}
    approved = approval.get("manifest", {})
    native_proof = None
    native_maximum = 33_554_432
    native = (
        request.get("schemaVersion") == "opengeo.observable-build-request.4.0.0"
        or build_result.get("schemaVersion") == "opengeo.observable-build-result.2.0.0"
    )
    referenced = (
        revision.get("schemaVersion") == "opengeo.observable-source-revision.3.0.0"
        or bool(revision.get("referencedFiles"))
        or approved.get("schemaVersion") == "opengeo.observable-input-distribution-approval.2.0.0"
    )
    reference_pins = []
    if referenced:
        reference_pins = _referenced_publication_pins(
            request,
            revision,
            approval,
            build_result,
            source_project_id,
            organization_id,
            project_id,
        )
    if native:
        native_proof, native_maximum = _native_publication_proof(
            request,
            revision,
            approval,
            build_result,
            outputs,
            source_project_id,
            organization_id,
            project_id,
        )
    expanded = (referenced and request.get("outputProfile") == "archive-96m") or (
        request.get("schemaVersion") == "opengeo.observable-build-request.3.0.0"
        and request.get("outputProfile") == "archive-96m"
        and request.get("sizeAcknowledgment") == "allow-up-to-96-mib-output"
        and approved.get("schemaVersion") == "opengeo.observable-input-distribution-approval.1.0.0"
        and approved.get("organizationId") == str(organization_id)
        and approved.get("projectId") == str(project_id)
        and approved.get("sourceProjectId") == str(source_project_id)
        and approved.get("sourceRevisionId") == request.get("sourceRevisionId")
        and approved.get("outputProfile") == "archive-96m"
        and approved.get("compilerImageDigest") == request.get("compilerImageDigest")
        and approved.get("sourceManifestChecksumSha256")
        == request.get("sourceManifestChecksumSha256")
        and approved.get("artifactInputsChecksumSha256")
        == request.get("artifactInputsChecksumSha256")
        and isinstance(approval.get("manifest_checksum_sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", approval["manifest_checksum_sha256"]) is not None
        and approved.get("dataAttachments") == revision.get("dataAttachments")
        and isinstance(revision.get("dataAttachments"), list)
        and bool(revision["dataAttachments"])
    )

    def exact_data_file(file: Mapping[str, Any]) -> bool:
        pins = reference_pins if referenced else revision.get("dataAttachments", [])
        return bool(expanded) and any(
            pin.get("checksumSha256") == file.get("checksumSha256")
            and pin.get("sizeBytes") == file.get("sizeBytes")
            and _extension(pin.get("path", "")) == _extension(file.get("path", ""))
            and _extension(pin.get("path", "")) is not None
            for pin in pins
        )

    total_bytes = 0
    for file in outputs:
        name = file.get("path", "")
        if not name.startswith("dist/") or name in built:
            raise PublicationConflict("publication_output_path_invalid")
        relative = _path(name[5:])
        if (
            file.get("bucket") != source_bucket
            or file.get("objectKey") != prefix + relative
            or not file.get("s3VersionId")
        ):
            raise PublicationConflict("publication_output_scope_invalid")
        _pin(
            file,
            maximum_bytes=native_maximum
            if native
            else 67_108_864
            if exact_data_file(file)
            else 33_554_432,
        )
        total_bytes += file["sizeBytes"]
        if total_bytes > (native_maximum if native else 100_663_296 if expanded else 33_554_432):
            raise PublicationConflict("publication_output_size_limit")
        built[name] = dict(file)
        path = mounted + relative
        add(path, output_copy(path, file))
    if "dist/index.html" not in built:
        raise PublicationConflict("publication_index_required")
    for route in routes:
        route_file = built.get(route.get("file"))
        if not route_file or route_file["contentType"] != "text/html":
            raise PublicationConflict("publication_route_invalid")
        file = route_file
        relative = file["path"][5:]
        if not relative.endswith(".html"):
            raise PublicationConflict("publication_route_invalid")
        expected = (
            "/"
            if relative == "index.html"
            else "/" + (relative[:-10] if relative.endswith("/index.html") else relative[:-5])
        )
        if route.get("path") != expected:
            raise PublicationConflict("publication_route_invalid")
        canonical = mount_path + expected.lstrip("/")
        key = canonical.lstrip("/")
        if private_origin and key.endswith("/"):
            # REST origins do not resolve directory indexes. Store the same
            # verified HTML at the canonical directory key, preserving URL depth.
            add(key, output_copy(key, file))
        if key and not key.endswith("/"):
            # Extensionless page stays at the same directory depth as foo.html.
            add(key, output_copy(key, file))
        stem = key.rstrip("/")
        aliases = (
            {stem, stem + ".html"}
            if canonical.endswith("/")
            else {stem + "/", stem + "/index.html"}
        )
        for alias in aliases:
            if not stem or alias == mounted + relative:
                continue
            add(alias, {"path": alias, "kind": "redirect", "location": canonical})
    entries = [result[path] for path in sorted(result)]
    if len({entry["path"].lower() for entry in entries}) != len(entries) or len(entries) > 2048:
        raise PublicationConflict("publication_route_collision")
    plan: dict[str, Any] = {
        "schema": "opengeo.framework-publication-plan.1.0.0",
        "reviewId": str(review_id),
        "buildId": str(build_id),
        "mountPath": mount_path,
        "previousPrefix": previous_prefix,
        "targetPrefix": f"releases/framework-{review_id}",
        "bucket": public_bucket,
        "files": entries,
    }
    if private_origin:
        plan["privateOrigin"] = True
    if len(json.dumps(plan).encode()) > 750_000:
        raise PublicationConflict("publication_plan_limit")
    return plan


def _extension(path: str) -> str | None:
    suffix = re.search(r"\.[^./]+$", path)
    return suffix[0].lower() if suffix else None


def _pin(file: Mapping[str, Any], *, maximum_bytes: int = 33_554_432) -> None:
    if (
        not isinstance(file.get("checksumSha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", file["checksumSha256"])
        or type(file.get("sizeBytes")) is not int
        or not 0 <= file["sizeBytes"] <= maximum_bytes
        or not isinstance(file.get("contentType"), str)
        or len(file["contentType"]) > 200
        or not (file.get("s3VersionId") or file.get("etag"))
    ):
        raise PublicationConflict("publication_object_pin_invalid")


class PublicationRepository(Protocol):
    async def claim(self, review: UUID, token: UUID) -> dict[str, Any]: ...
    async def authorize(self, review: UUID, token: UUID) -> bool: ...
    async def save_plan(
        self, review: UUID, token: UUID, plan: dict[str, Any], edge: dict[str, Any]
    ) -> bool: ...
    async def checkpoint(self, review: UUID, token: UUID, position: int) -> bool: ...
    async def activating(self, review: UUID, token: UUID) -> bool: ...
    async def complete(self, review: UUID, token: UUID, receipt: dict[str, Any]) -> bool: ...
    async def attention(self, review: UUID, token: UUID, code: str) -> None: ...
    async def release(self, review: UUID, token: UUID) -> None: ...


class PublicationStorage(Protocol):
    async def inventory(
        self, bucket: str, prefix: str, *, previous_release_plan: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]: ...
    async def apply(self, bucket: str, prefix: str, file: dict[str, Any]) -> None: ...
    async def verify(self, plan: dict[str, Any]) -> None: ...


class PublicationEdge(Protocol):
    async def prepare(self, origin: dict[str, Any], previous: str) -> dict[str, Any]: ...
    async def activate(
        self, origin: dict[str, Any], snapshot: dict[str, Any], target: str, review: UUID
    ) -> dict[str, Any] | None: ...


async def publish_step(
    review_id: UUID,
    *,
    repository: PublicationRepository,
    storage: PublicationStorage,
    edge: PublicationEdge,
    source_bucket: str,
    public_bucket: str,
    maximum_files: int = 64,
    destination_router: Any = None,
) -> str:
    """One bounded invocation. A retry resumes this review, never another build."""
    if type(maximum_files) is not int or not 1 <= maximum_files <= 64:
        raise ValueError("invalid publication chunk size")
    token = uuid4()
    claim = await repository.claim(review_id, token)
    if claim["status"] != "claimed":
        return str(claim["status"])

    async def authorized() -> None:
        if not await repository.authorize(review_id, token):
            raise PublicationConflict("publication_authority_or_lease_lost")

    try:
        await authorized()
        if destination_router is not None:
            public_bucket, storage, edge = destination_router.resolve(claim["origin"])
        if claim["origin"]["bucket"] != public_bucket:
            raise PublicationConflict("publication_destination_scope_invalid")
        plan = claim.get("plan")
        snapshot = claim.get("edge_snapshot")
        if plan is None:
            snapshot = await edge.prepare(claim["origin"], claim["previous_release_prefix"])
            previous_plan = claim.get("previous_release_plan")
            current = await storage.inventory(
                public_bucket,
                claim["previous_release_prefix"],
                **({"previous_release_plan": previous_plan} if previous_plan is not None else {}),
            )
            plan = plan_publication(
                review_id=review_id,
                build_id=UUID(claim["build_job_id"]),
                organization_id=UUID(claim["organization_id"]),
                project_id=UUID(claim["project_id"]),
                source_project_id=UUID(claim["source_project_id"]),
                source_bucket=source_bucket,
                public_bucket=public_bucket,
                previous_prefix=claim["previous_release_prefix"],
                mount_path=claim["mount_path"],
                reserved_mounts=tuple(claim["reserved_mounts"]),
                build_result=claim["build_result"],
                current_files=current,
                private_origin=getattr(storage, "private_origin", False),
                build_request=claim.get("build_request"),
                source_manifest=claim.get("source_manifest"),
                input_distribution=claim.get("input_distribution"),
                previous_release_plan=previous_plan,
            )
            await authorized()
            if not await repository.save_plan(review_id, token, plan, snapshot):
                return "retry"
        if (
            not isinstance(snapshot, dict)
            or plan["reviewId"] != str(review_id)
            or plan["bucket"] != public_bucket
            or plan["targetPrefix"] != f"releases/framework-{review_id}"
            or plan.get("privateOrigin", False) != getattr(storage, "private_origin", False)
        ):
            raise PublicationConflict("publication_plan_identity_invalid")
        start = claim.get("completed_files", 0)
        for index in range(start, min(start + maximum_files, len(plan["files"]))):
            await authorized()
            await storage.apply(public_bucket, plan["targetPrefix"], plan["files"][index])
            if not await repository.checkpoint(review_id, token, index + 1):
                return "retry"
        if start + maximum_files < len(plan["files"]):
            return "retry"
        await authorized()
        await storage.verify(plan)
        if not await repository.activating(review_id, token):
            return "retry"
        await authorized()
        receipt = await edge.activate(claim["origin"], snapshot, plan["targetPrefix"], review_id)
        if receipt is None:
            return "retry"
        return "deployed" if await repository.complete(review_id, token, receipt) else "retry"
    except PublicationConflict as error:
        await repository.attention(review_id, token, str(error))
        return "needs_attention"
    finally:
        await repository.release(review_id, token)
