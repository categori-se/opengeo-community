"""Durable Publication authoring intent; never a storage URL or build authorization."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.observable_sources import (
    ObservableSourceConflict,
    validate_observable_source_file,
)
from opengeo_api.project_artifacts import _edition_manifest
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderAccessDenied,
    RenderConflict,
    RenderNotFound,
)
from opengeo_api.s3_downloads import UnavailableDownloadStorage
from opengeo_api.tenant_database import TenantTransactionExecutor

if TYPE_CHECKING:
    from opengeo_api.observable_sources import PostgresObservableSourceRepository
    from opengeo_api.tenant_database import TenantContext, TenantTransaction


def validate_references(references: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(references, list) or len(references) > 32:
        raise ObservableSourceConflict("publication_artifact_reference_limit")
    normalized = []
    for item in references:
        if not isinstance(item, dict) or set(item) != {"path", "artifact_id", "mode", "version"}:
            raise ObservableSourceConflict("publication_artifact_reference_invalid")
        path, mode, version = item["path"], item["mode"], item["version"]
        if not isinstance(path, str) or not path.endswith(".html"):
            raise ObservableSourceConflict("publication_artifact_path_invalid")
        validate_observable_source_file(path, "text/html", 1)
        if (
            mode not in {"current", "pinned"}
            or (mode == "current" and version is not None)
            or (mode == "pinned" and (type(version) is not int or not 1 <= version <= 2147483647))
        ):
            raise ObservableSourceConflict("publication_artifact_selection_invalid")
        try:
            artifact_id = str(UUID(item["artifact_id"]))
        except (ValueError, TypeError, AttributeError) as error:
            raise ObservableSourceConflict("publication_artifact_identity_invalid") from error
        normalized.append(
            {"path": path, "artifact_id": artifact_id, "mode": mode, "version": version}
        )
    paths = sorted(item["path"].casefold() for item in normalized)
    if any(
        b == a or b.startswith(a + "/") for index, a in enumerate(paths) for b in paths[index + 1 :]
    ):
        raise ObservableSourceConflict("publication_artifact_path_collision")
    return sorted(normalized, key=lambda item: item["path"])


async def latest_references(
    transaction: TenantTransaction, context: TenantContext, source_id: UUID
) -> dict[str, Any]:
    row = await transaction.fetch_one(
        """SELECT revision, references_json FROM app.publication_artifact_reference_sets
           WHERE organization_id = %s AND source_project_id = %s
           ORDER BY revision DESC LIMIT 1""",
        (context.organization_id, source_id),
    )
    return {"revision": row[0], "references": row[1]} if row else {"revision": 0, "references": []}


async def resolve_references(
    transaction: TenantTransaction,
    context: TenantContext,
    executor: TenantTransactionExecutor,
    references: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    renderer = PostgresRenderRepository(executor, UnavailableDownloadStorage())
    pins = []
    for item in references:
        row = await transaction.fetch_one(
            """SELECT artifact.resource_id, resource.project_id, artifact.current_version_number
               FROM app.project_artifacts artifact
               JOIN app.governed_resources resource
                 ON resource.organization_id=artifact.organization_id
                 AND resource.id=artifact.resource_id
               WHERE artifact.organization_id=%s AND artifact.id=%s
                 AND artifact.representation='portable-map-html' FOR SHARE OF artifact""",
            (context.organization_id, UUID(item["artifact_id"])),
        )
        if row is None:
            raise ObservableSourceConflict("publication_artifact_unavailable")
        try:
            renderer._require(
                Action.RENDER_READ,
                await renderer._resource_roles(transaction, context, row[1], row[0]),
            )
            version = row[2] if item["mode"] == "current" else item["version"]
            if version is None:
                raise ObservableSourceConflict("publication_artifact_current_unset")
            manifest = await _edition_manifest(
                renderer, transaction, context, row[1], row[0], UUID(item["artifact_id"]), version
            )
        except (RenderAccessDenied, RenderConflict, RenderNotFound) as error:
            raise ObservableSourceConflict("publication_artifact_unavailable") from error
        pins.append(
            {
                **item,
                "resolved_version": version,
                "manifest_checksum_sha256": manifest["manifestChecksumSha256"],
                "output": manifest["output"],
            }
        )
    return pins


async def artifact_backup_inputs(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    expected_reference_revision: int | None = None,
) -> dict[str, Any]:
    """Resolve saved intent for an explicit backup; never stage inputs or sign downloads."""
    if expected_reference_revision is not None and (
        type(expected_reference_revision) is not int
        or not 0 <= expected_reference_revision <= 2147483647
    ):
        raise ObservableSourceConflict("publication_artifact_revision_invalid")

    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.SITE_READ,
            await repository._project_roles(transaction, context, project_id),
        )
        await repository._load_project(transaction, context, project_id, source_id)
        latest = await latest_references(transaction, context, source_id)
        if (
            expected_reference_revision is not None
            and expected_reference_revision != latest["revision"]
        ):
            raise ObservableSourceConflict(
                "publication_artifact_revision_conflict", current_revision=latest["revision"]
            )
        references = validate_references(latest["references"])
        pins = await resolve_references(transaction, context, repository._executor, references)
        selected = list(
            dict.fromkeys((UUID(pin["artifact_id"]), pin["resolved_version"]) for pin in pins)
        )
        addresses = {}
        if selected:
            rows = await transaction.fetch_all(
                """SELECT artifact.id, resource.project_id, resource.id,
                          edition.version_number, edition.portable_object_id
                   FROM app.project_artifacts artifact
                   JOIN app.governed_resources resource
                     ON resource.organization_id=artifact.organization_id
                     AND resource.id=artifact.resource_id
                   JOIN app.project_artifact_versions edition
                     ON edition.organization_id=artifact.organization_id
                     AND edition.artifact_id=artifact.id
                   WHERE artifact.organization_id=%s
                     AND (artifact.id, edition.version_number) IN (
                       SELECT * FROM unnest(%s::uuid[], %s::integer[]))
                     AND artifact.representation='portable-map-html' LIMIT 32""",
                (
                    context.organization_id,
                    [artifact_id for artifact_id, _ in selected],
                    [version for _, version in selected],
                ),
            )
            addresses = {(row[0], row[3]): (row[1], row[2], row[4]) for row in rows}
            if set(addresses) != set(selected) or any(
                address[2] is None for address in addresses.values()
            ):
                raise ObservableSourceConflict("publication_artifact_unavailable")
        return {
            "schema_version": "opengeo.publication-artifact-backup-inputs.1.0.0",
            "project_id": str(project_id),
            "source_project_id": str(source_id),
            "reference_revision": latest["revision"],
            "pins": [
                {
                    **pin,
                    "project_id": str(
                        addresses[(UUID(pin["artifact_id"]), pin["resolved_version"])][0]
                    ),
                    "resource_id": str(
                        addresses[(UUID(pin["artifact_id"]), pin["resolved_version"])][1]
                    ),
                    # Retained portable manifests keep an inert null object ID;
                    # expose the validated stored edition ID only in backup metadata.
                    "output": {
                        **pin["output"],
                        "objectId": str(
                            addresses[(UUID(pin["artifact_id"]), pin["resolved_version"])][2]
                        ),
                    },
                }
                for pin in pins
            ],
        }

    return await repository._run(context, operation)


async def artifact_references(
    repository: PostgresObservableSourceRepository,
    context: TenantContext,
    project_id: UUID,
    source_id: UUID,
    references: list[dict[str, Any]] | None = None,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    writing = references is not None
    normalized = validate_references(references) if references is not None else None

    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.SITE_MANAGE if writing else Action.SITE_READ,
            await repository._project_roles(transaction, context, project_id),
        )
        await repository._load_project(transaction, context, project_id, source_id)
        if writing:
            await transaction.fetch_one(
                """SELECT id FROM app.observable_source_projects
                   WHERE organization_id=%s AND id=%s FOR UPDATE""",
                (context.organization_id, source_id),
            )
        latest = await latest_references(transaction, context, source_id)
        if normalized is None:
            return latest  # Metadata recovery does not disclose source manifests or bytes.
        if expected_revision != latest["revision"]:
            raise ObservableSourceConflict(
                "publication_artifact_revision_conflict", current_revision=latest["revision"]
            )
        await resolve_references(transaction, context, repository._executor, normalized)
        if latest["references"] == normalized:
            return latest
        revision = latest["revision"] + 1
        await transaction.execute(
            """INSERT INTO app.publication_artifact_reference_sets
               (organization_id,source_project_id,revision,references_json,created_by)
               VALUES (%s,%s,%s,%s,%s)""",
            (context.organization_id, source_id, revision, Jsonb(normalized), context.user_id),
        )
        return {"revision": revision, "references": normalized}

    return await repository._run(context, operation)
