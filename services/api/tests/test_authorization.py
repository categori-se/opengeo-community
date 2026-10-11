import pytest

from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize, is_allowed


@pytest.mark.parametrize("action", list(Action))
def test_organization_admin_can_perform_every_m1_action(action: Action) -> None:
    assert is_allowed(action, Roles("admin")) is True


@pytest.mark.parametrize(
    ("action", "organization_role", "project_role", "allowed"),
    [
        (Action.ORGANIZATION_MEMBERS_READ, "member", None, True),
        (Action.ORGANIZATION_MEMBERS_READ, "guest", None, False),
        (Action.ORGANIZATION_MEMBERS_MANAGE, "member", None, False),
        (Action.MEMBERSHIP_INVITATIONS_MANAGE, "guest", "owner", False),
        (Action.CLIENT_READ, "member", None, True),
        (Action.CLIENT_READ, "guest", None, False),
        (Action.CLIENT_CREATE, "member", None, False),
        (Action.CLIENT_UPDATE, "member", None, False),
        (Action.PROJECT_LIST, "member", None, True),
        (Action.PROJECT_LIST, "guest", None, True),
        (Action.PROJECT_CREATE, "member", None, False),
        (Action.PROJECT_READ, "member", None, False),
        (Action.PROJECT_READ, "guest", "viewer", True),
        (Action.PROJECT_UPDATE, "member", "owner", True),
        (Action.PROJECT_UPDATE, "member", "editor", False),
        (Action.PROJECT_DATASETS_MANAGE, "member", "owner", True),
        (Action.PROJECT_DATASETS_MANAGE, "member", "editor", True),
        (Action.PROJECT_DATASETS_MANAGE, "member", "reviewer", False),
        (Action.PROJECT_MEMBERS_READ, "guest", "reviewer", True),
        (Action.PROJECT_MEMBERS_MANAGE, "member", "owner", True),
        (Action.PROJECT_MEMBERS_MANAGE, "member", "editor", False),
        (Action.PROJECT_DISCUSSIONS_READ, "guest", "viewer", True),
        (Action.PROJECT_DISCUSSIONS_COMMENT, "guest", "viewer", True),
        (Action.PROJECT_DISCUSSIONS_MODERATE, "member", "reviewer", True),
        (Action.PROJECT_DISCUSSIONS_MODERATE, "member", "viewer", False),
        (Action.MAP_READ, "guest", "viewer", True),
        (Action.MAP_CREATE, "member", "owner", True),
        (Action.MAP_CREATE, "member", "editor", True),
        (Action.MAP_CREATE, "member", "reviewer", False),
        (Action.MAP_UPDATE, "guest", "editor", True),
        (Action.MAP_UPDATE, "guest", "viewer", False),
        (Action.DATASET_LIST, "guest", "viewer", True),
        (Action.DATASET_READ, "member", "reviewer", True),
        (Action.DATASET_UPLOAD, "member", "owner", True),
        (Action.DATASET_UPLOAD, "guest", "editor", True),
        (Action.DATASET_UPLOAD, "member", "reviewer", False),
        (Action.DATASET_UPLOAD, "guest", "viewer", False),
        (Action.DATASET_SOURCE_CREATE, "member", "editor", True),
        (Action.DATASET_SOURCE_CREATE, "member", "reviewer", False),
        (Action.DATASET_SOURCE_READ, "guest", "viewer", True),
        (Action.DATASET_SOURCE_UPDATE, "guest", "editor", True),
        (Action.DATASET_SOURCE_UPDATE, "guest", "viewer", False),
        (Action.CONNECTION_READ, "guest", "viewer", True),
        (Action.CONNECTION_READ, "member", None, False),
        (Action.CONNECTION_MANAGE, "member", "owner", True),
        (Action.CONNECTION_MANAGE, "member", "editor", False),
        (Action.RESOURCE_READ, "guest", "viewer", True),
        (Action.RESOURCE_CREATE, "member", "editor", True),
        (Action.RESOURCE_CREATE, "member", "reviewer", False),
        (Action.RESOURCE_UPDATE, "guest", "owner", True),
        (Action.RESOURCE_UPDATE, "guest", "viewer", False),
        (Action.RESOURCE_PUBLISH, "member", "owner", True),
        (Action.RESOURCE_PUBLISH, "member", "editor", False),
        (Action.RESOURCE_PERMISSIONS_READ, "member", "owner", True),
        (Action.RESOURCE_PERMISSIONS_MANAGE, "member", "editor", False),
    ],
)
def test_non_admin_matrix(
    action: Action,
    organization_role: str,
    project_role: str | None,
    allowed: bool,
) -> None:
    roles = Roles(organization_role, project_role)  # type: ignore[arg-type]
    assert is_allowed(action, roles) is allowed

    if allowed:
        authorize(action, roles)
    else:
        with pytest.raises(AuthorizationDenied):
            authorize(action, roles)


@pytest.mark.parametrize(
    "action",
    [
        Action.DATASET_LIST,
        Action.DATASET_READ,
        Action.DATASET_VERSION_READ,
        Action.DATASET_SOURCE_READ,
        Action.DATASET_SOURCE_UPDATE,
        Action.DATASET_EDIT,
        Action.DATASET_DOWNLOAD,
        Action.DATASET_PERMISSIONS_READ,
        Action.DATASET_PERMISSIONS_MANAGE,
    ],
)
def test_dataset_owner_has_the_manage_baseline_without_a_project_role(action: Action) -> None:
    assert is_allowed(action, Roles("member", dataset_owner=True)) is True


def test_dataset_ownership_does_not_grant_project_upload_authority() -> None:
    assert is_allowed(Action.DATASET_UPLOAD, Roles("member", dataset_owner=True)) is False
    assert is_allowed(Action.DATASET_SOURCE_CREATE, Roles("member", dataset_owner=True)) is False


@pytest.mark.parametrize(
    ("role", "read", "update", "publish", "manage"),
    [
        ("view", True, False, False, False),
        ("edit", True, True, False, False),
        ("publish", True, False, True, False),
        ("manage", True, True, True, True),
    ],
)
def test_explicit_resource_grants_are_independent_and_least_privilege(
    role: str, read: bool, update: bool, publish: bool, manage: bool
) -> None:
    roles = Roles("member", resource=role)  # type: ignore[arg-type]
    assert is_allowed(Action.RESOURCE_READ, roles) is read
    assert is_allowed(Action.RESOURCE_UPDATE, roles) is update
    assert is_allowed(Action.RESOURCE_PUBLISH, roles) is publish
    assert is_allowed(Action.RESOURCE_PERMISSIONS_MANAGE, roles) is manage


def test_resource_owner_manages_but_project_editor_cannot_publish_by_default() -> None:
    assert is_allowed(Action.RESOURCE_PERMISSIONS_MANAGE, Roles("member", resource_owner=True))
    assert is_allowed(Action.RESOURCE_PUBLISH, Roles("member", project="editor")) is False


def test_team_membership_and_project_grants_remain_separate_authorization_axes() -> None:
    assert is_allowed(Action.TEAM_LIST, Roles("member")) is True
    assert is_allowed(Action.TEAM_CREATE, Roles("member")) is False
    assert is_allowed(Action.TEAM_READ, Roles("member", team="member")) is True
    assert is_allowed(Action.TEAM_MEMBERS_MANAGE, Roles("member", team="manager")) is True
    assert is_allowed(Action.TEAM_MEMBERS_MANAGE, Roles("member", team="member")) is False
    assert is_allowed(Action.PROJECT_TEAMS_READ, Roles("guest", project="viewer")) is True
    assert is_allowed(Action.PROJECT_TEAMS_MANAGE, Roles("member", project="owner")) is True
    assert is_allowed(Action.PROJECT_TEAMS_MANAGE, Roles("member", project="editor")) is False


@pytest.mark.parametrize(
    ("role", "read", "configure", "can_request"),
    [
        ("view", True, False, False),
        ("publish", True, False, True),
        ("edit", True, True, True),
        ("manage", True, True, True),
    ],
)
def test_rendering_separates_free_reads_from_cost_incurring_requests(
    role: str, read: bool, configure: bool, can_request: bool
) -> None:
    roles = Roles("member", resource=role)  # type: ignore[arg-type]
    assert is_allowed(Action.RENDER_READ, roles) is read
    assert is_allowed(Action.RENDER_CONFIGURE, roles) is configure
    assert is_allowed(Action.RENDER_REQUEST, roles) is can_request

    viewer = Roles("member", project="viewer")
    assert is_allowed(Action.RENDER_READ, viewer) is True
    assert is_allowed(Action.RENDER_REQUEST, viewer) is False
