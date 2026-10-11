export function workspaceOptions(workspaces) {
  return workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.title
  }));
}
