"""Freeze Artifact selection for a Publication source revision without reading bytes."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from opengeo_api.tenant_database import TenantContext, TenantTransaction

if TYPE_CHECKING:
    from opengeo_api.observable_sources import PostgresObservableSourceRepository

from typing import TYPE_CHECKING
from uuid import uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.observable_sources import ObservableSourceConflict
from opengeo_api.publication_artifact_references import latest_references, resolve_references

if TYPE_CHECKING:
    from opengeo_api.observable_sources import ObservableSourceRevision


def validate_input_paths(
    revision: ObservableSourceRevision, pins: list[dict[str, Any]], limits: dict[str, int]
) -> None:
    attachments = revision.manifest.get("dataAttachments", [])
    paths = [file.relative_path for file in revision.files]
    paths += [item["path"] for item in attachments]
    paths += [pin["path"] for pin in pins]
    if len(paths) > limits["maxInputFiles"]:
        raise ObservableSourceConflict("publication_artifact_input_file_limit")
    folded = sorted(path.casefold() for path in paths)
    if any(
        b == a or b.startswith(a + "/")
        for index, a in enumerate(folded)
        for b in folded[index + 1 :]
    ):
        raise ObservableSourceConflict("publication_artifact_source_path_collision")
    size = sum(file.size_bytes for file in revision.files)
    size += sum(pin["output"]["sizeBytes"] for pin in pins)
    if size > limits["maxInputBytes"]:
        raise ObservableSourceConflict("publication_artifact_input_size_limit")
    # Compilers only copy assets beneath their authored source root.
    entry = revision.entry_path
    if entry.lower().endswith(".md"):
        root = (
            "src/"
            if entry.startswith("src/")
            and any(file.relative_path == "package.json" for file in revision.files)
            else ""
        )
    else:
        root = entry.rsplit("/", 1)[0] + "/" if "/" in entry else ""
    if root and any(not pin["path"].startswith(root) for pin in pins):
        raise ObservableSourceConflict("publication_artifact_outside_source_root")


async def prepare_artifact_inputs(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    expected_reference_revision: int,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.SITE_MANAGE, await repository._project_roles(transaction, context, project_id)
        )
        project = await repository._load_project(
            transaction, context, project_id, source_id, for_share=True
        )
        revision = await repository._load_revision(
            transaction, context, project_id, source_id, revision_id
        )
        references = await latest_references(transaction, context, source_id)
        if references["revision"] != expected_reference_revision:
            raise ObservableSourceConflict(
                "publication_artifact_revision_conflict", current_revision=references["revision"]
            )
        if not references["references"]:
            raise ObservableSourceConflict("publication_artifact_references_empty")
        resolved = await resolve_references(
            transaction, context, repository._executor, references["references"]
        )
        validate_input_paths(revision, resolved, project.resource_limits)
        pins = []
        for pin in resolved:
            output = await transaction.fetch_one(
                """SELECT portable_object_id FROM app.project_artifact_versions
                   WHERE organization_id=%s AND artifact_id=%s AND version_number=%s""",
                (context.organization_id, UUID(pin["artifact_id"]), pin["resolved_version"]),
            )
            if output is None or output[0] is None:
                raise ObservableSourceConflict("publication_artifact_unavailable")
            pins.append(
                {
                    "path": pin["path"],
                    "artifactId": pin["artifact_id"],
                    "version": pin["resolved_version"],
                    "outputObjectId": str(output[0]),
                    "manifestChecksumSha256": pin["manifest_checksum_sha256"],
                    "output": pin["output"],
                }
            )
        manifest = {
            "schemaVersion": "opengeo.publication-artifact-inputs.1.0.0",
            "sourceProjectId": str(source_id),
            "sourceRevisionId": str(revision_id),
            "sourceManifestChecksumSha256": revision.manifest_checksum_sha256,
            "referenceRevision": references["revision"],
            "artifacts": pins,
        }
        row = await transaction.fetch_one(
            """INSERT INTO app.publication_artifact_inputs
               (organization_id,id,source_project_id,source_revision_id,reference_revision,
                manifest,manifest_checksum_sha256,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (organization_id,source_project_id,manifest_checksum_sha256)
               DO NOTHING RETURNING id,manifest_checksum_sha256""",
            (
                context.organization_id,
                uuid4(),
                source_id,
                revision_id,
                references["revision"],
                Jsonb(manifest),
                "0" * 64,
                context.user_id,
            ),
        )
        reused = row is None
        if reused:
            row = await transaction.fetch_one(
                """SELECT id,manifest_checksum_sha256 FROM app.publication_artifact_inputs
                   WHERE organization_id=%s AND source_project_id=%s AND manifest=%s""",
                (context.organization_id, source_id, Jsonb(manifest)),
            )
        if row is None:
            raise ObservableSourceConflict("publication_artifact_inputs_changed")
        return {
            "id": str(row[0]),
            "manifest": manifest,
            "manifest_checksum_sha256": row[1],
            "reused": reused,
        }

    return await repository._run(context, operation)


async def read_artifact_inputs(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    input_id: UUID,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        return await read_inputs_in_transaction(
            repository, transaction, context, project_id, source_id, input_id
        )

    return await repository._run(context, operation)


async def read_inputs_in_transaction(
    repository: PostgresObservableSourceRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    input_id: UUID,
) -> dict[str, Any]:
    repository._require(
        Action.SITE_READ, await repository._project_roles(transaction, context, project_id)
    )
    await repository._load_project(transaction, context, project_id, source_id)
    row = await transaction.fetch_one(
        """SELECT manifest,manifest_checksum_sha256 FROM app.publication_artifact_inputs
           WHERE organization_id=%s AND source_project_id=%s AND id=%s""",
        (context.organization_id, source_id, input_id),
    )
    if row is None:
        raise ObservableSourceConflict("publication_artifact_inputs_unavailable")
    manifest = row[0]
    pins = manifest["artifacts"]
    confirmed = await resolve_references(
        transaction,
        context,
        repository._executor,
        [
            {
                "path": pin["path"],
                "artifact_id": pin["artifactId"],
                "mode": "pinned",
                "version": pin["version"],
            }
            for pin in pins
        ],
    )
    for saved, resolved in zip(pins, confirmed, strict=True):
        if (
            saved["manifestChecksumSha256"] != resolved["manifest_checksum_sha256"]
            or saved["output"] != resolved["output"]
        ):
            raise ObservableSourceConflict("publication_artifact_inputs_changed")
    return {"id": str(input_id), "manifest": manifest, "manifest_checksum_sha256": row[1]}
