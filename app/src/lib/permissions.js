const roleRank = new Map([
  ["viewer", 1],
  ["auditor", 1],
  ["editor", 2],
  ["manager", 3],
  ["admin", 4],
  ["owner", 5]
]);

export function effectiveRole({session, permissions, workspaceId, tenantId}) {
  const roles = permissions
    .filter((permission) => appliesToSession(permission, session))
    .filter((permission) => inScope(permission, {workspaceId, tenantId}))
    .map((permission) => permission.role);

  return roles.sort((a, b) => (roleRank.get(b) ?? 0) - (roleRank.get(a) ?? 0))[0] ?? null;
}

export function canRead(role) {
  return roleRank.has(role);
}

export function canEdit(role) {
  return (roleRank.get(role) ?? 0) >= roleRank.get("editor");
}

export function visibleWorkspaces({session, workspaces, permissions}) {
  return workspaces.filter((workspace) =>
    canRead(effectiveRole({session, permissions, workspaceId: workspace.workspaceId, tenantId: workspace.tenantId}))
  );
}

function appliesToSession(permission, session) {
  if (permission.principalType === "public") return true;
  if (permission.principalType === "user") return permission.principalId === session.userId;
  return permission.principalType === "team";
}

function inScope(permission, {workspaceId, tenantId}) {
  if (permission.scopeType === "tenant") return permission.scopeId === tenantId;
  if (permission.scopeType === "workspace") return permission.scopeId === workspaceId;
  return false;
}
