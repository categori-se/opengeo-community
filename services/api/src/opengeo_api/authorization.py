from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from opengeo_api.auth_models import OrganizationRole

ProjectRole = Literal["owner", "editor", "reviewer", "viewer"]
TeamRole = Literal["owner", "manager", "member"]
DatasetPermissionRole = Literal["manage", "edit", "view", "download"]
ResourcePermissionRole = Literal["manage", "edit", "publish", "view"]


class Action(StrEnum):
    ORGANIZATION_MEMBERS_READ = "organization.members.read"
    ORGANIZATION_MEMBERS_MANAGE = "organization.members.manage"
    MEMBERSHIP_INVITATIONS_MANAGE = "membership.invitations.manage"
    CLIENT_READ = "client.read"
    CLIENT_CREATE = "client.create"
    CLIENT_UPDATE = "client.update"
    PROJECT_LIST = "project.list"
    PROJECT_READ = "project.read"
    PROJECT_CREATE = "project.create"
    PROJECT_UPDATE = "project.update"
    PROJECT_DATASETS_MANAGE = "project.datasets.manage"
    PROJECT_MEMBERS_READ = "project.members.read"
    PROJECT_MEMBERS_MANAGE = "project.members.manage"
    PROJECT_TEAMS_READ = "project.teams.read"
    PROJECT_TEAMS_MANAGE = "project.teams.manage"
    PROJECT_DISCUSSIONS_READ = "project.discussions.read"
    PROJECT_DISCUSSIONS_COMMENT = "project.discussions.comment"
    PROJECT_DISCUSSIONS_MODERATE = "project.discussions.moderate"
    TEAM_LIST = "team.list"
    TEAM_READ = "team.read"
    TEAM_CREATE = "team.create"
    TEAM_MEMBERS_MANAGE = "team.members.manage"
    MAP_READ = "map.read"
    MAP_CREATE = "map.create"
    MAP_UPDATE = "map.update"
    DATASET_LIST = "dataset.list"
    DATASET_READ = "dataset.read"
    DATASET_UPLOAD = "dataset.upload"
    DATASET_SOURCE_CREATE = "dataset.source.create"
    DATASET_SOURCE_READ = "dataset.source.read"
    DATASET_SOURCE_UPDATE = "dataset.source.update"
    DATASET_VERSION_READ = "dataset.version.read"
    DATASET_EDIT = "dataset.edit"
    DATASET_DOWNLOAD = "dataset.download"
    DATASET_PERMISSIONS_READ = "dataset.permissions.read"
    DATASET_PERMISSIONS_MANAGE = "dataset.permissions.manage"
    CONNECTION_READ = "connection.read"
    CONNECTION_MANAGE = "connection.manage"
    FIELD_FORM_MANAGE = "field.form.manage"
    FIELD_SUBMISSION_CREATE = "field.submission.create"
    FIELD_SUBMISSION_READ = "field.submission.read"
    FIELD_SUBMISSION_REVIEW = "field.submission.review"
    SPATIAL_SERVICE_READ = "spatial.service.read"
    SPATIAL_SERVICE_MANAGE = "spatial.service.manage"
    SITE_READ = "site.read"
    SITE_MANAGE = "site.manage"
    SITE_PUBLISH = "site.publish"
    RESOURCE_READ = "resource.read"
    RESOURCE_CREATE = "resource.create"
    RESOURCE_UPDATE = "resource.update"
    RESOURCE_PUBLISH = "resource.publish"
    RESOURCE_PERMISSIONS_READ = "resource.permissions.read"
    RESOURCE_PERMISSIONS_MANAGE = "resource.permissions.manage"
    METADATA_PROFILE_READ = "metadata.profile.read"
    METADATA_PROFILE_MANAGE = "metadata.profile.manage"
    RENDER_READ = "render.read"
    RENDER_CONFIGURE = "render.configure"
    RENDER_REQUEST = "render.request"


class AuthorizationDenied(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Roles:
    organization: OrganizationRole
    project: ProjectRole | None = None
    dataset: DatasetPermissionRole | None = None
    dataset_owner: bool = False
    resource: ResourcePermissionRole | None = None
    resource_owner: bool = False
    team: TeamRole | None = None


_PROJECT_ROLES = frozenset({"owner", "editor", "reviewer", "viewer"})


def is_allowed(action: Action, roles: Roles) -> bool:
    """Return one auditable M1 role decision; resource scope is checked separately."""

    if roles.organization == "admin":
        return True

    if action == Action.ORGANIZATION_MEMBERS_READ:
        return roles.organization == "member"

    if action == Action.METADATA_PROFILE_READ:
        return roles.organization == "member"

    if action in {
        Action.ORGANIZATION_MEMBERS_MANAGE,
        Action.MEMBERSHIP_INVITATIONS_MANAGE,
        Action.METADATA_PROFILE_MANAGE,
    }:
        return False

    if action == Action.CLIENT_READ:
        return roles.organization == "member"

    if action in {
        Action.CLIENT_CREATE,
        Action.CLIENT_UPDATE,
        Action.PROJECT_CREATE,
        Action.TEAM_CREATE,
    }:
        return False

    if action == Action.PROJECT_LIST:
        return roles.organization in {"member", "guest"}

    if action == Action.TEAM_LIST:
        return roles.organization in {"member", "guest"}

    if action == Action.TEAM_READ:
        return roles.team in {"owner", "manager", "member"}

    if action == Action.TEAM_MEMBERS_MANAGE:
        return roles.team in {"owner", "manager"}

    if action in {
        Action.PROJECT_READ,
        Action.PROJECT_MEMBERS_READ,
        Action.MAP_READ,
        Action.SPATIAL_SERVICE_READ,
        Action.SITE_READ,
        Action.CONNECTION_READ,
        Action.PROJECT_TEAMS_READ,
        Action.PROJECT_DISCUSSIONS_READ,
        Action.PROJECT_DISCUSSIONS_COMMENT,
    }:
        return roles.project in _PROJECT_ROLES

    if action in {Action.RESOURCE_READ, Action.RENDER_READ}:
        return (
            roles.resource_owner
            or roles.project in _PROJECT_ROLES
            or roles.resource in {"manage", "edit", "publish", "view"}
        )

    if action in {
        Action.DATASET_LIST,
        Action.DATASET_READ,
        Action.DATASET_VERSION_READ,
        Action.DATASET_SOURCE_READ,
        Action.FIELD_SUBMISSION_READ,
    }:
        return (
            roles.dataset_owner
            or roles.project in _PROJECT_ROLES
            or roles.dataset in {"manage", "edit", "view", "download"}
        )

    if action == Action.PROJECT_UPDATE:
        return roles.project == "owner"

    if action == Action.PROJECT_MEMBERS_MANAGE:
        return roles.project == "owner"

    if action == Action.PROJECT_TEAMS_MANAGE:
        return roles.project == "owner"

    if action == Action.PROJECT_DISCUSSIONS_MODERATE:
        return roles.project in {"owner", "editor", "reviewer"}

    if action == Action.PROJECT_DATASETS_MANAGE:
        return roles.project in {"owner", "editor"}

    if action == Action.CONNECTION_MANAGE:
        return roles.project == "owner"

    if action in {Action.MAP_CREATE, Action.MAP_UPDATE}:
        return roles.project in {"owner", "editor"}

    if action == Action.SPATIAL_SERVICE_MANAGE:
        return roles.project in {"owner", "editor"}

    if action == Action.SITE_MANAGE:
        return roles.project in {"owner", "editor"}

    if action == Action.SITE_PUBLISH:
        return roles.project in {"owner", "reviewer"}

    if action == Action.RESOURCE_CREATE:
        return roles.project in {"owner", "editor"}

    if action in {Action.RESOURCE_UPDATE, Action.RENDER_CONFIGURE}:
        return (
            roles.resource_owner
            or roles.project in {"owner", "editor"}
            or roles.resource in {"manage", "edit"}
        )

    if action == Action.RENDER_REQUEST:
        return (
            roles.resource_owner
            or roles.project in {"owner", "editor"}
            or roles.resource in {"manage", "edit", "publish"}
        )

    if action == Action.RESOURCE_PUBLISH:
        return roles.project == "owner" or roles.resource in {"manage", "publish"}

    if action in {Action.RESOURCE_PERMISSIONS_READ, Action.RESOURCE_PERMISSIONS_MANAGE}:
        return roles.project == "owner" or roles.resource == "manage" or roles.resource_owner

    if action in {Action.DATASET_UPLOAD, Action.DATASET_SOURCE_CREATE}:
        return roles.project in {"owner", "editor"}

    if action == Action.DATASET_DOWNLOAD:
        return (
            roles.dataset_owner
            or roles.project in {"owner", "editor"}
            or roles.dataset in {"manage", "edit", "download"}
        )

    if action in {
        Action.DATASET_EDIT,
        Action.DATASET_SOURCE_UPDATE,
        Action.FIELD_FORM_MANAGE,
        Action.FIELD_SUBMISSION_CREATE,
    }:
        return (
            roles.dataset_owner
            or roles.project in {"owner", "editor"}
            or roles.dataset in {"manage", "edit"}
        )

    if action == Action.FIELD_SUBMISSION_REVIEW:
        return (
            roles.dataset_owner
            or roles.project in {"owner", "editor", "reviewer"}
            or roles.dataset in {"manage", "edit"}
        )

    if action in {Action.DATASET_PERMISSIONS_READ, Action.DATASET_PERMISSIONS_MANAGE}:
        return roles.project == "owner" or roles.dataset == "manage" or roles.dataset_owner


def authorize(action: Action, roles: Roles) -> None:
    if not is_allowed(action, roles):
        raise AuthorizationDenied(action)
