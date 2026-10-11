export function projectForWorkspace(projects, workspaceId) {
  return projects.find((project) => project.workspaceId === workspaceId) ?? null;
}

export function layersForProject(layers, project) {
  if (!project) return [];
  const layerById = new Map(layers.map((layer) => [layer.layerId, layer]));
  return project.layers
    .map((layerId) => layerById.get(layerId))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function spatialWorkbenchLayers(layers) {
  return layers.filter((layer) => layer.geometryType);
}

export function layerSummary(layers) {
  return [
    {label: "layers", value: layers.length},
    {label: "spatial layers", value: spatialWorkbenchLayers(layers).length},
    {label: "visible layers", value: layers.filter((layer) => layer.visible).length}
  ];
}
