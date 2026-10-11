"""A live coordinator token authenticates its actor; source permissions remain live."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from opengeo_api.tenant_database import TenantContext, TenantTransaction

if TYPE_CHECKING:
    from opengeo_api.observable_sources import PostgresObservableSourceRepository

from opengeo_api.authorization import Action
from opengeo_api.observable_sources import ObservableSourceConflict
from opengeo_api.publication_artifact_inputs import read_inputs_in_transaction


async def resolve_artifact_lease(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    job_id: UUID,
    token: UUID,
) -> list[dict[str, Any]]:
    if not repository._artifact_builds:
        raise ObservableSourceConflict("publication_artifact_staging_unavailable")

    async def operation(transaction: TenantTransaction) -> list[dict[str, Any]]:
        row = await transaction.fetch_one(
            """SELECT project_id,source_project_id,input_id
               FROM app.lock_observable_artifact_lease(%s,%s,%s,%s)""",
            (context.organization_id, context.user_id, job_id, token),
        )
        if row is None:
            raise ObservableSourceConflict("publication_artifact_lease_unavailable")
        project_id, source_id, input_id = row
        repository._require(
            Action.SITE_MANAGE, await repository._project_roles(transaction, context, project_id)
        )
        job = await repository._load_build_job(transaction, context, project_id, job_id)
        await reauthorize_artifact_request(
            repository,
            transaction,
            context,
            project_id,
            source_id,
            job.source_revision_id,
            job.request,
        )
        inputs = await read_inputs_in_transaction(
            repository, transaction, context, project_id, source_id, input_id
        )
        files = []
        for pin in inputs["manifest"]["artifacts"]:
            output = await transaction.fetch_one(
                """SELECT bucket,object_key,s3_version_id,etag,content_type,
                          size_bytes,checksum_sha256
                   FROM app.project_artifact_objects
                   WHERE organization_id=%s AND artifact_id=%s AND id=%s""",
                (context.organization_id, UUID(pin["artifactId"]), UUID(pin["outputObjectId"])),
            )
            if output is None or output[4:] != (
                "text/html",
                pin["output"]["sizeBytes"],
                pin["output"]["checksumSha256"],
            ):
                raise ObservableSourceConflict("publication_artifact_unavailable")
            files.append(
                {
                    "path": pin["path"],
                    "artifactId": pin["artifactId"],
                    "outputObjectId": pin["outputObjectId"],
                    **dict(
                        zip(
                            (
                                "bucket",
                                "objectKey",
                                "s3VersionId",
                                "etag",
                                "contentType",
                                "sizeBytes",
                                "checksumSha256",
                            ),
                            output,
                            strict=True,
                        )
                    ),
                }
            )
        return files

    return await repository._run(context, operation)


async def reauthorize_artifact_request(
    repository: PostgresObservableSourceRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    revision_id: UUID,
    request: dict[str, Any],
) -> None:
    if request.get("schemaVersion") not in {
        "opengeo.observable-build-request.2.0.0",
        "opengeo.observable-build-request.3.0.0",
        "opengeo.observable-build-request.4.0.0",
    }:
        return
    localized = request.get("schemaVersion") == "opengeo.observable-build-request.4.0.0"
    if localized and request.get("artifactInputsChecksumSha256") is not None:
        raise ObservableSourceConflict("observable_localized_artifact_unsupported")
    if request.get("schemaVersion") in {
        "opengeo.observable-build-request.3.0.0",
        "opengeo.observable-build-request.4.0.0",
    }:
        approval_id = request.get("distributionApprovalId")
        if approval_id is not None:
            from opengeo_api.observable_distribution_approvals import read_distribution_approval

            approval = await read_distribution_approval(
                repository,
                transaction,
                context,
                project_id,
                source_id,
                revision_id,
                UUID(approval_id),
                request["compilerImageDigest"],
                request["outputProfile"],
                request.get("artifactInputsChecksumSha256"),
            )
            if approval["manifest_checksum_sha256"] != request.get(
                "distributionApprovalChecksumSha256"
            ):
                raise ObservableSourceConflict("observable_distribution_approval_input_mismatch")
        elif request.get("purpose") != "preview" and not localized:
            raise ObservableSourceConflict("observable_distribution_approval_required")
        if request.get("artifactInputsChecksumSha256") is None:
            if localized and approval_id is None and request.get("purpose") != "preview":
                revision = await repository._load_revision(
                    transaction, context, project_id, source_id, revision_id
                )
                if revision.manifest.get("referencedFiles"):
                    raise ObservableSourceConflict(
                        "observable_referenced_file_publication_unavailable"
                    )
                if revision.manifest.get("dataAttachments"):
                    raise ObservableSourceConflict("observable_distribution_approval_required")
            return
    elif request.get("purpose") != "preview":
        raise ObservableSourceConflict("publication_artifact_release_unavailable")
    row = await transaction.fetch_one(
        """SELECT id FROM app.publication_artifact_inputs
           WHERE organization_id=%s AND source_project_id=%s AND source_revision_id=%s
             AND manifest_checksum_sha256=%s""",
        (
            context.organization_id,
            source_id,
            revision_id,
            request.get("artifactInputsChecksumSha256"),
        ),
    )
    if row is None:
        raise ObservableSourceConflict("publication_artifact_inputs_unavailable")
    await read_inputs_in_transaction(
        repository, transaction, context, project_id, source_id, row[0]
    )
