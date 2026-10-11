"""Authorize immutable file-version references; never fetch or copy attachment bytes."""

from typing import cast
from uuid import UUID

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    DatasetPermissionRole,
    ProjectRole,
    Roles,
    authorize,
)
from opengeo_api.tenant_database import TenantContext, TenantTransaction


async def authorize_attachment_versions(
    transaction: TenantTransaction,
    context: TenantContext,
    version_ids: set[UUID],
) -> None:
    if not version_ids:
        return
    if len(version_ids) > 64:
        raise ValueError("at most 64 distinct attachment versions may be linked per mutation")
    rows = await transaction.fetch_all(
        """
        SELECT version.id, membership.role::text,
               dataset.owner_user_id = %s, permission.role::text,
               (SELECT app.effective_project_role(link.project_id)::text
                FROM app.project_datasets link
                WHERE link.organization_id = dataset.organization_id
                  AND link.dataset_id = dataset.id
                  AND app.effective_project_role(link.project_id) IS NOT NULL
                ORDER BY CASE app.effective_project_role(link.project_id)
                    WHEN 'owner' THEN 1 WHEN 'editor' THEN 2
                    WHEN 'reviewer' THEN 3 WHEN 'viewer' THEN 4 END
                LIMIT 1)
        FROM app.dataset_versions version
        JOIN app.datasets dataset ON dataset.organization_id = version.organization_id
          AND dataset.id = version.dataset_id
        JOIN app.organization_memberships membership
          ON membership.organization_id = dataset.organization_id AND membership.user_id = %s
        LEFT JOIN app.dataset_permissions permission
          ON permission.organization_id = dataset.organization_id
          AND permission.dataset_id = dataset.id AND permission.user_id = %s
        WHERE version.organization_id = %s AND version.id = ANY(%s::uuid[])
          AND version.state::text = 'active' AND dataset.status::text = 'active'
        FOR SHARE OF dataset
        """,
        (
            context.user_id,
            context.user_id,
            context.user_id,
            context.organization_id,
            sorted(version_ids, key=str),
        ),
    )
    if {cast(UUID, row[0]) for row in rows} != version_ids:
        raise ValueError("attachment version is unavailable")
    for row in rows:
        authorize(
            Action.DATASET_READ,
            Roles(
                organization=cast(OrganizationRole, row[1]),
                dataset_owner=cast(bool, row[2]),
                dataset=cast(DatasetPermissionRole | None, row[3]),
                project=cast(ProjectRole | None, row[4]),
            ),
        )
