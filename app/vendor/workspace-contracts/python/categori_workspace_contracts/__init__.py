"""Native, provider-neutral identity/collaboration contracts; no SDK or Node runtime."""
from .identity import (
    identity_schema_version, collaboration_actions, collaboration_role_actions,
    validate_external_identity_link, validate_identity_user, validate_identity_workspace,
    validate_workspace_participation, external_identity_key, resolve_identity_user,
    validate_collaboration_resource, validate_resource_grant, resolve_resource_access,
    resolve_scoped_resource_access, authorize_scoped_resource, authorize_resource,
    normalize_collaboration_actions, actions_for_collaboration_role,
    create_external_identity_link, create_identity_user, create_identity_workspace,
    create_workspace_participation, assert_collaboration_resource, assert_resource_grant,
)

__version__ = "0.1.0-alpha.9"
