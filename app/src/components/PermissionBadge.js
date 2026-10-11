export function PermissionBadge(role) {
  const badge = document.createElement("span");
  badge.className = `badge ${role ?? "none"}`;
  badge.textContent = role ?? "no access";
  return badge;
}
