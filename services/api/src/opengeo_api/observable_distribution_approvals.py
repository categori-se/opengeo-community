"""Explicit distribution decisions for exact saved inputs; never a data capture.

Download authority permits private compilation. Distribution requires its own
canonical resource authority and immutable, version-bound owner decision.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.artifact_releases import read_release
from opengeo_api.authorization import Action, is_allowed
from opengeo_api.observable_sources import ObservableSourceConflict
from opengeo_api.portable_artifact_publication import _requested_sources
from opengeo_api.publication_artifact_inputs import read_inputs_in_transaction
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderAccessDenied,
    RenderConflict,
    RenderNotFound,
)
from opengeo_api.s3_downloads import UnavailableDownloadStorage
from opengeo_api.saved_map_publication import PUBLIC_SAVED_MAP_LICENSES

if TYPE_CHECKING:
    from opengeo_api.observable_sources import PostgresObservableSourceRepository
    from opengeo_api.tenant_database import TenantContext, TenantTransaction

APPROVAL_SCHEMA = "opengeo.observable-input-distribution-approval.1.0.0"
REFERENCED_APPROVAL_SCHEMA = "opengeo.observable-input-distribution-approval.2.0.0"
OUTPUT_PROFILES = {"default-32m", "archive-96m"}
SIZE_ACKNOWLEDGMENT = "allow-up-to-96-mib-output"


async def _review_inputs(
    repository: PostgresObservableSourceRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    artifact_input_id: UUID | None,
) -> dict[str, Any]:
    repository._require(
        Action.SITE_MANAGE, await repository._project_roles(transaction, context, project_id)
    )
    project = await repository._load_project(transaction, context, project_id, source_id)
    revision = await repository._load_revision(
        transaction, context, project_id, source_id, revision_id
    )
    # Reuse the database's exact binding/access validator without reading bytes.
    with_references = (
        revision.manifest.get("schemaVersion") == "opengeo.observable-source-revision.3.0.0"
    )
    if with_references and artifact_input_id is not None:
        raise ObservableSourceConflict("observable_referenced_file_composition_unsupported")
    validator = (
        "app.validate_observable_revision_input_bindings"
        if with_references
        else "app.validate_observable_revision_data_bindings"
    )
    await transaction.fetch_one(
        f"SELECT {validator}(%s,%s,%s,%s)",
        (context.organization_id, project_id, source_id, Jsonb(revision.manifest)),
    )
    renderer = PostgresRenderRepository(repository._executor, UnavailableDownloadStorage())
    archive_files = []
    for pin in revision.manifest.get("dataAttachments", []):
        row = await transaction.fetch_one(
            """SELECT resource.id,resource.project_id,resource.current_version_id,
                      metadata.title,metadata.license,metadata.attribution
               FROM app.governed_resources resource
               JOIN app.governed_resource_versions metadata
                 ON metadata.organization_id=resource.organization_id
                 AND metadata.resource_id=resource.id AND metadata.id=resource.current_version_id
               WHERE resource.organization_id=%s AND resource.dataset_id=%s
                 AND resource.kind='dataset' AND resource.state<>'archived'""",
            (context.organization_id, UUID(pin["datasetId"])),
        )
        can_publish = False
        if row is not None:
            roles = await renderer._resource_roles(transaction, context, row[1], row[0])
            can_publish = is_allowed(Action.RESOURCE_PUBLISH, roles)
        archive_files.append(
            {
                **pin,
                "resource_id": str(row[0]) if row else None,
                "resource_version_id": str(row[2]) if row else None,
                "title": row[3] if row else pin["path"],
                "license": row[4] if row else None,
                "attribution": row[5] if row else None,
                "can_publish": can_publish,
            }
        )
    inputs = None
    referenced_files = []
    if with_references:
        pins = revision.manifest["referencedFiles"]
        rows = await transaction.fetch_all(
            """SELECT resource.id,resource.project_id,resource.current_version_id,
                      current_metadata.title,pinned_metadata.id,pinned_metadata.metadata_extensions,
                      app.observable_distribution_resource_can_publish(resource.id)
               FROM app.governed_resources resource
               JOIN app.governed_resource_versions current_metadata
                 ON current_metadata.organization_id=resource.organization_id
                 AND current_metadata.resource_id=resource.id
                 AND current_metadata.id=resource.current_version_id
               JOIN app.governed_resource_versions pinned_metadata
                 ON pinned_metadata.organization_id=resource.organization_id
                 AND pinned_metadata.resource_id=resource.id AND pinned_metadata.id=ANY(%s)
               WHERE resource.organization_id=%s AND resource.id=ANY(%s)
                 AND resource.kind='dataset' AND resource.state<>'archived'""",
            (
                [UUID(pin["resourceVersionId"]) for pin in pins],
                context.organization_id,
                [UUID(pin["resourceId"]) for pin in pins],
            ),
        )
        facts = {(str(row[0]), str(row[4])): row for row in rows}
        for pin in pins:
            row = facts.get((pin["resourceId"], pin["resourceVersionId"]))
            distribution = {}
            can_publish = False
            if row is not None:
                can_publish = row[6]
                distribution = next(
                    (
                        item
                        for item in row[5].get("opengeo", {}).get("distributions", [])
                        if item.get("identifier") == pin["distributionId"]
                    ),
                    {},
                )
            # Terms belong to the selected distribution. Missing terms remain
            # unknown even when the actor has independent publication authority.
            referenced_files.append(
                {
                    **pin,
                    "title": row[3] if row else pin["path"],
                    "current_resource_version_id": str(row[2]) if row else None,
                    "license": distribution.get("license")
                    if isinstance(distribution.get("license"), str)
                    else None,
                    "attribution": distribution.get("attribution")
                    if isinstance(distribution.get("attribution"), str)
                    else None,
                    "can_publish": can_publish,
                }
            )
    artifacts = []
    if artifact_input_id is not None:
        inputs = await read_inputs_in_transaction(
            repository, transaction, context, project_id, source_id, artifact_input_id
        )
        if inputs["manifest"]["sourceRevisionId"] != str(revision_id):
            raise ObservableSourceConflict("publication_artifact_source_revision_mismatch")
        for pin in inputs["manifest"]["artifacts"]:
            row = await transaction.fetch_one(
                """SELECT resource.id,resource.project_id,resource.current_version_id
                   FROM app.project_artifacts artifact
                   JOIN app.governed_resources resource
                     ON resource.organization_id=artifact.organization_id
                     AND resource.id=artifact.resource_id AND resource.state<>'archived'
                   WHERE artifact.organization_id=%s AND artifact.id=%s""",
                (context.organization_id, UUID(pin["artifactId"])),
            )
            if row is None:
                raise ObservableSourceConflict("publication_artifact_unavailable")
            roles = await renderer._resource_roles(transaction, context, row[1], row[0])
            releases = await transaction.fetch_all(
                """SELECT id,license,attribution,revoked_at FROM app.project_artifact_releases
                   WHERE organization_id=%s AND artifact_id=%s AND version_number=%s
                   ORDER BY created_at DESC,id DESC LIMIT 25""",
                (context.organization_id, UUID(pin["artifactId"]), pin["version"]),
            )
            artifacts.append(
                {
                    "artifact_id": pin["artifactId"],
                    "version": pin["version"],
                    "path": pin["path"],
                    "manifest_checksum_sha256": pin["manifestChecksumSha256"],
                    "output": pin["output"],
                    "resource_id": str(row[0]),
                    "project_id": str(row[1]),
                    "resource_version_id": str(row[2]),
                    "can_publish": is_allowed(Action.RESOURCE_PUBLISH, roles),
                    "releases": [
                        dict(zip(("id", "license", "attribution", "revoked_at"), item, strict=True))
                        for item in releases
                    ],
                }
            )
    return {
        "source_revision_id": str(revision_id),
        "source_manifest_checksum_sha256": revision.manifest_checksum_sha256,
        "compiler_image_digest": project.compiler_image_digest,
        "archive_files": archive_files,
        **({"referenced_files": referenced_files} if with_references else {}),
        "artifacts": artifacts,
        "artifact_inputs": inputs,
        "artifact_input_id": str(artifact_input_id) if artifact_input_id else None,
        "artifact_inputs_checksum_sha256": inputs["manifest_checksum_sha256"] if inputs else None,
        "output_profile": "default-32m",
    }


async def review_distribution_inputs(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    artifact_input_id: UUID | None,
    build_job_id: UUID | None = None,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        selected_input_id = artifact_input_id
        output_profile = "default-32m"
        if build_job_id is not None:
            if artifact_input_id is not None:
                raise ObservableSourceConflict("observable_distribution_selection_ambiguous")
            job = await repository._load_build_job(transaction, context, project_id, build_job_id)
            if job.source_project_id != source_id or job.source_revision_id != revision_id:
                raise ObservableSourceConflict("observable_distribution_build_revision_mismatch")
            output_profile = job.request.get("outputProfile", "default-32m")
            checksum = job.request.get("artifactInputsChecksumSha256")
            if checksum is not None:
                row = await transaction.fetch_one(
                    """SELECT id FROM app.publication_artifact_inputs WHERE organization_id=%s
                       AND source_project_id=%s AND source_revision_id=%s
                       AND manifest_checksum_sha256=%s""",
                    (context.organization_id, source_id, revision_id, checksum),
                )
                if row is None:
                    raise ObservableSourceConflict("publication_artifact_inputs_unavailable")
                selected_input_id = row[0]
        review = await _review_inputs(
            repository, transaction, context, project_id, source_id, revision_id, selected_input_id
        )
        if (
            build_job_id is not None
            and job.request["compilerImageDigest"] != review["compiler_image_digest"]
        ):
            raise ObservableSourceConflict("observable_distribution_build_compiler_changed")
        review["output_profile"] = output_profile
        rows = await transaction.fetch_all(
            """SELECT approval.id,approval.manifest,approval.manifest_checksum_sha256,
                      EXISTS(SELECT 1 FROM app.observable_distribution_approval_revocations revoked
                        WHERE revoked.organization_id=approval.organization_id
                          AND revoked.approval_id=approval.id)
               FROM app.observable_input_distribution_approvals approval
               WHERE approval.organization_id=%s AND approval.source_project_id=%s
                 AND approval.source_revision_id=%s
               ORDER BY approval.created_at DESC,approval.id DESC LIMIT 10""",
            (context.organization_id, source_id, revision_id),
        )
        review.pop("artifact_inputs")
        review["approvals"] = [
            dict(zip(("id", "manifest", "manifest_checksum_sha256", "revoked"), row, strict=True))
            for row in rows
        ]
        return review

    return await repository._run(context, operation)


async def create_distribution_approval(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    artifact_input_id: UUID | None,
    output_profile: str,
    archive_rights: list[dict[str, Any]],
    artifact_releases: list[dict[str, Any]],
    approval_id: UUID,
    *,
    referenced_rights: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        review = await _review_inputs(
            repository, transaction, context, project_id, source_id, revision_id, artifact_input_id
        )
        reference_files = review.get("referenced_files", [])
        if not review["archive_files"] and not review["artifacts"] and not reference_files:
            raise ObservableSourceConflict("observable_distribution_inputs_empty")
        if output_profile not in OUTPUT_PROFILES or (
            output_profile == "archive-96m" and not (review["archive_files"] or reference_files)
        ):
            raise ObservableSourceConflict("observable_output_profile_invalid")
        selected = {
            (str(item["attachment_id"]), item["relative_path"]): item for item in archive_rights
        }
        expected = {(pin["attachmentId"], pin["path"]) for pin in review["archive_files"]}
        if len(selected) != len(archive_rights) or set(selected) != expected:
            raise ObservableSourceConflict("observable_distribution_exact_archive_rights_required")
        rights = []
        for pin in review["archive_files"]:
            item = selected[(pin["attachmentId"], pin["path"])]
            if not pin["can_publish"]:
                raise ObservableSourceConflict(
                    "observable_distribution_dataset_publication_authority_required"
                )
            if (
                item["license"] not in PUBLIC_SAVED_MAP_LICENSES
                or not item["attribution"].strip()
                or item["acknowledgment"] != "publish-exact-archive-file"
            ):
                raise ObservableSourceConflict("observable_distribution_archive_rights_required")
            rights.append(
                {
                    "path": pin["path"],
                    "attachmentId": pin["attachmentId"],
                    "resourceId": pin["resource_id"],
                    "resourceVersionId": pin["resource_version_id"],
                    "license": item["license"],
                    "attribution": item["attribution"],
                    "acknowledgment": item["acknowledgment"],
                }
            )
        selected_references = {
            (str(item["reference_id"]), item["relative_path"]): item
            for item in referenced_rights or []
        }
        if len(selected_references) != len(referenced_rights or []) or set(selected_references) != {
            (pin["referenceId"], pin["path"]) for pin in reference_files
        }:
            raise ObservableSourceConflict(
                "observable_distribution_exact_reference_rights_required"
            )
        reference_rights = []
        for pin in reference_files:
            item = selected_references[(pin["referenceId"], pin["path"])]
            if not pin["can_publish"] or pin["current_resource_version_id"] is None:
                raise ObservableSourceConflict(
                    "observable_distribution_reference_publication_authority_required"
                )
            if (
                item["license"] not in PUBLIC_SAVED_MAP_LICENSES
                or not 1 <= len(item["attribution"].strip()) <= 2000
                or item["acknowledgment"] != "publish-exact-referenced-file"
            ):
                raise ObservableSourceConflict("observable_distribution_reference_rights_required")
            reference_rights.append(
                {
                    "referenceId": pin["referenceId"],
                    "path": pin["path"],
                    "resourceId": pin["resourceId"],
                    "resourceVersionId": pin["current_resource_version_id"],
                    "distributionId": pin["distributionId"],
                    "license": item["license"],
                    "attribution": item["attribution"],
                    "acknowledgment": item["acknowledgment"],
                }
            )
        chosen: dict[tuple[str, int], dict[str, Any]] = {}
        for item in artifact_releases:
            key = (str(item["artifact_id"]), item["version"])
            if key in chosen and chosen[key] != item:
                raise ObservableSourceConflict("observable_distribution_artifact_release_conflict")
            chosen[key] = item
        if set(chosen) != {(pin["artifact_id"], pin["version"]) for pin in review["artifacts"]}:
            raise ObservableSourceConflict(
                "observable_distribution_exact_artifact_releases_required"
            )
        renderer = PostgresRenderRepository(repository._executor, UnavailableDownloadStorage())
        artifact_pins = []
        inputs = review["artifact_inputs"]
        for pin, facts in zip(
            inputs["manifest"]["artifacts"] if inputs else [], review["artifacts"], strict=True
        ):
            selection = chosen[(pin["artifactId"], pin["version"])]
            if not facts["can_publish"]:
                raise ObservableSourceConflict(
                    "observable_distribution_artifact_publication_authority_required"
                )
            try:
                release, target = await read_release(
                    renderer,
                    context.organization_id,
                    selection["release_id"],
                    transaction=transaction,
                )
            except (RenderNotFound, RenderConflict, RenderAccessDenied) as error:
                raise ObservableSourceConflict(
                    "observable_distribution_artifact_public_release_required"
                ) from error
            if (
                release["artifact_id"] != pin["artifactId"]
                or release["version_number"] != pin["version"]
                or selection["acknowledgment"] != "publish-exact-map-artifact"
            ):
                raise ObservableSourceConflict("observable_distribution_artifact_release_mismatch")
            managed, referenced, _ = _requested_sources(target[13], target[15])
            sources = []
            for dependency in [*managed, *referenced]:
                source = await transaction.fetch_one(
                    """SELECT resource.id,resource.current_version_id
                       FROM app.governed_resources resource
                       WHERE resource.organization_id=%s AND resource.project_id=%s
                         AND resource.dataset_id=%s
                         AND resource.kind='dataset' AND resource.state='published'
                         AND resource.visibility='public'""",
                    (context.organization_id, target[2], UUID(dependency["dataset_id"])),
                )
                if source is None:
                    raise ObservableSourceConflict(
                        "observable_distribution_artifact_sources_changed"
                    )
                sources.append(
                    {
                        "resourceId": str(source[0]),
                        "resourceVersionId": str(source[1]),
                        "datasetId": dependency["dataset_id"],
                        "datasetVersionId": dependency.get("version_id"),
                        "sourceVersion": dependency["version_number"],
                    }
                )
            artifact_pins.append(
                {
                    **pin,
                    "releaseId": str(selection["release_id"]),
                    "resourceId": facts["resource_id"],
                    "resourceVersionId": facts["resource_version_id"],
                    "license": release["license"],
                    "attribution": release["attribution"],
                    "acknowledgment": selection["acknowledgment"],
                    "sourceResources": sources,
                }
            )
        manifest = {
            "schemaVersion": REFERENCED_APPROVAL_SCHEMA if reference_files else APPROVAL_SCHEMA,
            "organizationId": str(context.organization_id),
            "projectId": str(project_id),
            "sourceProjectId": str(source_id),
            "sourceRevisionId": str(revision_id),
            "sourceManifestChecksumSha256": review["source_manifest_checksum_sha256"],
            "compilerImageDigest": review["compiler_image_digest"],
            "outputProfile": output_profile,
            "artifactInputsChecksumSha256": inputs["manifest_checksum_sha256"] if inputs else None,
            "dataAttachments": [
                dict(
                    (key, pin[key])
                    for key in (
                        "path",
                        "attachmentId",
                        "datasetId",
                        "datasetVersionId",
                        "dataObjectId",
                        "s3VersionId",
                        "checksumSha256",
                        "sizeBytes",
                        "contentType",
                    )
                )
                for pin in review["archive_files"]
            ],
            "archiveRights": rights,
            "artifacts": artifact_pins,
        }
        if reference_files:
            review_keys = {
                "title",
                "current_resource_version_id",
                "license",
                "attribution",
                "can_publish",
            }
            manifest["referencedFiles"] = [
                {key: value for key, value in pin.items() if key not in review_keys}
                for pin in reference_files
            ]
            manifest["referenceRights"] = reference_rights
        row = await transaction.fetch_one(
            """INSERT INTO app.observable_input_distribution_approvals
               (organization_id,id,project_id,source_project_id,source_revision_id,manifest,manifest_checksum_sha256,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (organization_id,id) DO NOTHING
               RETURNING id,manifest_checksum_sha256""",
            (
                context.organization_id,
                approval_id,
                project_id,
                source_id,
                revision_id,
                Jsonb(manifest),
                "0" * 64,
                context.user_id,
            ),
        )
        reused = row is None
        if reused:
            row = await transaction.fetch_one(
                """SELECT id,manifest_checksum_sha256
                   FROM app.observable_input_distribution_approvals
                   WHERE organization_id=%s AND id=%s AND project_id=%s
                     AND source_project_id=%s
                     AND source_revision_id=%s AND created_by=%s AND manifest=%s
                     AND app.observable_distribution_approval_is_current(id)""",
                (
                    context.organization_id,
                    approval_id,
                    project_id,
                    source_id,
                    revision_id,
                    context.user_id,
                    Jsonb(manifest),
                ),
            )
        if row is None:
            raise ObservableSourceConflict("observable_distribution_approval_unavailable")
        return {
            "id": str(row[0]),
            "manifest": manifest,
            "manifest_checksum_sha256": row[1],
            "revoked": False,
            "reused": reused,
        }

    return await repository._run(context, operation)


async def read_distribution_approval(
    repository: PostgresObservableSourceRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    approval_id: UUID,
    compiler_digest: str,
    output_profile: str,
    artifact_checksum: str | None,
) -> dict[str, Any]:
    row = await transaction.fetch_one(
        """SELECT manifest,manifest_checksum_sha256 FROM app.observable_input_distribution_approvals
           WHERE organization_id=%s AND project_id=%s AND source_project_id=%s
             AND source_revision_id=%s
             AND id=%s AND app.observable_distribution_approval_is_current(id)""",
        (context.organization_id, project_id, source_id, revision_id, approval_id),
    )
    if row is None:
        raise ObservableSourceConflict("observable_distribution_approval_revoked_or_unavailable")
    manifest = row[0]
    if (
        manifest["compilerImageDigest"] != compiler_digest
        or manifest["outputProfile"] != output_profile
        or manifest["artifactInputsChecksumSha256"] != artifact_checksum
    ):
        raise ObservableSourceConflict("observable_distribution_approval_input_mismatch")
    renderer = PostgresRenderRepository(repository._executor, UnavailableDownloadStorage())
    for artifact in manifest["artifacts"]:
        try:
            await read_release(
                renderer,
                context.organization_id,
                UUID(artifact["releaseId"]),
                transaction=transaction,
            )
        except (RenderNotFound, RenderConflict, RenderAccessDenied) as error:
            raise ObservableSourceConflict(
                "observable_distribution_artifact_public_release_required"
            ) from error
    return {"id": str(approval_id), "manifest": manifest, "manifest_checksum_sha256": row[1]}


async def revoke_distribution_approval(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    approval_id: UUID,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.SITE_MANAGE, await repository._project_roles(transaction, context, project_id)
        )
        row = await transaction.fetch_one(
            """SELECT id FROM app.observable_input_distribution_approvals
               WHERE organization_id=%s AND project_id=%s AND source_project_id=%s
             AND source_revision_id=%s AND id=%s""",
            (context.organization_id, project_id, source_id, revision_id, approval_id),
        )
        if row is None:
            raise ObservableSourceConflict("observable_distribution_approval_unavailable")
        await transaction.execute(
            """INSERT INTO app.observable_distribution_approval_revocations
               (organization_id,approval_id,revoked_by)
               VALUES (%s,%s,%s) ON CONFLICT (organization_id,approval_id) DO NOTHING""",
            (context.organization_id, approval_id, context.user_id),
        )
        return {"id": str(approval_id), "revoked": True}

    return await repository._run(context, operation)
